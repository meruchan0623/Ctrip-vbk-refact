//! Bridge to the per-account official-page webviews: adapter_* commands from the remote page, display cache, host→page requests, and the UI-facing IM / notice / order / agent-status / net commands that forward to the page.
//!
//! Owner: host-adapter (plan D3/D4/D5, M3).
//!
//! * Page → host: `adapter_*` commands, only from `acct-*` webviews. The
//!   calling webview label is mapped to its account by `login`; an account
//!   claimed by the page is never trusted and a mismatch is rejected.
//! * Host → page: `adapter://request` emitted to that one webview, answered
//!   with `adapter_reply`. Reads time out after 15 s, writes after 20 s; a
//!   timed-out send is `unknown` and is never resent.
//! * Display data (titles, previews, bodies) lives only in the in-memory
//!   [`display::DisplayCache`]; it is never persisted and never logged.
//!
//! Lock order: `HostState` cores first, then this module's mutexes; no lock
//! is held across `login::*` calls, emits or awaits.

#[path = "display.rs"]
pub mod display;
#[path = "outbound_journal.rs"]
pub mod outbound_journal;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use contracts::{codes, AccountContext, AppError};
use core_im::feature_rules::{validate_feature_fact, FeatureFactRateLimiter};
use core_im::RoundState;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Emitter, Manager, State, Webview};
use tokio::sync::oneshot;

use crate::commands::IngestReportDto;
use crate::dto::{
    AccountContextDto, AdapterFactDto, AdapterFactEnvelopeDto, AppErrorDto, FeatureFactDto,
    FeatureFactEventDto, SendDispositionDto,
};
use crate::events;
use crate::login;
use crate::media_outbound::{self, MediaSendResult, MediaTarget};
use crate::peripheral_journal;
use crate::state::HostState;

use display::{
    AgentStatusDto, DisplayCache, DisplayConversationDto, DisplayDelta, DisplayPayload,
    PinnedTable, UiAgentStatusDto, UiConversationDto, UiMessageDto, UiMessageEventDto,
    UiMessagePageDto, UiNetStatusDto, UiNoticeCategoryDto,
};

#[path = "message_actions.rs"]
pub mod message_actions;

type CmdResult<T> = Result<T, AppErrorDto>;

/// `ADAPTER_READ_TIMEOUT_MS` (adapterProtocol.ts).
pub const READ_TIMEOUT: Duration = Duration::from_millis(15_000);
/// `ADAPTER_WRITE_TIMEOUT_MS` (adapterProtocol.ts).
pub const WRITE_TIMEOUT: Duration = Duration::from_millis(20_000);

const BOOT_SCRIPT_ASSET: &str = "adapter/boot.js";
const TONE_SILENCER_ASSET: &str = "adapter/silence-tones.js";
const PINNED_FILE: &str = "pinned.json";

fn guard(state: &HostState, label: &str, command: &str) -> CmdResult<()> {
    state.authorize(label, command).map_err(AppErrorDto::from)
}

fn not_ready(message: impl Into<String>) -> AppError {
    AppError::new(codes::ADAPTER_NOT_READY, message).retryable()
}

fn unauthorized(message: impl Into<String>) -> AppError {
    AppError::new(codes::HOST_VIEW_UNAUTHORIZED, message)
}

fn bad_reply() -> AppError {
    AppError::new(codes::ADAPTER_FAILED, "page reply has an unexpected shape")
}

fn e2dto(e: AppError) -> AppErrorDto {
    e.into()
}

fn dto2e(d: AppErrorDto) -> AppError {
    AppError {
        code: d.code,
        message: d.message,
        retryable: d.retryable,
        detail: d.detail,
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    match m.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    }
}

/// Parses the invoke payload. The page (`web-adapter/boot.ts::hostArgs`)
/// wraps protocol objects in a named argument, `{envelope}` for
/// `adapter_push_fact` (same as `im_push_fact`) and `{payload}` for the
/// others; an unwrapped object is still accepted. Serde messages are returned
/// to the caller only, never logged.
fn body<T: DeserializeOwned>(req: &Request<'_>, key: &str) -> Result<T, AppError> {
    let value: Result<Value, serde_json::Error> = match req.body() {
        InvokeBody::Json(v) => Ok(v.clone()),
        InvokeBody::Raw(b) => serde_json::from_slice(b),
    };
    value
        .and_then(|v| serde_json::from_value(unwrap_arg(v, key)))
        .map_err(|e| AppError::new("adapter.invalid_payload", e.to_string()))
}

/// `{<key>: X}` (exactly one field) → `X`; anything else is returned as is.
fn unwrap_arg(v: Value, key: &str) -> Value {
    match v {
        Value::Object(mut map) if map.len() == 1 && map.contains_key(key) => {
            map.remove(key).unwrap_or(Value::Null)
        }
        other => other,
    }
}

// ------------------------------------------------------------------ pending

struct PendingEntry {
    account: AccountContext,
    tx: oneshot::Sender<Result<Value, AppError>>,
}

/// Host → page requests awaiting `adapter_reply`, keyed by `req_id`.
#[derive(Default)]
pub struct PendingTable {
    map: HashMap<String, PendingEntry>,
}

impl std::fmt::Debug for PendingTable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PendingTable")
            .field("len", &self.map.len())
            .finish()
    }
}

impl PendingTable {
    pub fn insert(
        &mut self,
        account: AccountContext,
    ) -> (String, oneshot::Receiver<Result<Value, AppError>>) {
        let req_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.map
            .insert(req_id.clone(), PendingEntry { account, tx });
        (req_id, rx)
    }

    /// Completes `req_id` if `caller` is exactly the account the request
    /// was sent to (same identity and generation).
    pub fn complete(
        &mut self,
        caller: &AccountContext,
        req_id: &str,
        result: Result<Value, AppError>,
    ) -> Result<(), AppError> {
        match self.map.get(req_id) {
            None => Err(AppError::new(
                "adapter.unknown_request",
                "no pending request with this id",
            )),
            Some(e) if &e.account != caller => Err(unauthorized(
                "reply from a webview the request was not sent to",
            )),
            Some(_) => {
                if let Some(e) = self.map.remove(req_id) {
                    // The waiter may have timed out already; nothing to do then.
                    let _ = e.tx.send(result);
                }
                Ok(())
            }
        }
    }

    pub fn cancel(&mut self, req_id: &str) {
        self.map.remove(req_id);
    }

    /// Cancels requests of this identity at or below its generation. Host
    /// teardown cannot assert that an already-emitted page write was rejected.
    pub fn fail_account(&mut self, ctx: &AccountContext) {
        let ids: Vec<String> = self
            .map
            .iter()
            .filter(|(_, e)| {
                e.account.persistent_key() == ctx.persistent_key()
                    && e.account.session_generation <= ctx.session_generation
            })
            .map(|(k, _)| k.clone())
            .collect();
        for id in ids {
            // Dropping the sender selects await_reply's transport-loss branch
            // (emitted=true/from_page=false), preserving Unknown and its journal
            // fence. Only PendingTable::complete carries an actual page answer.
            self.map.remove(&id);
        }
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}

/// Why a request failed, and whether the page may have acted on it.
#[derive(Debug)]
pub struct RequestFailure {
    pub error: AppError,
    /// The request reached the page (an emitted write may have happened).
    pub emitted: bool,
    /// The page itself answered with `ok: false`.
    pub from_page: bool,
}

impl RequestFailure {
    fn before_emit(error: AppError) -> Self {
        Self {
            error,
            emitted: false,
            from_page: false,
        }
    }
}

/// Awaits one reply. Timeout → `adapter.timeout`; dropped sender →
/// `adapter.not_ready`.
pub async fn await_reply(
    rx: oneshot::Receiver<Result<Value, AppError>>,
    timeout: Duration,
) -> Result<Value, RequestFailure> {
    match tokio::time::timeout(timeout, rx).await {
        Err(_) => Err(RequestFailure {
            error: AppError::new(codes::ADAPTER_TIMEOUT, "page did not answer in time").retryable(),
            emitted: true,
            from_page: false,
        }),
        Ok(Err(_)) => Err(RequestFailure {
            error: not_ready("request was cancelled"),
            emitted: true,
            from_page: false,
        }),
        Ok(Ok(Ok(v))) => Ok(v),
        Ok(Ok(Err(error))) => Err(RequestFailure {
            error,
            emitted: true,
            from_page: true,
        }),
    }
}

/// Outcome of `im.send_text`. Only an explicit page answer is confirmed or
/// rejected; anything ambiguous after the request reached the page is
/// `unknown` (never resent).
pub fn send_outcome(result: Result<Value, RequestFailure>) -> Result<SendDispositionDto, AppError> {
    match result {
        Ok(v) => Ok(serde_json::from_value(v).unwrap_or(SendDispositionDto::Unknown)),
        Err(f) if !f.emitted => Err(f.error),
        Err(f)
            if f.from_page
                && [
                    codes::ADAPTER_NOT_READY,
                    codes::IM_PERMISSION_DENIED,
                    codes::NET_PAYLOAD_TOO_LARGE,
                ]
                .contains(&f.error.code.as_str()) =>
        {
            Ok(SendDispositionDto::Rejected {
                code: f.error.code,
                reason: f.error.message,
            })
        }
        Err(_) => Ok(SendDispositionDto::Unknown),
    }
}

// ------------------------------------------------------------------ module state

#[derive(Debug)]
pub struct AdapterState {
    display: Mutex<DisplayCache>,
    pending: Mutex<PendingTable>,
    pinned: Mutex<PinnedTable>,
    outbound: Option<Mutex<outbound_journal::OutboundJournal>>,
    peripheral: Option<Mutex<peripheral_journal::PeripheralJournal>>,
    epoch: AtomicU64,
    /// Account the main shell last addressed (proxy for the active account).
    focus: Mutex<Option<AccountContext>>,
    receive: Mutex<HostReceiveBook>,
    /// `feature://fact` admission per (account, gid, kind); see `forward_feature_fact`.
    feature_rate: Mutex<FeatureFactRateLimiter>,
    /// Feature facts refused by validation (count only; the payload is never logged).
    feature_rejected: AtomicU64,
}

impl AdapterState {
    fn new(pinned: PinnedTable) -> Self {
        Self {
            display: Mutex::new(DisplayCache::new()),
            pending: Mutex::new(PendingTable::default()),
            pinned: Mutex::new(pinned),
            outbound: None,
            peripheral: None,
            epoch: AtomicU64::new(0),
            focus: Mutex::new(None),
            receive: Mutex::new(HostReceiveBook::default()),
            feature_rate: Mutex::new(FeatureFactRateLimiter::new()),
            feature_rejected: AtomicU64::new(0),
        }
    }
}

/// Validated page feature fact → main window (`feature://fact`). The fact
/// never enters the IM core and is never persisted; `IngestReport` fields
/// therefore read `applied: false` with `dropped` naming the outcome
/// (`ForwardedToMain` or `FeatureRateLimited`). Validation failures are
/// `adapter.invalid_payload`, counted on `feature_rejected`; the fact body
/// is not logged.
fn forward_feature_fact(
    app: &AppHandle,
    m: &AdapterState,
    ctx: &AccountContext,
    now_ms: i64,
    fact: FeatureFactDto,
) -> Result<IngestReportDto, AppError> {
    let fact = validate_feature_fact(fact.into(), now_ms).inspect_err(|e| {
        m.feature_rejected.fetch_add(1, Ordering::Relaxed);
        log::warn!("feature fact rejected: {}", e.code);
    })?;
    let account_key = format!(
        "{}|{}|{}",
        ctx.environment.as_str(),
        ctx.account_id.as_str(),
        ctx.session_generation
    );
    let admitted = lock(&m.feature_rate).admit(&account_key, fact.gid(), fact.kind(), now_ms);
    if !admitted {
        return Ok(IngestReportDto {
            applied: false,
            dropped: Some("FeatureRateLimited".to_string()),
            needs_resync: None,
            auth_invalid: false,
        });
    }
    events::to_main(
        app,
        events::FEATURE_FACT,
        FeatureFactEventDto {
            fact: fact.into(),
            account: AccountContextDto::from(ctx),
        },
    );
    Ok(IngestReportDto {
        applied: false,
        dropped: Some("ForwardedToMain".to_string()),
        needs_resync: None,
        auth_invalid: false,
    })
}

#[derive(Default)]
struct HostReceiveBook {
    scopes: HashMap<(String, String, u64), display::HostReceiveDiagnosticsDto>,
}
impl std::fmt::Debug for HostReceiveBook {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostReceiveBook")
            .field("scopes", &self.scopes.len())
            .finish()
    }
}
impl std::fmt::Debug for display::HostReceiveDiagnosticsDto {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostReceiveDiagnostics")
            .finish_non_exhaustive()
    }
}
impl HostReceiveBook {
    fn key(ctx: &AccountContext) -> (String, String, u64) {
        (
            ctx.environment.as_str().into(),
            ctx.account_id.as_str().into(),
            ctx.session_generation,
        )
    }
    fn snapshot(&self, ctx: &AccountContext) -> display::HostReceiveDiagnosticsDto {
        self.scopes
            .get(&Self::key(ctx))
            .cloned()
            .unwrap_or_default()
    }
    fn note(
        &mut self,
        ctx: &AccountContext,
        update: impl FnOnce(&mut display::HostReceiveDiagnosticsDto),
    ) {
        let key = Self::key(ctx);
        if !self.scopes.contains_key(&key) && self.scopes.len() >= 256 {
            if let Some(old) = self.scopes.keys().next().cloned() {
                self.scopes.remove(&old);
            }
        }
        update(self.scopes.entry(key).or_default());
    }
}
fn diagnostic_count(value: u64, amount: usize) -> u64 {
    value
        .saturating_add(amount as u64)
        .min(9_007_199_254_740_991)
}

fn apply_display_diagnosed(
    m: &AdapterState,
    ctx: &AccountContext,
    payload: Result<DisplayPayload, AppError>,
) -> Result<DisplayDelta, AppError> {
    lock(&m.receive).note(ctx, |c| {
        c.display_entered = diagnostic_count(c.display_entered, 1)
    });
    let payload = payload.inspect_err(|_| {
        lock(&m.receive).note(ctx, |c| {
            c.display_decode_rejected = diagnostic_count(c.display_decode_rejected, 1)
        });
    })?;
    if let DisplayPayload::Messages { items, .. } = &payload {
        lock(&m.receive).note(ctx, |c| {
            c.message_items = diagnostic_count(c.message_items, items.len())
        });
    }
    let delta = lock(&m.display).apply(ctx, payload).inspect_err(|_| {
        lock(&m.receive).note(ctx, |c| {
            c.display_apply_rejected = diagnostic_count(c.display_apply_rejected, 1)
        });
    })?;
    if let DisplayDelta::Messages { changed, .. } = &delta {
        lock(&m.receive).note(ctx, |c| {
            c.changed_messages = diagnostic_count(c.changed_messages, changed.len())
        });
    }
    Ok(delta)
}

/// Called once from `lib.rs` setup. Register module state with `app.manage(..)` here.
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let pinned = match app.path().app_data_dir() {
        Ok(dir) => PinnedTable::load(dir.join(PINNED_FILE)),
        Err(e) => {
            log::warn!("pinned table not persisted: {e}");
            PinnedTable::default()
        }
    };
    let mut adapter = AdapterState::new(pinned);
    adapter.outbound = app
        .path()
        .app_data_dir()
        .ok()
        .and_then(|root| {
            outbound_journal::OutboundJournal::open(root.join("state").join("outbound")).ok()
        })
        .map(Mutex::new);
    adapter.peripheral = app
        .path()
        .app_data_dir()
        .ok()
        .and_then(|root| {
            peripheral_journal::PeripheralJournal::open(root.join("state").join("peripheral")).ok()
        })
        .map(Mutex::new);
    app.manage(adapter);
    Ok(())
}

fn module(app: &AppHandle) -> Result<State<'_, AdapterState>, AppError> {
    app.try_state::<AdapterState>()
        .ok_or_else(|| not_ready("adapter module not initialised"))
}

/// Resolve a message from the host-owned display cache, never from a caller-supplied body/URL.
/// Native message actions re-read this snapshot after awaits before touching the clipboard/disk.
pub(crate) fn cached_message(
    app: &AppHandle,
    ctx: &AccountContext,
    gid: &str,
    message_id: &str,
) -> Result<(UiMessageDto, Option<String>), AppError> {
    if gid.is_empty() || message_id.is_empty() {
        return Err(AppError::new("im.invalid_message", "消息标识缺失"));
    }
    let m = module(app)?;
    if login::active_context(app).as_ref() != Some(ctx) {
        return Err(AppError::new(
            "account.stale_generation",
            "当前账号已切换，请重新选择消息",
        ));
    }
    let cache = lock(&m.display);
    let conversation = cache
        .conversation(ctx, gid)?
        .ok_or_else(|| AppError::new("im.invalid_message", "会话已变化，请重新选择消息"))?;
    let messages = cache.messages(ctx, gid)?.unwrap_or_default();
    let mut matches = messages
        .iter()
        .filter(|message| message.gid == gid && message.message_id.as_deref() == Some(message_id));
    let message = matches
        .next()
        .ok_or_else(|| AppError::new("im.invalid_message", "消息已移除，请重新选择"))?;
    if matches.next().is_some()
        || message.kind == "system"
        || message.recalled_message_id.is_some()
        || messages
            .iter()
            .any(|row| row.gid == gid && row.recalled_message_id.as_deref() == Some(message_id))
    {
        return Err(AppError::new(
            "im.invalid_message",
            "消息已撤回或标识不可用",
        ));
    }
    Ok((message.clone(), conversation.assistant_context_revision))
}

/// The displayed thread of the active account, for host-side sequences such as the image viewer.
pub(crate) fn cached_thread(
    app: &AppHandle,
    ctx: &AccountContext,
    gid: &str,
) -> Result<Vec<UiMessageDto>, AppError> {
    let m = module(app)?;
    if login::active_context(app).as_ref() != Some(ctx) {
        return Err(AppError::new(
            "account.stale_generation",
            "当前账号已切换，请重新选择消息",
        ));
    }
    let cache = lock(&m.display);
    Ok(cache
        .messages(ctx, gid)?
        .unwrap_or_default()
        .into_iter()
        .filter(|message| message.gid == gid)
        .collect())
}

/// Local draft/media storage uses the existing outbound store and writer lock.
/// Callers must authorize the local view and account before entering this helper.
pub(crate) fn with_outbound<T>(
    app: &AppHandle,
    account: &AccountContext,
    operation: impl FnOnce(&outbound_journal::OutboundJournal) -> Result<T, AppError>,
) -> Result<T, AppError> {
    let state = module(app)?;
    let journal = state.outbound.as_ref().ok_or_else(|| {
        AppError::new(
            "im.journal_unavailable",
            "durable attachment storage unavailable",
        )
    })?;
    outbound_journal::with_authorized(
        journal,
        || app.state::<HostState>().lock().accounts.validate(account),
        operation,
    )
}

/// Lifecycle callers hold LoginState.lifecycle before entering here. The
/// journal mutex spans registry transition and disk marker, but Cores is held
/// only inside the transition's short in-memory sections. Absence of storage
/// must never prevent revoking an account; the callback reports the IO failure.
pub(crate) fn with_outbound_transition<T>(
    app: &AppHandle,
    operation: impl FnOnce(Option<&outbound_journal::OutboundJournal>) -> T,
) -> T {
    let state = app.try_state::<AdapterState>();
    outbound_journal::with_transition(state.as_ref().and_then(|s| s.outbound.as_ref()), operation)
}

/// Revocation may outlive its login generation. This accepts only the actual
/// host-owned handle removed from the table, and cannot delete referenced data.
pub(crate) fn release_unused_attachment(
    app: &AppHandle,
    frozen: &media_outbound::FrozenAttachment,
) -> Result<(), AppError> {
    let Some(lease) = frozen.dto.lease_id.as_deref() else {
        return Ok(());
    };
    let state = module(app)?;
    let journal = state
        .outbound
        .as_ref()
        .ok_or_else(|| not_ready("attachment store unavailable"))?;
    let guard = lock(journal);
    let account: AccountContext = frozen.dto.owner.account.clone().into();
    guard.release_attachment(&account, &frozen.dto.owner.gid, lease)
}

// ------------------------------------------------------------------ helpers

/// Account bound to the calling `acct-*` webview, if any.
fn caller(
    app: &AppHandle,
    state: &HostState,
    webview: &Webview,
    command: &str,
) -> CmdResult<Option<AccountContext>> {
    guard(state, webview.label(), command)?;
    Ok(login::account_for_webview(app, webview.label()))
}

/// Like [`caller`] but requires a bound, current account.
fn bound_caller(
    app: &AppHandle,
    state: &HostState,
    webview: &Webview,
    command: &str,
) -> CmdResult<AccountContext> {
    let ctx = caller(app, state, webview, command)?
        .ok_or_else(|| e2dto(not_ready("no account is bound to this webview yet")))?;
    state.lock().accounts.validate(&ctx).map_err(e2dto)?;
    Ok(ctx)
}

/// Validates a UI-supplied read scope without recording or restoring UI focus.
fn read_account(state: &HostState, account: AccountContextDto) -> CmdResult<AccountContext> {
    let ctx: AccountContext = account.into();
    state.lock().accounts.validate(&ctx).map_err(e2dto)?;
    Ok(ctx)
}

/// Validates a UI-supplied `{account}` and records it as the focus.
fn ui_account(
    app: &AppHandle,
    state: &HostState,
    account: AccountContextDto,
) -> CmdResult<AccountContext> {
    let ctx: AccountContext = account.into();
    state.lock().accounts.validate(&ctx).map_err(e2dto)?;
    if let Ok(m) = module(app) {
        *lock(&m.focus) = Some(ctx.clone());
    }
    Ok(ctx)
}

/// `(waiting_since_ms, waiting_confirmed)` from core-im's round for `gid`.
fn waiting_of(core: Option<&core_im::ImCore>, gid: &str) -> (Option<i64>, bool) {
    match core.map(|c| c.round_state(gid)) {
        Some(RoundState::Waiting(r)) => (
            r.start_time_ms,
            r.start_confirmed && r.start_time_ms.is_some(),
        ),
        Some(RoundState::PendingVerification(r)) => (r.start_time_ms, false),
        _ => (None, false),
    }
}

/// Builds `UiConversation`s: display row + account + round + pinned.
fn to_ui(
    app: &AppHandle,
    ctx: &AccountContext,
    rows: Vec<DisplayConversationDto>,
) -> Vec<UiConversationDto> {
    let waiting: Vec<(Option<i64>, bool)> = {
        let host = app.state::<HostState>();
        let cores = host.lock();
        let core = cores.im.get(ctx);
        rows.iter().map(|r| waiting_of(core, &r.fact.gid)).collect()
    };
    let Ok(m) = module(app) else {
        return Vec::new();
    };
    let pinned = lock(&m.pinned);
    let account = AccountContextDto::from(ctx);
    rows.into_iter()
        .zip(waiting)
        .map(
            |(display, (waiting_since_ms, waiting_confirmed))| UiConversationDto {
                is_top: pinned.is_top(ctx, &display.fact.gid),
                display,
                account: account.clone(),
                draft: String::new(),
                waiting_since_ms,
                waiting_confirmed,
            },
        )
        .collect()
}

/// Emits `im://conversation-changed` for the cached rows of `gids`.
fn emit_conversations(app: &AppHandle, ctx: &AccountContext, gids: &[String]) {
    if gids.is_empty() {
        return;
    }
    let Ok(m) = module(app) else {
        return;
    };
    let rows: Vec<DisplayConversationDto> = {
        let cache = lock(&m.display);
        gids.iter()
            .filter_map(|g| cache.conversation(ctx, g).ok().flatten())
            .collect()
    };
    for conv in to_ui(app, ctx, rows) {
        crate::assistant::order_commands::on_conversation_change(
            app,
            ctx,
            &conv.display.fact.gid,
            conv.display.assistant_context_revision.as_deref(),
        );
        events::to_main(app, events::IM_CONVERSATION_CHANGED, conv);
    }
}

fn sync_unread(app: &AppHandle, ctx: &AccountContext) {
    let Ok(m) = module(app) else {
        return;
    };
    let total = lock(&m.display).total_unread(ctx);
    login::set_unread(app, ctx, total);
}

/// Payload with the owning account attached (events that carry no account
/// in their UI shape still need it to be filtered per account).
#[derive(Clone, Serialize)]
struct Scoped<T: Serialize> {
    #[serde(flatten)]
    inner: T,
    account: AccountContextDto,
}

fn is_focus(app: &AppHandle, ctx: &AccountContext) -> bool {
    module(app)
        .map(|m| {
            lock(&m.focus)
                .as_ref()
                .map_or(true, |f| f.persistent_key() == ctx.persistent_key())
        })
        .unwrap_or(true)
}

fn apply_agent_status(
    app: &AppHandle,
    ctx: &AccountContext,
    payload: DisplayPayload,
) -> Result<(), AppError> {
    let state = app.state::<HostState>();
    let mut cores = state.lock();
    cores.accounts.validate(ctx)?;
    let m = module(app)?;
    // Apply cursor, gate and publication under the same host lock. An older
    // already-decoded push must not emit after a newer push or watchdog expiry.
    let DisplayDelta::AgentStatus(s) = apply_display_diagnosed(&m, ctx, Ok(payload))? else {
        return Err(bad_reply());
    };
    let now = state.now(&mut cores);
    if !cores.set_account_notifications(ctx, s.allows_notifications(), &now) {
        return Ok(());
    }
    // Keep cache, gate and UI publication in host→display lock order. A
    // concurrent lease expiry cannot overwrite a newer observed status.
    emit_agent_status_event(app, ctx, s);
    Ok(())
}

fn emit_agent_status_event(app: &AppHandle, ctx: &AccountContext, s: UiAgentStatusDto) {
    events::to_main(
        app,
        events::AGENT_STATUS,
        Scoped {
            inner: s,
            account: ctx.into(),
        },
    );
}

/// Host watchdog runs even when the adapter page is frozen. Expiry changes
/// certainty only; it neither changes work status nor renews its own lease.
/// Alarm snapshot for local windows: each round gets its conversation's list
/// preview from the display cache, so `core-notify` never holds customer text.
pub fn alarm_snapshot(app: &AppHandle) -> crate::dto::AlarmSnapshotDto {
    let snapshot = app.state::<HostState>().alarm_snapshot();
    let mut dto = crate::dto::AlarmSnapshotDto::from(&snapshot);
    let Ok(m) = module(app) else {
        return dto;
    };
    let cache = lock(&m.display);
    for (entry, row) in snapshot.entries.iter().zip(&mut dto.entries) {
        row.preview = cache
            .conversation(&entry.account, &entry.gid)
            .ok()
            .flatten()
            .and_then(|c| crate::dto::alarm_preview(&c.preview));
    }
    dto
}

/// Cached list row for a notice card. Customer text: never logged.
pub fn display_conversation(
    app: &AppHandle,
    account: &AccountContext,
    gid: &str,
) -> Option<DisplayConversationDto> {
    let m = module(app).ok()?;
    let cache = lock(&m.display);
    cache.conversation(account, gid).ok().flatten()
}

pub fn expire_agent_statuses(app: &AppHandle) {
    let state = app.state::<HostState>();
    let mut cores = state.lock();
    let now = state.now(&mut cores);
    let expired = cores.notify.take_expired_account_statuses(&now);
    let Ok(m) = module(app) else {
        return;
    };
    let mut display = lock(&m.display);
    for ctx in expired {
        if cores.accounts.validate(&ctx).is_err() {
            continue;
        }
        let Some(mut status) = display.agent_status(&ctx) else {
            continue;
        };
        if !status.confirmed {
            continue;
        }
        status.confirmed = false;
        if display.set_agent_status(&ctx, status).is_ok() {
            emit_agent_status_event(app, &ctx, status);
        }
    }
}

// ------------------------------------------------------------------ request

async fn request_inner(
    app: &AppHandle,
    account: &AccountContext,
    op: &str,
    args: Value,
    timeout: Duration,
) -> Result<Value, RequestFailure> {
    let m = module(app).map_err(RequestFailure::before_emit)?;
    app.state::<HostState>()
        .lock()
        .accounts
        .validate(account)
        .map_err(RequestFailure::before_emit)?;
    let label = login::account_webview_label(app, account).ok_or_else(|| {
        RequestFailure::before_emit(not_ready("the account's official page is not open"))
    })?;
    if login::account_for_webview(app, &label).as_ref() != Some(account) {
        return Err(RequestFailure::before_emit(not_ready(
            "the account's official page has not published this identity yet",
        )));
    }
    dispatch_pending(&m.pending, account, op, args, timeout, |msg| {
        app.emit_to(label.as_str(), events::ADAPTER_REQUEST, msg)
            .is_ok()
    })
    .await
}

/// Shared production boundary for registering, emitting and awaiting a page
/// request. The emitter reports delivery admission, never upstream acceptance.
async fn dispatch_pending(
    pending: &Mutex<PendingTable>,
    account: &AccountContext,
    op: &str,
    args: Value,
    timeout: Duration,
    emit: impl FnOnce(Value) -> bool,
) -> Result<Value, RequestFailure> {
    let (req_id, rx) = lock(pending).insert(account.clone());
    let msg = serde_json::json!({ "req_id": req_id, "op": op, "args": args });
    if !emit(msg) {
        lock(pending).cancel(&req_id);
        return Err(RequestFailure::before_emit(not_ready(
            "could not reach the official page",
        )));
    }
    let result = await_reply(rx, timeout).await;
    if result.is_err() {
        lock(pending).cancel(&req_id);
    }
    result
}

async fn forward<T: DeserializeOwned>(
    app: &AppHandle,
    ctx: &AccountContext,
    op: &str,
    args: Value,
    timeout: Duration,
) -> Result<T, AppError> {
    let v = request(app, ctx, op, args, timeout).await?;
    serde_json::from_value(v).map_err(|_| bad_reply())
}

#[derive(Deserialize)]
struct AssistantScopeReply {
    context_revision: String,
    order_id: Option<String>,
}

/// Validate both the host projection and the current full in-page service/customer identity.
pub async fn validate_assistant_scope(
    app: &AppHandle,
    account: &AccountContext,
    gid: &str,
    order_id: &str,
    revision: &str,
) -> Result<(), AppError> {
    core_assistant::order::validate_order_id(order_id)?;
    if uuid::Uuid::parse_str(revision).is_err() {
        return Err(bad_reply());
    }
    let local = || -> Result<(), AppError> {
        app.state::<HostState>().lock().accounts.validate(account)?;
        let m = module(app)?;
        let row = lock(&m.display)
            .conversation(account, gid)?
            .ok_or_else(|| not_ready("order conversation is unavailable"))?;
        if row.assistant_context_revision.as_deref() != Some(revision)
            || row.order.as_ref().map(|o| o.order_id.as_str()) != Some(order_id)
        {
            return Err(AppError::new(
                codes::ACCOUNT_STALE_GENERATION,
                "order conversation binding changed",
            ));
        }
        Ok(())
    };
    local()?;
    let reply: AssistantScopeReply = forward(
        app,
        account,
        "assistant.scope",
        serde_json::json!({ "gid": gid, "context_revision": revision }),
        READ_TIMEOUT,
    )
    .await?;
    if reply.context_revision != revision || reply.order_id.as_deref() != Some(order_id) {
        return Err(bad_reply());
    }
    local()
}

pub async fn capture_media_target(
    app: &AppHandle,
    account: &AccountContext,
    gid: &str,
) -> Result<MediaTarget, AppError> {
    let token = uuid::Uuid::new_v4().to_string();
    let target: MediaTarget = forward(
        app,
        account,
        "media.target",
        serde_json::json!({ "gid": gid, "target_token": token }),
        READ_TIMEOUT,
    )
    .await?;
    if target.target_token != token
        || !media_outbound::valid_hash(&target.identity_sha256)
        || target.sender_id.is_empty()
    {
        return Err(bad_reply());
    }
    Ok(target)
}

pub async fn validate_media_target(
    app: &AppHandle,
    account: &AccountContext,
    gid: &str,
    target: &MediaTarget,
) -> Result<(), AppError> {
    let current: MediaTarget = forward(
        app,
        account,
        "media.validate",
        serde_json::json!({ "gid": gid, "target_token": target.target_token }),
        READ_TIMEOUT,
    )
    .await?;
    if current != *target {
        return Err(media_outbound::refused(
            "conversation target changed",
            "当前会话已变化，未发送。请重新选择附件。",
        ));
    }
    Ok(())
}

pub async fn release_media_target(
    app: &AppHandle,
    account: &AccountContext,
    gid: &str,
    target: &MediaTarget,
) {
    let _ = request(
        app,
        account,
        "media.release",
        serde_json::json!({ "gid": gid, "target_token": target.target_token }),
        READ_TIMEOUT,
    )
    .await;
}

struct ReleaseMediaTarget {
    app: AppHandle,
    account: AccountContext,
    gid: String,
    target: MediaTarget,
}
impl Drop for ReleaseMediaTarget {
    fn drop(&mut self) {
        let app = self.app.clone();
        let account = self.account.clone();
        let gid = self.gid.clone();
        let target = self.target.clone();
        tauri::async_runtime::spawn(async move {
            release_media_target(&app, &account, &gid, &target).await;
        });
    }
}

fn media_progress(
    app: &AppHandle,
    account: &AccountContext,
    gid: &str,
    attachment: &str,
    local: &str,
    stage: &str,
) {
    events::to_main(
        app,
        events::MEDIA_SEND_PROGRESS,
        serde_json::json!({ "account": AccountContextDto::from(account), "gid": gid, "attachment_id": attachment, "local_id": local, "stage": stage }),
    );
}

#[derive(Deserialize)]
struct MediaUploadReply {
    kind: String,
    body_json: Option<String>,
    media: Option<Value>,
    error: Option<String>,
}
#[derive(Deserialize)]
struct MediaSendReply {
    disposition: SendDispositionDto,
    message: UiMessageDto,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn im_send_media(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
    gid: String,
    local_id: String,
    attachment_id: String,
) -> CmdResult<MediaSendResult> {
    guard(&state, webview.label(), "im_send_media")?;
    let ctx = read_account(&state, account)?;
    if gid.is_empty() || local_id.is_empty() {
        return Err(e2dto(media_outbound::invalid()));
    }
    let selected = crate::shell::frozen_attachment(&app, &attachment_id, &ctx, &gid);
    let candidate_payload = selected.as_ref().ok().map(|f| f.payload());
    if let Some((stage, started, d, verified)) = with_outbound(&app, &ctx, |journal| {
        journal.replay_media(&ctx, &local_id, &gid, candidate_payload.as_ref())
    })
    .map_err(e2dto)?
    {
        let mut result = MediaSendResult::replay(stage, started, d);
        result.replay_only = !verified;
        return Ok(result);
    }
    // Send barrier (I-04a): a replay of an existing intent is read-only and
    // still answered above; a new one is refused before anything is staged,
    // uploaded or journaled ("not_submitted", code `store.persist_failed`).
    if let Err(barrier) = state.persist_barrier() {
        return Ok(MediaSendResult::blocked(
            "prepare",
            false,
            &format!("{}: {}", barrier.code, barrier.message),
        ));
    }
    let frozen = match selected {
        Ok(frozen) if frozen.validate(&ctx, &gid).is_ok() => frozen,
        _ => {
            return Ok(MediaSendResult::blocked(
                "prepare",
                false,
                "local attachment expired or is not registered; select it again",
            ))
        }
    };
    // Official limits (contract v1) are re-checked here, before anything is
    // staged, uploaded or journaled: a violation is always "nothing submitted".
    if let Err(violation) = media_outbound::check_size(&frozen.dto.kind, frozen.dto.size as u64) {
        return Ok(MediaSendResult::blocked(
            "prepare",
            false,
            &format!("{}: {}", violation.code, violation.message),
        ));
    }
    // Freeze the draft edit revision before any official-page/network await.
    // Later edits of the same lease must not be cleared by this send's receipt.
    let draft_version = with_outbound(&app, &ctx, |journal| {
        journal.capture_media_draft_version(&ctx, &frozen)
    })
    .map_err(e2dto)?;
    if validate_media_target(&app, &ctx, &gid, &frozen.target)
        .await
        .is_err()
    {
        return Ok(MediaSendResult::blocked(
            "prepare",
            false,
            "attachment target changed; select it again",
        ));
    }
    let payload = frozen.payload();
    media_progress(&app, &ctx, &gid, &attachment_id, &local_id, "prepare");
    let transfer = uuid::Uuid::new_v4().to_string();
    let args = serde_json::json!({ "gid": gid, "target_token": frozen.target.target_token, "transfer_id": transfer });
    let mut begin = args.clone();
    begin["kind"] = frozen.dto.kind.clone().into();
    begin["name"] = frozen.dto.name.clone().into();
    begin["mime"] = frozen.dto.mime.clone().into();
    begin["size"] = frozen.dto.size.into();
    begin["sha256"] = frozen.dto.content_sha256.clone().into();
    if request(&app, &ctx, "media.stage_begin", begin, READ_TIMEOUT)
        .await
        .is_err()
    {
        let _ = request(&app, &ctx, "media.discard", args.clone(), READ_TIMEOUT).await;
        return Ok(MediaSendResult::blocked(
            "prepare",
            false,
            "could not stage attachment on its original official page",
        ));
    }
    for (index, chunk) in frozen.bytes.chunks(media_outbound::CHUNK_CAP).enumerate() {
        let mut part = args.clone();
        part["offset"] = (index * media_outbound::CHUNK_CAP).into();
        part["data"] = media_outbound::base64(chunk).into();
        if request(&app, &ctx, "media.stage_chunk", part, READ_TIMEOUT)
            .await
            .is_err()
        {
            let _ = request(&app, &ctx, "media.discard", args.clone(), READ_TIMEOUT).await;
            return Ok(MediaSendResult::blocked(
                "prepare",
                false,
                "local attachment staging did not complete (nothing uploaded)",
            ));
        }
    }
    let new = with_outbound(&app, &ctx, |journal| {
        journal.reserve_media_attachment_captured(&ctx, &local_id, &frozen, draft_version)
    })
    .map_err(e2dto)?;
    if !new {
        let _ = request(&app, &ctx, "media.discard", args.clone(), READ_TIMEOUT).await;
        let (stage, started, d) =
            with_outbound(&app, &ctx, |journal| journal.media_status(&ctx, &local_id))
                .map_err(e2dto)?;
        return Ok(MediaSendResult::replay(stage, started, d));
    }
    crate::shell::consume_attachment(&app, &attachment_id, &ctx, &gid);
    let _release = ReleaseMediaTarget {
        app: app.clone(),
        account: ctx.clone(),
        gid: gid.clone(),
        target: frozen.target.clone(),
    };
    media_progress(&app, &ctx, &gid, &attachment_id, &local_id, "upload");
    let uploaded: MediaUploadReply = match forward(
        &app,
        &ctx,
        "media.upload",
        args.clone(),
        Duration::from_secs(270),
    )
    .await
    {
        Ok(reply) => reply,
        Err(_) => {
            return Ok(MediaSendResult::blocked(
                "upload",
                true,
                "upload response is unknown; do not upload this intent again",
            ))
        }
    };
    if uploaded.kind != "uploaded" {
        if uploaded.kind == "rejected" || uploaded.kind == "not_submitted" {
            let disposition = SendDispositionDto::Rejected {
                code: "media.upload_rejected".into(),
                reason: "media upload was rejected or failed local validation".into(),
            };
            if with_outbound(&app, &ctx, |journal| {
                journal.finish_media(&ctx, &local_id, &payload, disposition.clone())
            })
            .is_err()
            {
                return Ok(MediaSendResult::blocked(
                    "upload",
                    true,
                    "could not persist upload failure; do not retry",
                ));
            }
            let mut result = MediaSendResult::replay("upload".into(), false, disposition);
            if uploaded.kind == "not_submitted" {
                result.kind = "not_submitted".into();
                result.disposition = None;
            }
            result.error = Some(
                uploaded
                    .error
                    .unwrap_or_else(|| "media upload rejected".into()),
            );
            return Ok(result);
        }
        return Ok(MediaSendResult::blocked(
            "upload",
            true,
            uploaded
                .error
                .as_deref()
                .unwrap_or("upload outcome unknown; do not retry"),
        ));
    }
    let body = match uploaded.body_json.filter(|body| {
        body.len() <= 16384
            && media_outbound::validate_body(
                body,
                &frozen.dto.kind,
                &frozen.dto.name,
                frozen.dto.size,
            )
    }) {
        Some(body) if uploaded.media.is_some() => body,
        _ => {
            return Ok(MediaSendResult::blocked(
                "upload",
                true,
                "upload response did not match the media contract; do not retry",
            ))
        }
    };
    if with_outbound(&app, &ctx, |journal| {
        journal.advance_media(&ctx, &local_id, &payload, &body, false)
    })
    .is_err()
    {
        return Ok(MediaSendResult::blocked(
            "upload",
            true,
            "uploaded resource could not be durably recorded; do not retry",
        ));
    }
    if validate_media_target(&app, &ctx, &gid, &frozen.target)
        .await
        .is_err()
    {
        return Ok(MediaSendResult::blocked(
            "upload",
            true,
            "target changed after upload; no SDK submission was admitted",
        ));
    }
    if with_outbound(&app, &ctx, |journal| {
        journal.advance_media(&ctx, &local_id, &payload, &body, true)
    })
    .is_err()
    {
        return Ok(MediaSendResult::blocked(
            "upload",
            true,
            "send admission could not be durably recorded; no SDK call is permitted",
        ));
    }
    media_progress(&app, &ctx, &gid, &attachment_id, &local_id, "send");
    let mut send = args;
    send["local_id"] = local_id.clone().into();
    send["body_json"] = body.clone().into();
    let reply: Option<MediaSendReply> = forward(&app, &ctx, "im.send_media", send, WRITE_TIMEOUT)
        .await
        .ok();
    let reply = reply.filter(|r| {
        media_outbound::validate_message(
            &r.message,
            &r.disposition,
            &body,
            &gid,
            &local_id,
            &frozen.dto.kind,
            &frozen.target.sender_id,
        )
    });
    let observed = reply
        .as_ref()
        .map(|r| r.disposition.clone())
        .unwrap_or(SendDispositionDto::Unknown);
    // Same rule as `outbound_journal::send_once`: a committed outcome whose
    // durability barrier then failed keeps the real observed outcome (never a
    // fabricated Unknown) and carries the barrier error to the caller. Any
    // other failure (nothing committed) stays Unknown.
    let held = outbound_journal::normalize(observed.clone());
    let (disposition, barrier_error) = match with_outbound(&app, &ctx, |journal| {
        journal.finish_media(&ctx, &local_id, &payload, observed)
    }) {
        Ok(saved) => (saved, None),
        Err(error) if error.code == core_im::media_contract::codes::IM_JOURNAL_BARRIER_FAILED => {
            (held, Some(error.message))
        }
        Err(_) => (SendDispositionDto::Unknown, None),
    };
    let mut result = MediaSendResult::replay("send".into(), true, disposition.clone());
    result.error = barrier_error;
    if let Some(mut reply) = reply {
        reply.message.disposition = Some(disposition);
        result.message = Some(reply.message);
    }
    Ok(result)
}

/// Read-only recovery metadata for the UI's explicit verification entry point.
/// This exposes no payload and cannot dispatch or create an attempt.
pub fn unknown_outbound_attempts(
    app: &AppHandle,
    account: &AccountContext,
) -> Result<Vec<outbound_journal::UnknownAttemptMetadata>, AppError> {
    app.state::<HostState>().lock().accounts.validate(account)?;
    let module = module(app)?;
    let journal = module.outbound.as_ref().ok_or_else(|| {
        AppError::new(
            "im.journal_unavailable",
            "durable outbound storage is unavailable",
        )
    })?;
    let result = lock(journal).unknown_metadata(account);
    result
}

// ------------------------------------------------------------------ page → host

#[derive(Debug, Deserialize)]
struct ReadyPayload {
    #[allow(dead_code)]
    url: String,
    #[allow(dead_code)]
    #[serde(default)]
    sdk_version: Option<String>,
}

/// Mirrors `AdapterReadyAck`.
#[derive(Debug, Serialize)]
pub struct AdapterReadyAckDto {
    pub account: Option<AccountContextDto>,
    pub begin_msg_time: i64,
    pub initial_epoch: u64,
}

#[tauri::command]
pub fn adapter_ready(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    request: Request<'_>,
) -> CmdResult<AdapterReadyAckDto> {
    guard(&state, webview.label(), "adapter_ready")?;
    let _payload: ReadyPayload = body(&request, "payload").map_err(e2dto)?;
    let initial_epoch = module(&app)
        .map_err(e2dto)?
        .epoch
        .fetch_add(1, Ordering::SeqCst)
        + 1;
    let account =
        login::issue_adapter_ready(&app, webview.label(), initial_epoch).map_err(e2dto)?;
    let begin_msg_time = account
        .as_ref()
        .map(|c| state.compensation_watermark(c))
        .unwrap_or(0);
    Ok(AdapterReadyAckDto {
        account: account.as_ref().map(AccountContextDto::from),
        begin_msg_time,
        initial_epoch,
    })
}

#[tauri::command]
pub fn adapter_identity(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    request: Request<'_>,
) -> CmdResult<AccountContextDto> {
    guard(&state, webview.label(), "adapter_identity")?;
    let identity: login::UpstreamIdentityDto = body(&request, "payload").map_err(e2dto)?;
    if identity.environment != "production" || identity.buid.is_empty() {
        return Err(e2dto(AppError::new(
            "adapter.invalid_payload",
            "unsupported identity",
        )));
    }
    let ctx = login::on_identity(&app, webview.label(), identity).map_err(e2dto)?;
    crate::clock_anchor::start(&app, &ctx);
    Ok((&ctx).into())
}

fn validate_bridge_fault_control(
    envelope: &AdapterFactEnvelopeDto,
    boot_epoch: u64,
) -> Result<(), AppError> {
    if envelope.stream != "im.transport"
        || envelope.epoch != boot_epoch
        || boot_epoch == 0
        || envelope.seq != 0
    {
        return Err(AppError::new(
            "adapter.invalid_payload",
            "invalid bridge fault control envelope",
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn adapter_push_fact(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    request: Request<'_>,
) -> CmdResult<IngestReportDto> {
    guard(&state, webview.label(), "adapter_push_fact")?;
    let mut envelope: AdapterFactEnvelopeDto = body(&request, "envelope").map_err(e2dto)?;
    if let AdapterFactDto::BridgeFault { fault } = &envelope.fact {
        // Host-only terminal control, never an IM cursor/fact or auth signal.
        validate_bridge_fault_control(&envelope, fault.boot_epoch).map_err(e2dto)?;
        let account: AccountContext = envelope.account.clone().into();
        let suspended = login::suspend_faulted_adapter(
            &app,
            webview.label(),
            &account,
            fault.boot_epoch,
            &fault.reason,
        )
        .map_err(e2dto)?;
        return Ok(IngestReportDto {
            applied: suspended,
            dropped: (!suspended).then(|| "stale_adapter_boot".into()),
            needs_resync: None,
            auth_invalid: false,
        });
    }
    let ctx = bound_caller(&app, &state, &webview, "adapter_push_fact")?;
    let claimed: AccountContext = envelope.account.clone().into();
    if claimed != ctx {
        return Err(e2dto(unauthorized(
            "envelope account does not match the calling webview",
        )));
    }
    envelope.account = (&ctx).into();
    if let AdapterFactDto::Feature { fact } = &envelope.fact {
        // Not a core fact: validated, rate-limited and forwarded to the main
        // window only (no ingest, no persistence, no IngestReport count).
        let m = module(&app).map_err(e2dto)?;
        return forward_feature_fact(&app, &m, &ctx, state.clock.wall_ms(), fact.clone())
            .map_err(e2dto);
    }
    let gid = match &envelope.fact {
        AdapterFactDto::Message { fact } => Some(fact.gid.clone()),
        AdapterFactDto::Conversation { fact } => Some(fact.gid.clone()),
        _ => None,
    };
    let report = if matches!(&envelope.fact, AdapterFactDto::AuthInvalid) {
        login::push_auth_invalid(&app, envelope)
    } else {
        state.push_fact(envelope)
    }
    .map_err(e2dto)?;
    if let (true, Some(gid)) = (report.applied, gid) {
        // The round may have started or ended: refresh the row's waiting state.
        emit_conversations(&app, &ctx, &[gid]);
    }
    Ok(IngestReportDto {
        applied: report.applied,
        dropped: report.dropped.map(|d| format!("{d:?}")),
        needs_resync: report.needs_resync.map(|s| s.name().to_string()),
        auth_invalid: report.auth_invalid,
    })
}

#[tauri::command]
pub fn adapter_push_display(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    request: Request<'_>,
) -> CmdResult<()> {
    let ctx = bound_caller(&app, &state, &webview, "adapter_push_display")?;
    let m = module(&app).map_err(e2dto)?;
    let payload = body(&request, "payload");
    if matches!(&payload, Ok(DisplayPayload::AgentStatus { .. })) {
        return apply_agent_status(&app, &ctx, payload.map_err(e2dto)?).map_err(e2dto);
    }
    let delta = apply_display_diagnosed(&m, &ctx, payload).map_err(e2dto)?;
    match delta {
        DisplayDelta::Conversations { changed, removed } => {
            for gid in &removed {
                crate::assistant::order_commands::on_conversation_change(&app, &ctx, gid, None);
            }
            emit_conversations(&app, &ctx, &changed);
            crate::notifications::refresh(&app, &ctx, &changed);
            if !removed.is_empty() {
                events::to_main(
                    &app,
                    events::IM_CONVERSATIONS_INVALIDATED,
                    AccountContextDto::from(&ctx),
                );
            }
            if !changed.is_empty() || !removed.is_empty() {
                sync_unread(&app, &ctx);
            }
        }
        DisplayDelta::Messages { changed, .. } => {
            let account = AccountContextDto::from(&ctx);
            for message in &changed {
                lock(&m.receive).note(&ctx, |c| {
                    c.main_emit_attempts = diagnostic_count(c.main_emit_attempts, 1)
                });
                events::to_main(
                    &app,
                    events::IM_MESSAGE_NEW,
                    UiMessageEventDto {
                        message,
                        account: account.clone(),
                    },
                );
            }
        }
        DisplayDelta::MessageReadStatuses { gid, items } => {
            events::to_main(
                &app,
                events::IM_MESSAGE_READ_STATUSES,
                serde_json::json!({
                    "account": AccountContextDto::from(&ctx),
                    "gid": gid,
                    "items": items,
                }),
            );
        }
        DisplayDelta::AgentStatus(_) => unreachable!("agent status uses ordered host transaction"),
        DisplayDelta::Transport(t) => {
            if is_focus(&app, &ctx) {
                events::to_local_windows(
                    &app,
                    events::NET_STATUS,
                    Scoped {
                        inner: UiNetStatusDto::from(t),
                        account: (&ctx).into(),
                    },
                );
            }
        }
        DisplayDelta::NoticeCategories => {}
    }
    Ok(())
}

#[derive(Deserialize)]
struct ReplyPayload {
    req_id: String,
    ok: bool,
    #[serde(default)]
    data: Value,
    #[serde(default)]
    error: Option<AppErrorDto>,
}

#[tauri::command]
pub fn adapter_reply(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    request: Request<'_>,
) -> CmdResult<()> {
    let ctx = caller(&app, &state, &webview, "adapter_reply")?
        .ok_or_else(|| e2dto(unauthorized("no account is bound to this webview")))?;
    let reply: ReplyPayload = body(&request, "payload").map_err(e2dto)?;
    let result = if reply.ok {
        Ok(reply.data)
    } else {
        Err(reply
            .error
            .map(dto2e)
            .unwrap_or_else(|| AppError::new(codes::ADAPTER_FAILED, "page reported a failure")))
    };
    let m = module(&app).map_err(e2dto)?;
    let r = lock(&m.pending).complete(&ctx, &reply.req_id, result);
    r.map_err(e2dto)
}

// ------------------------------------------------------------------ UI commands

#[tauri::command(rename_all = "snake_case")]
pub async fn account_agent_status(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
) -> CmdResult<UiAgentStatusDto> {
    guard(&state, webview.label(), "account_agent_status")?;
    let ctx = ui_account(&app, &state, account)?;
    forward::<UiAgentStatusDto>(
        &app,
        &ctx,
        "agent.status",
        serde_json::json!({}),
        READ_TIMEOUT,
    )
    .await
    .map_err(e2dto)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn account_set_agent_status(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
    status: AgentStatusDto,
) -> CmdResult<UiAgentStatusDto> {
    guard(&state, webview.label(), "account_set_agent_status")?;
    let ctx = ui_account(&app, &state, account)?;
    let s: UiAgentStatusDto = forward(
        &app,
        &ctx,
        "agent.set_status",
        serde_json::json!({ "status": status }),
        WRITE_TIMEOUT,
    )
    .await
    .map_err(e2dto)?;
    // Status display pushes carry the adapter's ordering/freshness fences.
    // Replaying this RPC result here could overwrite a newer poll observation.
    Ok(s)
}

#[tauri::command(rename_all = "snake_case")]
pub fn im_conversations(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
) -> CmdResult<Vec<UiConversationDto>> {
    guard(&state, webview.label(), "im_conversations")?;
    let ctx = ui_account(&app, &state, account)?;
    let m = module(&app).map_err(e2dto)?;
    let rows = lock(&m.display).conversations(&ctx).map_err(e2dto)?;
    Ok(to_ui(&app, &ctx, rows))
}

#[derive(Deserialize, Serialize)]
pub struct OutboundLookupItemDto {
    gid: String,
    message_id: Option<String>,
    local_id: Option<String>,
    sender_role: String,
}
#[derive(Deserialize, Serialize)]
pub struct OutboundLookupDto {
    items: Vec<OutboundLookupItemDto>,
}

/// Isolated evidence lookup: no focus, display-cache, fact, receipt or journal mutation.
#[tauri::command(rename_all = "snake_case")]
pub async fn im_outbound_lookup(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
    gid: String,
) -> CmdResult<OutboundLookupDto> {
    guard(&state, webview.label(), "im_outbound_lookup")?;
    let ctx: AccountContext = account.into();
    state.lock().accounts.validate(&ctx).map_err(e2dto)?;
    let result = forward(
        &app,
        &ctx,
        "im.outbound_lookup",
        serde_json::json!({ "gid": gid }),
        READ_TIMEOUT,
    )
    .await
    .map_err(e2dto)?;
    state.lock().accounts.validate(&ctx).map_err(e2dto)?;
    Ok(result)
}

/// Explicit metadata read: no focus mutation, page RPC, dispatch or journal transition.
#[tauri::command(rename_all = "snake_case")]
pub fn im_unknown_outbound(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
) -> CmdResult<Vec<outbound_journal::UnknownAttemptMetadata>> {
    guard(&state, webview.label(), "im_unknown_outbound")?;
    let ctx: AccountContext = account.into();
    let rows = unknown_outbound_attempts(&app, &ctx).map_err(e2dto)?;
    state.lock().accounts.validate(&ctx).map_err(e2dto)?;
    Ok(rows)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn im_messages(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
    gid: String,
) -> CmdResult<Vec<UiMessageDto>> {
    guard(&state, webview.label(), "im_messages")?;
    let ctx = ui_account(&app, &state, account)?;
    let m = module(&app).map_err(e2dto)?;
    // A cached realtime message is not proof that history has been fetched.
    let items: Vec<UiMessageDto> = forward(
        &app,
        &ctx,
        "im.messages",
        serde_json::json!({ "gid": gid }),
        READ_TIMEOUT,
    )
    .await
    .map_err(e2dto)?;
    state.lock().accounts.validate(&ctx).map_err(e2dto)?;
    let r = lock(&m.display).merge_thread(&ctx, &gid, items);
    r.map_err(e2dto)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn im_message_page(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
    gid: String,
    before_ms: Option<i64>,
    expected_context_revision: Option<String>,
) -> CmdResult<UiMessagePageDto> {
    guard(&state, webview.label(), "im_message_page")?;
    let ctx = read_account(&state, account)?;
    let m = module(&app).map_err(e2dto)?;
    let mut args = serde_json::json!({ "gid": gid });
    if let Some(before) = before_ms {
        args["before_ms"] = before.into();
    }
    if let Some(revision) = expected_context_revision {
        args["expected_context_revision"] = revision.into();
    }
    let page: UiMessagePageDto = forward(&app, &ctx, "im.message_page", args, READ_TIMEOUT)
        .await
        .map_err(e2dto)?;
    state.lock().accounts.validate(&ctx).map_err(e2dto)?;
    lock(&m.display)
        .merge_thread(&ctx, &gid, page.items.clone())
        .map_err(e2dto)?;
    Ok(page)
}

const MAX_TRANSLATE_IDS: usize = 20;
const MAX_TRANSLATION_CHARS: usize = 20_000;

/// Keeps only answers to the requested IDs; a translation exists only on `translated`.
fn accepted_translations(
    requested: &[String],
    mut page: display::UiMessageTranslationsDto,
) -> display::UiMessageTranslationsDto {
    page.items.retain(|item| {
        requested.contains(&item.message_id)
            && matches!(
                item.status.as_str(),
                "translated" | "not_needed" | "missing" | "unsupported"
            )
            && (item.status == "translated")
                == item.translation.as_deref().is_some_and(|text| {
                    !text.trim().is_empty() && text.chars().count() <= MAX_TRANSLATION_CHARS
                })
    });
    page
}

/// One line per answer that did not plainly translate everything. The page's
/// values are counted or matched against fixed names, so nothing it says can
/// reach the log, and neither message text nor message IDs are written.
fn translation_answer_log(
    page: &display::UiMessageTranslationsDto,
    requested: usize,
    echoes: usize,
) -> Option<String> {
    let status = |name: &str| page.items.iter().filter(|i| i.status == name).count();
    let reason = |name: &str| {
        page.items
            .iter()
            .filter(|i| i.reason.as_deref() == Some(name))
            .count()
    };
    let (translated, flagged) = (status("translated"), reason("flagged"));
    if translated == requested && echoes == 0 && flagged == 0 {
        return None;
    }
    let session = page
        .session_tag
        .as_deref()
        .filter(|tag| tag.len() == 8 && tag.bytes().all(|b| b.is_ascii_hexdigit()))
        .unwrap_or("-");
    Some(format!(
        "im_translate_messages: requested={requested} translated={translated} echoes={echoes} not_needed={} missing={} unsupported={} flagged={flagged} card={} blank={} no_row={} option_off={} session={session}",
        status("not_needed"),
        status("missing"),
        status("unsupported"),
        reason("card"),
        reason("blank"),
        reason("no_row"),
        reason("option_off"),
    ))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn im_translate_messages(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
    gid: String,
    message_ids: Vec<String>,
) -> CmdResult<display::UiMessageTranslationsDto> {
    guard(&state, webview.label(), "im_translate_messages")?;
    let ctx = read_account(&state, account)?;
    if gid.is_empty()
        || message_ids.is_empty()
        || message_ids.len() > MAX_TRANSLATE_IDS
        || message_ids.iter().any(|id| id.trim().is_empty())
    {
        return Err(e2dto(AppError::new(
            "im.invalid_translate",
            "gid and 1-20 message ids are required",
        )));
    }
    let m = module(&app).map_err(e2dto)?;
    let args = serde_json::json!({ "gid": gid, "message_ids": message_ids });
    let page: display::UiMessageTranslationsDto =
        forward(&app, &ctx, "im.translate_messages", args, READ_TIMEOUT)
            .await
            .inspect_err(|e| log::info!("im_translate_messages failed: {}", e.code))
            .map_err(e2dto)?;
    state.lock().accounts.validate(&ctx).map_err(e2dto)?;
    let page = accepted_translations(&message_ids, page);
    let echoes = lock(&m.display)
        .set_translations(&ctx, &gid, &page.items)
        .map_err(e2dto)?;
    if let Some(line) = translation_answer_log(&page, message_ids.len(), echoes) {
        log::info!("{line}");
    }
    Ok(page)
}

#[tauri::command(rename_all = "snake_case")]
#[allow(clippy::too_many_arguments)]
pub async fn im_send_text(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
    gid: String,
    local_id: String,
    text: String,
    original: Option<String>,
    quote_id: Option<String>,
) -> CmdResult<SendDispositionDto> {
    guard(&state, webview.label(), "im_send_text")?;
    let ctx = ui_account(&app, &state, account)?;
    if gid.is_empty() || local_id.is_empty() || text.trim().is_empty() {
        return Err(e2dto(AppError::new(
            "im.invalid_send",
            "gid, local_id and text are required",
        )));
    }
    let args = serde_json::json!({
        "gid": gid, "local_id": local_id, "text": text, "original": original, "quote_id": quote_id,
    });
    let module = module(&app).map_err(e2dto)?;
    let journal = module.outbound.as_ref().ok_or_else(|| {
        e2dto(AppError::new(
            "im.journal_unavailable",
            "durable outbound storage is unavailable (nothing sent)",
        ))
    })?;
    // Send barrier (I-04a): while a durable write is failed nothing is
    // journaled or sent. `store.persist_failed` before `reserve`, so the
    // refusal is "nothing submitted" and the UI shows it as a local reject.
    state.persist_barrier().map_err(e2dto)?;
    let payload = outbound_journal::SendPayload {
        gid,
        text,
        original,
        quote_id,
    };
    outbound_journal::send_once_authorized(
        journal,
        &ctx,
        &local_id,
        &payload,
        || state.lock().accounts.validate(&ctx),
        || async {
            let result = request_inner(&app, &ctx, "im.send_text", args, WRITE_TIMEOUT).await;
            send_outcome(result)
        },
    )
    .await
    .map_err(e2dto)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn im_mark_read(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
    gid: String,
    expected_message_id: String,
    expected_context_revision: String,
) -> CmdResult<()> {
    guard(&state, webview.label(), "im_mark_read")?;
    let ctx = ui_account(&app, &state, account)?;
    request(
        &app,
        &ctx,
        "im.mark_read",
        serde_json::json!({ "gid": gid, "expected_message_id": expected_message_id, "expected_context_revision": expected_context_revision }),
        WRITE_TIMEOUT,
    )
    .await
    .map_err(e2dto)?;
    // An SDK acknowledgment is not an authoritative unread snapshot. Keep both
    // core and display counts until the account adapter reports the server count.
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn im_set_top(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
    gid: String,
    top: bool,
) -> CmdResult<()> {
    guard(&state, webview.label(), "im_set_top")?;
    let ctx = ui_account(&app, &state, account)?;
    if gid.is_empty() {
        return Err(e2dto(AppError::new("im.invalid_gid", "gid is required")));
    }
    let m = module(&app).map_err(e2dto)?;
    let changed = lock(&m.pinned).set(&ctx, &gid, top).map_err(e2dto)?;
    if changed {
        emit_conversations(&app, &ctx, &[gid]);
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn im_set_mark(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
    gid: String,
    action: u8,
) -> CmdResult<()> {
    guard(&state, webview.label(), "im_set_mark")?;
    let ctx = ui_account(&app, &state, account)?;
    if action > 5 {
        return Err(e2dto(AppError::new(
            "im.invalid_mark",
            "action must be 0..=5",
        )));
    }
    request(
        &app,
        &ctx,
        "im.set_mark",
        serde_json::json!({ "gid": gid, "action": action }),
        WRITE_TIMEOUT,
    )
    .await
    .map_err(e2dto)?;
    let m = module(&app).map_err(e2dto)?;
    let changed = lock(&m.display)
        .set_mark(&ctx, &gid, action)
        .unwrap_or(false);
    if changed {
        emit_conversations(&app, &ctx, &[gid]);
    }
    Ok(())
}

// ----------------------------------------------------------- peripheral APIs

#[tauri::command(rename_all = "snake_case")]
pub async fn im_customer_scripts(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
    content: String,
) -> CmdResult<display::UiCustomerScriptsDto> {
    guard(&state, webview.label(), "im_customer_scripts")?;
    let ctx = ui_account(&app, &state, account)?;
    let result = forward(
        &app,
        &ctx,
        "im.customer_scripts",
        serde_json::json!({"content": content}),
        READ_TIMEOUT,
    )
    .await
    .map_err(e2dto)?;
    state.lock().accounts.validate(&ctx).map_err(e2dto)?;
    Ok(result)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn im_quick_reply_categories(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
    r#type: display::QuickReplyCategoryTypeDto,
) -> CmdResult<Value> {
    guard(&state, webview.label(), "im_quick_reply_categories")?;
    let ctx = ui_account(&app, &state, account)?;
    let result = forward(
        &app,
        &ctx,
        "im.quick_reply_categories",
        serde_json::json!({"type": r#type}),
        READ_TIMEOUT,
    )
    .await
    .map_err(e2dto)?;
    state.lock().accounts.validate(&ctx).map_err(e2dto)?;
    Ok(result)
}

fn recommend_products_args(
    gid: &str,
    query: &str,
    departure_city_id: Option<i64>,
    destination_city_id: Option<i64>,
    page_index: u32,
) -> Result<Value, AppError> {
    // The official picker uses -1 for "all cities". City IDs cross a JS
    // number boundary, so reject values that cannot retain integer precision.
    const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
    if [departure_city_id, destination_city_id]
        .into_iter()
        .flatten()
        .any(|id| !(-1..=MAX_SAFE_INTEGER).contains(&id))
    {
        return Err(AppError::new(
            "im.invalid_city_id",
            "city ID must be -1 or a nonnegative safe integer",
        ));
    }
    let mut args = serde_json::json!({"gid": gid, "query": query, "page_index": page_index});
    if let Some(id) = departure_city_id {
        args["departure_city_id"] = serde_json::json!(id);
    }
    if let Some(id) = destination_city_id {
        args["destination_city_id"] = serde_json::json!(id);
    }
    Ok(args)
}

#[tauri::command(rename_all = "snake_case")]
#[allow(clippy::too_many_arguments)]
pub async fn im_recommend_products(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
    gid: String,
    query: String,
    departure_city_id: Option<i64>,
    destination_city_id: Option<i64>,
    page_index: u32,
) -> CmdResult<Value> {
    guard(&state, webview.label(), "im_recommend_products")?;
    let ctx = ui_account(&app, &state, account)?;
    let args = recommend_products_args(
        &gid,
        &query,
        departure_city_id,
        destination_city_id,
        page_index,
    )
    .map_err(e2dto)?;
    let result = forward(&app, &ctx, "im.recommend_products", args, READ_TIMEOUT)
        .await
        .map_err(e2dto)?;
    state.lock().accounts.validate(&ctx).map_err(e2dto)?;
    Ok(result)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn im_recommend_cities(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
    query: String,
) -> CmdResult<Value> {
    guard(&state, webview.label(), "im_recommend_cities")?;
    let ctx = ui_account(&app, &state, account)?;
    let result = forward(
        &app,
        &ctx,
        "im.recommend_cities",
        serde_json::json!({"query": query}),
        READ_TIMEOUT,
    )
    .await
    .map_err(e2dto)?;
    state.lock().accounts.validate(&ctx).map_err(e2dto)?;
    Ok(result)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn im_members(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
    gid: String,
) -> CmdResult<display::UiMembersDto> {
    guard(&state, webview.label(), "im_members")?;
    let ctx = ui_account(&app, &state, account)?;
    let result = forward(
        &app,
        &ctx,
        "im.members",
        serde_json::json!({"gid": gid}),
        READ_TIMEOUT,
    )
    .await
    .map_err(e2dto)?;
    state.lock().accounts.validate(&ctx).map_err(e2dto)?;
    Ok(result)
}

#[tauri::command(rename_all = "snake_case")]
#[allow(clippy::too_many_arguments)] // Tauri injects app/window/state alongside the wire arguments.
pub async fn im_invite_candidates(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
    gid: String,
    parent_skill_group_ids: Option<Vec<u64>>,
    keywords: Option<String>,
    extend_token: Option<String>,
) -> CmdResult<display::UiInviteCandidatesDto> {
    guard(&state, webview.label(), "im_invite_candidates")?;
    let ctx = ui_account(&app, &state, account)?;
    let mut args = serde_json::json!({"gid": gid});
    if let Some(ids) = parent_skill_group_ids {
        args["parent_skill_group_ids"] = serde_json::json!(ids);
    }
    if let Some(words) = keywords {
        args["keywords"] = serde_json::json!(words);
    }
    if let Some(token) = extend_token {
        args["extend_token"] = serde_json::json!(token);
    }
    let result = forward(&app, &ctx, "im.invite_candidates", args, READ_TIMEOUT)
        .await
        .map_err(e2dto)?;
    state.lock().accounts.validate(&ctx).map_err(e2dto)?;
    Ok(result)
}

/// A missing host reply after emit cannot authorize another write. The page's
/// per-session action journal also returns the first result on duplicate calls.
fn peripheral_write_outcome(
    result: Result<Value, RequestFailure>,
) -> Result<display::UiPeripheralWriteDto, AppError> {
    match result {
        Ok(v) => match serde_json::from_value::<display::UiPeripheralWriteDto>(v) {
            Ok(r) if r.confirmed == (r.kind == display::PeripheralWriteKindDto::Confirmed) => Ok(r),
            _ => Ok(display::UiPeripheralWriteDto {
                kind: display::PeripheralWriteKindDto::Unknown,
                confirmed: false,
                reason: Some(
                    "invalid reply after submission; read back and do not resubmit".into(),
                ),
            }),
        },
        Err(f) if f.emitted && !f.from_page => Ok(display::UiPeripheralWriteDto {
            kind: display::PeripheralWriteKindDto::Unknown,
            confirmed: false,
            reason: Some(
                "host reply missing after submission; read back and do not resubmit".into(),
            ),
        }),
        Err(f) => Err(f.error),
    }
}

fn peripheral_request(intent: &peripheral_journal::Intent) -> (&'static str, Value) {
    match intent.action {
        peripheral_journal::Action::Invite => (
            "im.invite",
            serde_json::json!({ "gid": intent.gid, "selection_token": intent.selection_token, "target_uids": intent.targets }),
        ),
        peripheral_journal::Action::Transfer => (
            "im.transfer",
            serde_json::json!({ "gid": intent.gid, "selection_token": intent.selection_token, "target_uid": intent.targets.first() }),
        ),
        peripheral_journal::Action::Finish => (
            "im.finish",
            serde_json::json!({ "gid": intent.gid, "selection_token": intent.selection_token }),
        ),
        peripheral_journal::Action::Remove => (
            "im.remove",
            serde_json::json!({ "gid": intent.gid, "selection_token": intent.selection_token, "target_uids": intent.targets }),
        ),
        peripheral_journal::Action::ProductCard => (
            "im.send_product_card",
            serde_json::json!({ "gid": intent.gid, "selection_token": intent.selection_token, "product_id": intent.targets.first() }),
        ),
    }
}

/// Peripheral write commands cross this durable admission boundary before
/// emitting an RPC. A fresh selection token never clears an uncertain room /
/// action / targets barrier, including after page or account-generation changes.
async fn request_peripheral_once(
    app: &AppHandle,
    state: &HostState,
    ctx: &AccountContext,
    intent: &peripheral_journal::Intent,
) -> Result<display::UiPeripheralWriteDto, AppError> {
    let module = module(app)?;
    let journal = module.peripheral.as_ref().ok_or_else(|| {
        AppError::new(
            "im.peripheral_journal_unavailable",
            "durable peripheral storage unavailable; nothing submitted",
        )
    })?;
    peripheral_journal::dispatch_once(journal, ctx, intent, || async {
        let (op, args) = peripheral_request(intent);
        let result = request_inner(app, ctx, op, args, WRITE_TIMEOUT).await;
        state.lock().accounts.validate(ctx)?;
        peripheral_write_outcome(result)
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn im_send_product_card(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
    gid: String,
    selection_token: String,
    product_id: String,
) -> CmdResult<display::UiPeripheralWriteDto> {
    guard(&state, webview.label(), "im_send_product_card")?;
    let ctx = ui_account(&app, &state, account)?;
    let result = request_peripheral_once(
        &app,
        &state,
        &ctx,
        &peripheral_journal::Intent {
            gid,
            action: peripheral_journal::Action::ProductCard,
            targets: vec![product_id],
            selection_token,
        },
    )
    .await;
    state.lock().accounts.validate(&ctx).map_err(e2dto)?;
    result.map_err(e2dto)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn im_invite(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
    gid: String,
    selection_token: String,
    target_uids: Vec<String>,
) -> CmdResult<display::UiPeripheralWriteDto> {
    guard(&state, webview.label(), "im_invite")?;
    let ctx = ui_account(&app, &state, account)?;
    let result = request_peripheral_once(
        &app,
        &state,
        &ctx,
        &peripheral_journal::Intent {
            gid,
            action: peripheral_journal::Action::Invite,
            targets: target_uids,
            selection_token,
        },
    )
    .await;
    state.lock().accounts.validate(&ctx).map_err(e2dto)?;
    result.map_err(e2dto)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn im_transfer(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
    gid: String,
    selection_token: String,
    target_uid: String,
) -> CmdResult<display::UiPeripheralWriteDto> {
    guard(&state, webview.label(), "im_transfer")?;
    let ctx = ui_account(&app, &state, account)?;
    let result = request_peripheral_once(
        &app,
        &state,
        &ctx,
        &peripheral_journal::Intent {
            gid,
            action: peripheral_journal::Action::Transfer,
            targets: vec![target_uid],
            selection_token,
        },
    )
    .await;
    state.lock().accounts.validate(&ctx).map_err(e2dto)?;
    result.map_err(e2dto)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn im_finish(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
    gid: String,
    selection_token: String,
) -> CmdResult<display::UiPeripheralWriteDto> {
    guard(&state, webview.label(), "im_finish")?;
    let ctx = ui_account(&app, &state, account)?;
    let result = request_peripheral_once(
        &app,
        &state,
        &ctx,
        &peripheral_journal::Intent {
            gid,
            action: peripheral_journal::Action::Finish,
            targets: vec![],
            selection_token,
        },
    )
    .await;
    state.lock().accounts.validate(&ctx).map_err(e2dto)?;
    result.map_err(e2dto)
}

/// Official「移除成员」. Separate command and barrier from im_finish so an empty
/// or lost target list can never degrade into ending the conversation.
#[tauri::command(rename_all = "snake_case")]
pub async fn im_remove(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
    gid: String,
    selection_token: String,
    target_uids: Vec<String>,
) -> CmdResult<display::UiPeripheralWriteDto> {
    guard(&state, webview.label(), "im_remove")?;
    let ctx = ui_account(&app, &state, account)?;
    let result = request_peripheral_once(
        &app,
        &state,
        &ctx,
        &peripheral_journal::Intent {
            gid,
            action: peripheral_journal::Action::Remove,
            targets: target_uids,
            selection_token,
        },
    )
    .await;
    state.lock().accounts.validate(&ctx).map_err(e2dto)?;
    result.map_err(e2dto)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn notice_categories(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
) -> CmdResult<Vec<UiNoticeCategoryDto>> {
    guard(&state, webview.label(), "notice_categories")?;
    let ctx = ui_account(&app, &state, account)?;
    let m = module(&app).map_err(e2dto)?;
    match forward::<Vec<UiNoticeCategoryDto>>(
        &app,
        &ctx,
        "notice.categories",
        serde_json::json!({}),
        READ_TIMEOUT,
    )
    .await
    {
        Ok(items) => {
            let _ = lock(&m.display).set_notice_categories(&ctx, items.clone());
            Ok(items)
        }
        Err(e) => Err(e2dto(e)),
    }
}

/// Mirrors `UiNotice` (client.ts).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UiNoticeDto {
    pub id: String,
    pub category_id: String,
    pub title: String,
    pub body: String,
    pub time_ms: i64,
    pub unread: bool,
    pub url: String,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn notice_list(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
    category_id: String,
    before_ms: Option<i64>,
) -> CmdResult<Vec<UiNoticeDto>> {
    guard(&state, webview.label(), "notice_list")?;
    let ctx = ui_account(&app, &state, account)?;
    forward(
        &app,
        &ctx,
        "notice.list",
        serde_json::json!({ "category_id": category_id, "before_ms": before_ms }),
        READ_TIMEOUT,
    )
    .await
    .map_err(e2dto)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn notice_mark_read(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
    category_id: String,
    id: Option<String>,
) -> CmdResult<()> {
    guard(&state, webview.label(), "notice_mark_read")?;
    let ctx = ui_account(&app, &state, account)?;
    request(
        &app,
        &ctx,
        "notice.mark_read",
        serde_json::json!({ "category_id": category_id, "id": id }),
        WRITE_TIMEOUT,
    )
    .await
    .map(|_| ())
    .map_err(e2dto)
}

/// Resolve only an already-cached image in this account's exact thread.
pub(crate) fn cached_image_url(
    app: &AppHandle,
    ctx: &AccountContext,
    gid: &str,
    message_id: &str,
) -> Result<String, AppError> {
    let m = module(app)?;
    let messages = lock(&m.display).messages(ctx, gid)?.unwrap_or_default();
    messages
        .into_iter()
        .find(|message| {
            message.gid == gid
                && message.message_id.as_deref() == Some(message_id)
                && message.kind == "image"
        })
        .and_then(|message| message.media_url.filter(|url| !url.is_empty()))
        .ok_or_else(|| not_ready("cached image is unavailable"))
}

/// Read-only server search. Results stay outside the host conversation cache.
#[tauri::command(rename_all = "snake_case")]
pub async fn im_server_search(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
    query: Value,
) -> CmdResult<Value> {
    guard(&state, webview.label(), "im_server_search")?;
    let ctx = read_account(&state, account)?;
    if !query.is_object() || query.to_string().len() > 2048 {
        return Err(e2dto(bad_reply()));
    }
    let result = request(&app, &ctx, "im.server_search", query, READ_TIMEOUT)
        .await
        .map_err(e2dto)?;
    state.lock().accounts.validate(&ctx).map_err(e2dto)?;
    tagged_object(result, "groups").map_err(e2dto)
}

/// Selection token is resolved by the account's current adapter RPC instance;
/// the UI cannot provide arbitrary gid, service identity, or message body.
#[tauri::command(rename_all = "snake_case")]
pub async fn im_search_history(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
    query: Value,
) -> CmdResult<Value> {
    guard(&state, webview.label(), "im_search_history")?;
    let ctx = read_account(&state, account)?;
    if !query.is_object() || query.to_string().len() > 1024 {
        return Err(e2dto(bad_reply()));
    }
    let result = request(&app, &ctx, "im.search_history", query, READ_TIMEOUT)
        .await
        .map_err(e2dto)?;
    state.lock().accounts.validate(&ctx).map_err(e2dto)?;
    tagged_object(result, "items").map_err(e2dto)
}

/// `OrderSearchResult` / `{gid, reused}` are passed through after a shape check.
fn tagged_object(v: Value, required: &str) -> Result<Value, AppError> {
    if v.get(required).is_some() {
        Ok(v)
    } else {
        Err(bad_reply())
    }
}

#[tauri::command(rename_all = "snake_case")]
pub async fn order_search(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
    order_id: String,
) -> CmdResult<Value> {
    guard(&state, webview.label(), "order_search")?;
    let ctx = ui_account(&app, &state, account)?;
    let v = request(
        &app,
        &ctx,
        "order.search",
        serde_json::json!({ "order_id": order_id }),
        READ_TIMEOUT,
    )
    .await
    .map_err(e2dto)?;
    tagged_object(v, "kind").map_err(e2dto)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn order_create_im_chat(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
    order_id: String,
) -> CmdResult<Value> {
    guard(&state, webview.label(), "order_create_im_chat")?;
    let ctx = ui_account(&app, &state, account)?;
    let v = request(
        &app,
        &ctx,
        "order.create_im_chat",
        serde_json::json!({ "order_id": order_id }),
        WRITE_TIMEOUT,
    )
    .await
    .map_err(e2dto)?;
    tagged_object(v, "gid").map_err(e2dto)
}

const DIAGNOSTIC_TIMEOUT: Duration = Duration::from_secs(2);
async fn diagnostics_if_requested<F, Fut>(
    include: bool,
    has_account: bool,
    host: Option<display::HostReceiveDiagnosticsDto>,
    request: F,
) -> Option<display::ReceiveDiagnosticsDto>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<Value, RequestFailure>>,
{
    if !include {
        return None;
    }
    let captured_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let mut result = display::ReceiveDiagnosticsDto {
        version: 1,
        captured_at_ms,
        availability: display::DiagnosticAvailability::NoAccount,
        page: None,
        host,
    };
    if has_account {
        match request().await {
            Ok(value) => {
                result.page = display::PageReceiveDiagnosticsDto::decode(value);
                result.availability = if result.page.is_some() {
                    display::DiagnosticAvailability::Ready
                } else {
                    display::DiagnosticAvailability::Invalid
                };
            }
            Err(f) => {
                result.availability = if f.error.code == codes::ADAPTER_TIMEOUT {
                    display::DiagnosticAvailability::Timeout
                } else {
                    display::DiagnosticAvailability::Unavailable
                };
            }
        }
    }
    Some(result)
}
fn bind_diagnostic_result(
    diagnostics: &mut Option<display::ReceiveDiagnosticsDto>,
    requested: Option<&AccountContext>,
    focus: Option<&AccountContext>,
    valid: bool,
) {
    if requested.is_some() && (!valid || requested != focus) {
        if let Some(diag) = diagnostics {
            diag.availability = display::DiagnosticAvailability::Unavailable;
            diag.page = None;
            diag.host = None;
        }
    }
}
fn diagnostic_account(state: &HostState, account: AccountContextDto) -> Option<AccountContext> {
    let ctx: AccountContext = account.into();
    state.lock().accounts.validate(&ctx).ok()?;
    Some(ctx)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn net_status(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    include_diagnostics: Option<bool>,
    account: Option<AccountContextDto>,
) -> CmdResult<display::NetStatusResult> {
    guard(&state, webview.label(), "net_status")?;
    let m = module(&app).map_err(e2dto)?;
    let include = include_diagnostics == Some(true);
    let provided = account.is_some();
    // Explicit diagnostics never borrow another account from the focus cache.
    let current = if include {
        account.and_then(|account| diagnostic_account(&state, account))
    } else {
        None
    };
    let focus = lock(&m.focus).clone();
    let status = {
        let cache = lock(&m.display);
        if let Some(ctx) = &focus {
            cache
                .transport(ctx)
                .map(UiNetStatusDto::from)
                .unwrap_or_else(UiNetStatusDto::offline)
        } else {
            let all = cache.transports();
            let best = all
                .iter()
                .find(|t| t.3 == display::TransportDto::Connected)
                .or_else(|| all.first());
            best.map(|t| UiNetStatusDto::from(t.3))
                .unwrap_or_else(UiNetStatusDto::offline)
        }
    };
    let mut diagnostics = diagnostics_if_requested(include, current.is_some(), None, || async {
        let ctx = current.as_ref().expect("only called with validated focus");
        request_inner(
            &app,
            ctx,
            "adapter.diagnostics",
            serde_json::json!({}),
            DIAGNOSTIC_TIMEOUT,
        )
        .await
    })
    .await;
    // Sample host counters after the page reply so an already-resolved page
    // display invoke cannot be paired with a stale pre-request host snapshot.
    if let Some(diag) = &mut diagnostics {
        diag.host = current.as_ref().map(|ctx| lock(&m.receive).snapshot(ctx));
        diag.captured_at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
    }
    // A result from a replaced account generation is never shown in its successor.
    if include && provided && current.is_none() {
        if let Some(diag) = &mut diagnostics {
            diag.availability = display::DiagnosticAvailability::Unavailable;
        }
    }
    let valid = current
        .as_ref()
        .is_some_and(|ctx| state.lock().accounts.validate(ctx).is_ok());
    bind_diagnostic_result(
        &mut diagnostics,
        current.as_ref(),
        lock(&m.focus).as_ref(),
        valid,
    );
    Ok(display::NetStatusResult {
        status,
        diagnostics,
    })
}

// ------------------------------------------------------------------
// Cross-module interface (FROZEN signatures; bodies owned by host-adapter).

/// Initialization script injected into every `acct-*` webview (the bundled
/// `ui/bundle/adapter/boot.js`, read from the embedded assets).
pub fn boot_script(app: &AppHandle) -> String {
    bundled_script(app, BOOT_SCRIPT_ASSET)
}

/// Initialization script of the built-in browser's tabs: only stops the official
/// page's tones from reaching the OS media session (`web-adapter/silence-tones.ts`).
pub fn tone_silencer_script(app: &AppHandle) -> String {
    bundled_script(app, TONE_SILENCER_ASSET)
}

fn bundled_script(app: &AppHandle, asset_path: &str) -> String {
    match app.asset_resolver().get(asset_path.to_string()) {
        Some(asset) => match String::from_utf8(asset.bytes().to_vec()) {
            Ok(s) => s,
            Err(_) => missing_script(&format!("{asset_path} is not UTF-8")),
        },
        None => missing_script(&format!("{asset_path} is missing from the bundle")),
    }
}

fn missing_script(reason: &str) -> String {
    log::warn!("web adapter disabled: {reason}");
    format!(
        "console.warn({});",
        serde_json::to_string(&format!("[vbk] web adapter disabled: {reason}")).unwrap_or_default()
    )
}

/// Sends `adapter://request` to the account's webview and awaits `adapter_reply`.
pub async fn request(
    app: &AppHandle,
    account: &contracts::AccountContext,
    op: &str,
    args: serde_json::Value,
    timeout: std::time::Duration,
) -> Result<serde_json::Value, AppError> {
    request_inner(app, account, op, args, timeout)
        .await
        .map_err(|f| f.error)
}

/// Drops display cache and pending requests of a removed / logged-out account.
pub fn on_account_removed(app: &AppHandle, account: &contracts::AccountContext) {
    login::adapter_account_removed(app, account);
    crate::clock_anchor::stop(app, account);
    let Ok(m) = module(app) else {
        return;
    };
    lock(&m.display).remove(account);
    lock(&m.pending).fail_account(account);
    let mut focus = lock(&m.focus);
    if focus.as_ref().is_some_and(|f| f == account) {
        *focus = None;
    }
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    #[test]
    fn bridge_fault_control_requires_reserved_stream_boot_epoch_and_sequence() {
        use serde_json::json;
        let value = json!({"account":{"account_id":"synthetic","environment":"production","session_generation":7},"stream":"im.transport","epoch":11,"seq":0,"fact":{"kind":"bridge_fault","fault":{"boot_epoch":11,"reason":"queue_overflow"}}});
        let valid: super::AdapterFactEnvelopeDto = serde_json::from_value(value.clone()).unwrap();
        assert!(super::validate_bridge_fault_control(&valid, 11).is_ok());
        for reason in ["queue_overflow", "delivery_failed"] {
            let mut control = value.clone();
            control["fact"]["fault"]["reason"] = json!(reason);
            let parsed: super::AdapterFactEnvelopeDto = serde_json::from_value(control).unwrap();
            let super::AdapterFactDto::BridgeFault { fault } = &parsed.fact else {
                panic!("expected host control")
            };
            assert_eq!(serde_json::to_value(&fault.reason).unwrap(), json!(reason));
            assert!(super::validate_bridge_fault_control(&parsed, fault.boot_epoch).is_ok());
        }
        for (field, changed) in [
            ("stream", json!("im.message")),
            ("epoch", json!(12)),
            ("seq", json!(1)),
        ] {
            let mut invalid = value.clone();
            invalid[field] = changed;
            let invalid: super::AdapterFactEnvelopeDto = serde_json::from_value(invalid).unwrap();
            assert!(super::validate_bridge_fault_control(&invalid, 11).is_err());
        }
        assert!(super::validate_bridge_fault_control(&valid, 0).is_err());
        let mut invalid = value;
        invalid["fact"]["fault"]["reason"] = json!("auth_invalid");
        assert!(serde_json::from_value::<super::AdapterFactEnvelopeDto>(invalid).is_err());
    }

    #[test]
    fn unwrap_arg_accepts_named_and_bare_payloads() {
        use serde_json::json;
        assert_eq!(
            super::unwrap_arg(json!({"payload": {"url": "u"}}), "payload"),
            json!({"url": "u"})
        );
        assert_eq!(
            super::unwrap_arg(json!({"envelope": {"epoch": 1}}), "envelope"),
            json!({"epoch": 1})
        );
        assert_eq!(
            super::unwrap_arg(json!({"url": "u"}), "payload"),
            json!({"url": "u"})
        );
        assert_eq!(
            super::unwrap_arg(json!({"payload": 1, "x": 2}), "payload"),
            json!({"payload": 1, "x": 2})
        );
    }

    use super::*;
    use contracts::{AccountId, Environment};

    #[test]
    fn translation_answers_are_limited_to_requested_ids_and_consistent_states() {
        let item =
            |id: &str, status: &str, translation: Option<&str>| display::UiMessageTranslationDto {
                message_id: id.into(),
                status: status.into(),
                translation: translation.map(str::to_string),
                source_kind: None,
                reason: None,
            };
        let requested = vec![
            "ok".to_string(),
            "none".to_string(),
            "bad".to_string(),
            "blank".to_string(),
            "leak".to_string(),
            "long".to_string(),
        ];
        let long = "字".repeat(MAX_TRANSLATION_CHARS + 1);
        let page = display::UiMessageTranslationsDto {
            items: vec![
                item("ok", "translated", Some("您好")),
                item("none", "not_needed", None),
                item("bad", "weird", None),
                item("blank", "translated", Some("  ")),
                item("leak", "not_needed", Some("不应出现")),
                item("long", "translated", Some(&long)),
                item("other", "translated", Some("未请求")),
            ],
            supplier: None,
            session_tag: None,
        };
        let kept: Vec<String> = accepted_translations(&requested, page)
            .items
            .into_iter()
            .map(|i| i.message_id)
            .collect();
        assert_eq!(kept, ["ok", "none"]);
    }

    #[test]
    fn translation_answer_log_counts_only_and_ignores_page_supplied_text() {
        let item = |status: &str, reason: Option<&str>| display::UiMessageTranslationDto {
            message_id: "secret-id".into(),
            status: status.into(),
            translation: Some("secret-body".into()),
            source_kind: None,
            reason: reason.map(str::to_string),
        };
        let page = |items, session_tag: Option<&str>| display::UiMessageTranslationsDto {
            items,
            supplier: None,
            session_tag: session_tag.map(str::to_string),
        };
        assert_eq!(
            translation_answer_log(&page(vec![item("translated", None)], None), 1, 0),
            None,
            "a plain success is not logged"
        );
        let line = translation_answer_log(
            &page(
                vec![
                    item("translated", Some("flagged")),
                    item("missing", Some("secret-reason")),
                ],
                Some("abcd1234"),
            ),
            2,
            1,
        )
        .expect("logged");
        assert_eq!(line, "im_translate_messages: requested=2 translated=1 echoes=1 not_needed=0 missing=1 unsupported=0 flagged=1 card=0 blank=0 no_row=0 option_off=0 session=abcd1234");
        let hostile = translation_answer_log(
            &page(vec![item("missing", None)], Some("secret-session")),
            1,
            0,
        )
        .expect("logged");
        assert!(hostile.ends_with("session=-"));
        assert!(!hostile.contains("secret"));
    }

    fn ctx(id: &str, gen: u64) -> AccountContext {
        AccountContext::new(AccountId::new(id), Environment::production(), gen)
    }

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }

    #[test]
    fn reply_completes_pending_request() {
        let mut t = PendingTable::default();
        let a = ctx("a", 1);
        let (id, rx) = t.insert(a.clone());
        t.complete(&a, &id, Ok(serde_json::json!({"x": 1})))
            .expect("complete");
        assert!(t.is_empty());
        let v = block_on(await_reply(rx, Duration::from_secs(1))).expect("reply");
        assert_eq!(v["x"], 1);
    }

    #[test]
    fn reply_from_other_account_or_generation_rejected() {
        let mut t = PendingTable::default();
        let (id, _rx) = t.insert(ctx("a", 2));
        let e = t
            .complete(&ctx("b", 2), &id, Ok(Value::Null))
            .expect_err("other account");
        assert!(e.is(codes::HOST_VIEW_UNAUTHORIZED));
        let e = t
            .complete(&ctx("a", 1), &id, Ok(Value::Null))
            .expect_err("stale gen");
        assert!(e.is(codes::HOST_VIEW_UNAUTHORIZED));
        assert_eq!(t.len(), 1);
        assert!(t.complete(&ctx("a", 2), "nope", Ok(Value::Null)).is_err());
    }

    #[test]
    fn request_times_out_and_send_becomes_unknown() {
        let mut t = PendingTable::default();
        let a = ctx("a", 1);
        let (id, rx) = t.insert(a.clone());
        let r = block_on(await_reply(rx, Duration::from_millis(30)));
        let f = r.as_ref().expect_err("timeout");
        assert!(f.error.is(codes::ADAPTER_TIMEOUT));
        assert!(f.emitted && !f.from_page);
        t.cancel(&id);
        // A late reply after the timeout is refused (request is gone), so
        // nothing is resent or double-counted.
        assert!(t.complete(&a, &id, Ok(Value::Null)).is_err());
        assert_eq!(
            send_outcome(r).expect("disposition"),
            SendDispositionDto::Unknown
        );
    }

    #[test]
    fn send_outcome_keeps_confirmed_rejected_unknown_apart() {
        let confirmed = send_outcome(Ok(serde_json::json!({
            "kind": "confirmed", "server_message_id": "m", "server_time_ms": 1
        })))
        .expect("ok");
        assert!(matches!(confirmed, SendDispositionDto::Confirmed { .. }));
        let rejected = send_outcome(Ok(serde_json::json!({
            "kind": "rejected", "code": "x", "reason": "y"
        })))
        .expect("ok");
        assert!(matches!(rejected, SendDispositionDto::Rejected { .. }));
        // Garbage reply after the page acted: unknown, not an error.
        assert_eq!(
            send_outcome(Ok(Value::Null)).expect("ok"),
            SendDispositionDto::Unknown
        );
        // Not delivered to the page at all: an error, nothing was sent.
        let e =
            send_outcome(Err(RequestFailure::before_emit(not_ready("x")))).expect_err("not sent");
        assert!(e.is(codes::ADAPTER_NOT_READY));
        // Page says it never sent: rejected.
        let r = send_outcome(Err(RequestFailure {
            error: AppError::new(codes::IM_PERMISSION_DENIED, "no"),
            emitted: true,
            from_page: true,
        }))
        .expect("ok");
        assert!(matches!(r, SendDispositionDto::Rejected { .. }));
        // Page threw something ambiguous: unknown.
        let u = send_outcome(Err(RequestFailure {
            error: AppError::new(codes::ADAPTER_FAILED, "boom"),
            emitted: true,
            from_page: true,
        }))
        .expect("ok");
        assert_eq!(u, SendDispositionDto::Unknown);
    }

    #[test]
    fn fail_account_cancels_only_that_identity() {
        let mut t = PendingTable::default();
        let (_a1, rx_a1) = t.insert(ctx("a", 1));
        let (_a3, _rx_a3) = t.insert(ctx("a", 3));
        let (_b, _rx_b) = t.insert(ctx("b", 1));
        t.fail_account(&ctx("a", 2));
        assert_eq!(t.len(), 2);
        let f = block_on(await_reply(rx_a1, Duration::from_secs(1))).expect_err("failed");
        assert!(f.error.is(codes::ADAPTER_NOT_READY));
        assert!(f.emitted && !f.from_page);
    }

    #[test]
    fn account_teardown_is_transport_loss_while_explicit_page_rejection_is_preserved() {
        let account = ctx("teardown", 1);
        let mut pending = PendingTable::default();
        let (cancelled, rx) = pending.insert(account.clone());
        pending.fail_account(&account);
        let failed = block_on(await_reply(rx, Duration::from_secs(1)));
        let failure = failed.as_ref().expect_err("host removed the page");
        assert!(failure.emitted && !failure.from_page);
        assert_eq!(send_outcome(failed).unwrap(), SendDispositionDto::Unknown);
        assert!(pending
            .complete(&account, &cancelled, Ok(Value::Null))
            .is_err());

        let (id, rx) = pending.insert(account.clone());
        pending
            .complete(&account, &id, Err(not_ready("page explicitly refused")))
            .unwrap();
        let page = block_on(await_reply(rx, Duration::from_secs(1)));
        assert!(page.as_ref().unwrap_err().from_page);
        assert!(matches!(
            send_outcome(page).unwrap(),
            SendDispositionDto::Rejected { .. }
        ));

        // A host failure before emit remains a local error, not a fabricated
        // upstream rejection or a claim that a request reached the page.
        let not_sent = RequestFailure::before_emit(not_ready("no page to emit to"));
        assert!(!not_sent.emitted && !not_sent.from_page);
        assert!(send_outcome(Err(not_sent))
            .unwrap_err()
            .is(codes::ADAPTER_NOT_READY));
    }

    #[test]
    fn production_dispatch_distinguishes_unemitted_failure_and_removed_emitted_page() {
        let account = ctx("dispatch", 1);
        let pending = Mutex::new(PendingTable::default());
        let unsent = block_on(dispatch_pending(
            &pending,
            &account,
            "im.send_text",
            Value::Null,
            Duration::from_secs(1),
            |_| false,
        ));
        let failure = unsent.as_ref().unwrap_err();
        assert!(!failure.emitted && !failure.from_page);
        assert!(send_outcome(unsent)
            .unwrap_err()
            .is(codes::ADAPTER_NOT_READY));
        assert!(lock(&pending).is_empty());

        let admitted = block_on(dispatch_pending(
            &pending,
            &account,
            "im.send_text",
            Value::Null,
            Duration::from_secs(1),
            |_| {
                lock(&pending).fail_account(&account);
                true
            },
        ));
        let failure = admitted.as_ref().unwrap_err();
        assert!(failure.emitted && !failure.from_page);
        assert_eq!(send_outcome(admitted).unwrap(), SendDispositionDto::Unknown);
        assert!(lock(&pending).is_empty());
    }

    #[test]
    fn emitted_send_cancelled_by_account_teardown_stays_unknown_and_never_replays_after_restart() {
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let root = Cleanup(
            std::env::temp_dir().join(format!("vbk-teardown-send-{}", uuid::Uuid::new_v4())),
        );
        let account = ctx("teardown-journal", 1);
        let payload = outbound_journal::SendPayload {
            gid: "selected-room".into(),
            text: "synthetic private body".into(),
            original: None,
            quote_id: None,
        };
        let journal = Mutex::new(outbound_journal::OutboundJournal::open(&root.0).unwrap());
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let outcome = block_on(outbound_journal::send_once(
            &journal,
            &account,
            "local-1",
            &payload,
            || async {
                calls.fetch_add(1, Ordering::SeqCst);
                let pending = Mutex::new(PendingTable::default());
                let failed = dispatch_pending(
                    &pending,
                    &account,
                    "im.send_text",
                    Value::Null,
                    Duration::from_secs(1),
                    |msg| {
                        assert_eq!(msg["op"], "im.send_text");
                        // on_account_removed takes this same host cancellation path
                        // after admission to the renderer, before any page answer.
                        lock(&pending).fail_account(&account);
                        true
                    },
                )
                .await;
                assert!(failed.as_ref().unwrap_err().emitted);
                assert!(!failed.as_ref().unwrap_err().from_page);
                assert!(lock(&pending).is_empty());
                send_outcome(failed)
            },
        ))
        .unwrap();
        assert_eq!(outcome, SendDispositionDto::Unknown);
        let rows = lock(&journal).unknown_metadata(&account).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].write_started);
        assert_eq!(rows[0].phase, "unknown");
        drop(journal);

        let recovered = Mutex::new(outbound_journal::OutboundJournal::open(&root.0).unwrap());
        let next_login = ctx("teardown-journal", 2);
        let replay = block_on(outbound_journal::send_once(
            &recovered,
            &next_login,
            "local-1",
            &payload,
            || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(SendDispositionDto::Rejected {
                    code: "must-not-dispatch".into(),
                    reason: String::new(),
                })
            },
        ))
        .unwrap();
        assert_eq!(replay, SendDispositionDto::Unknown);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            lock(&recovered)
                .unknown_metadata(&next_login)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn reply_payload_shapes() {
        let ok: ReplyPayload =
            serde_json::from_value(serde_json::json!({"req_id": "r", "ok": true, "data": [1]}))
                .expect("ok");
        assert!(ok.ok && ok.data.is_array());
        let err: ReplyPayload = serde_json::from_value(serde_json::json!({
            "req_id": "r", "ok": false, "error": {"code": "adapter.failed", "message": "m", "retryable": false}
        }))
        .expect("err");
        assert_eq!(err.error.map(|e| e.code).as_deref(), Some("adapter.failed"));
        let ready: ReadyPayload =
            serde_json::from_value(serde_json::json!({"url": "https://x", "sdk_version": null}))
                .expect("ready");
        assert!(ready.sdk_version.is_none());
    }
}

#[cfg(test)]
mod peripheral_tests {
    use super::*;
    use display::PeripheralWriteKindDto;

    #[test]
    fn explicit_page_not_submitted_survives_but_inconsistent_confirmation_stays_unknown() {
        let result = peripheral_write_outcome(Ok(serde_json::json!({
            "kind": "not_submitted", "confirmed": false, "reason": "missing real key"
        })))
        .expect("trusted page stage disposition");
        assert!(matches!(result.kind, PeripheralWriteKindDto::NotSubmitted));
        assert!(!result.confirmed);
        let bad = peripheral_write_outcome(Ok(serde_json::json!({
            "kind": "not_submitted", "confirmed": true
        })))
        .expect("inconsistent reply cannot release no-replay fence");
        assert!(matches!(bad.kind, PeripheralWriteKindDto::Unknown));
        assert!(!bad.confirmed);
    }

    #[test]
    fn missing_reply_after_peripheral_emit_is_unknown_and_never_retryable_success() {
        let out = peripheral_write_outcome(Err(RequestFailure {
            error: AppError::new(codes::ADAPTER_TIMEOUT, "timeout").retryable(),
            emitted: true,
            from_page: false,
        }))
        .expect("unknown disposition");
        assert!(matches!(out.kind, PeripheralWriteKindDto::Unknown));
        assert!(!out.confirmed);
        assert!(out.reason.unwrap().contains("do not resubmit"));
    }

    #[test]
    fn peripheral_pre_emit_and_page_rejections_remain_errors() {
        let before =
            peripheral_write_outcome(Err(RequestFailure::before_emit(not_ready("closed"))));
        assert_eq!(before.err().unwrap().code, codes::ADAPTER_NOT_READY);
        let page = peripheral_write_outcome(Err(RequestFailure {
            error: AppError::new(codes::HOST_UNSUPPORTED, "missing real key"),
            emitted: true,
            from_page: true,
        }));
        assert_eq!(page.err().unwrap().code, codes::HOST_UNSUPPORTED);
    }

    #[test]
    fn peripheral_reply_cannot_label_acceptance_or_unknown_as_confirmed() {
        for value in [
            serde_json::json!({"kind": "accepted", "confirmed": true}),
            serde_json::json!({"kind": "unknown", "confirmed": true}),
            serde_json::json!({"kind": "confirmed", "confirmed": false}),
            serde_json::json!({"unexpected": true}),
        ] {
            let result =
                peripheral_write_outcome(Ok(value)).expect("write outcome remains unknown");
            assert!(matches!(result.kind, PeripheralWriteKindDto::Unknown));
            assert!(!result.confirmed);
            assert!(result.reason.unwrap().contains("do not resubmit"));
        }
        let confirmed = peripheral_write_outcome(Ok(
            serde_json::json!({"kind": "confirmed", "confirmed": true}),
        ))
        .expect("confirmed");
        assert!(confirmed.confirmed);
    }

    #[test]
    fn recommend_products_default_all_city_ids_deserialize_and_forward_as_minus_one() {
        let input = serde_json::json!({"departure_city_id": -1, "destination_city_id": -1});
        let departure =
            serde_json::from_value::<Option<i64>>(input["departure_city_id"].clone()).unwrap();
        let destination =
            serde_json::from_value::<Option<i64>>(input["destination_city_id"].clone()).unwrap();
        let args =
            recommend_products_args("synthetic-room", "", departure, destination, 0).unwrap();
        assert_eq!(
            args,
            serde_json::json!({
                "gid": "synthetic-room", "query": "", "page_index": 0,
                "departure_city_id": -1, "destination_city_id": -1
            })
        );
        let omitted = recommend_products_args("synthetic-room", "", None, None, 0).unwrap();
        assert!(omitted.get("departure_city_id").is_none());
        assert!(omitted.get("destination_city_id").is_none());
    }

    #[test]
    fn recommend_products_city_ids_reject_invalid_range_without_forwarding() {
        for id in [-2, i64::MIN, 9_007_199_254_740_992, i64::MAX] {
            assert!(recommend_products_args("synthetic-room", "", Some(id), Some(-1), 0).is_err());
            assert!(recommend_products_args("synthetic-room", "", Some(-1), Some(id), 0).is_err());
        }
        for id in [-1, 0, 1, 9_007_199_254_740_991] {
            let args =
                recommend_products_args("synthetic-room", "city", Some(id), Some(id), 0).unwrap();
            assert_eq!(args["departure_city_id"], serde_json::json!(id));
            assert_eq!(args["destination_city_id"], serde_json::json!(id));
        }
        assert!(serde_json::from_value::<Option<i64>>(serde_json::json!(1.5)).is_err());
    }

    #[test]
    fn product_card_request_forwards_only_the_authorized_selection_and_product() {
        let intent = peripheral_journal::Intent {
            gid: "synthetic-room".into(),
            action: peripheral_journal::Action::ProductCard,
            targets: vec!["900719925474099312345".into()],
            selection_token: "synthetic-selection".into(),
        };
        let (op, args) = peripheral_request(&intent);
        assert_eq!(op, "im.send_product_card");
        assert_eq!(
            args,
            serde_json::json!({
                "gid": "synthetic-room",
                "selection_token": "synthetic-selection",
                "product_id": "900719925474099312345"
            })
        );
    }

    #[test]
    fn quick_reply_dto_preserves_ready_items_and_legacy_empty_unsupported() {
        let ready = serde_json::json!({"kind":"ready", "raw_count":1, "items":[{
            "id":"900719925474099312345", "content":"Synthetic response",
            "short_cut":"/synthetic", "type":"VAGENT"
        }]});
        let dto: display::UiCustomerScriptsDto = serde_json::from_value(ready.clone()).unwrap();
        assert!(matches!(dto.kind, display::CustomerScriptsKindDto::Ready));
        assert_eq!(serde_json::to_value(dto).unwrap(), ready);
        for kind in ["empty", "unsupported"] {
            let dto: display::UiCustomerScriptsDto =
                serde_json::from_value(serde_json::json!({"kind":kind, "raw_count":0})).unwrap();
            assert!(dto.items.is_empty());
        }
        for kind in ["VAGENT", "VSKILLGROUP"] {
            let dto: display::QuickReplyCategoryTypeDto =
                serde_json::from_value(serde_json::json!(kind)).unwrap();
            assert_eq!(serde_json::to_value(dto).unwrap(), serde_json::json!(kind));
        }
        assert!(
            serde_json::from_value::<display::QuickReplyCategoryTypeDto>(serde_json::json!(
                "unknown"
            ))
            .is_err()
        );
    }

    #[test]
    fn peripheral_member_ids_preserve_string_precision_and_require_eligibility() {
        let value = serde_json::json!({"members": [{"uid": "900719925474099312345", "nickname": null, "avatar": null, "status": "1", "roles": [0,3,4], "role": "agent", "present": true, "is_self": false, "can_transfer": true, "can_remove": true}], "self_is_master": true, "fetched_at_ms": 1700000000000i64, "selection_token": "selection", "expires_at_ms": 1700000030000i64});
        let dto: display::UiMembersDto = serde_json::from_value(value.clone()).expect("members");
        assert_eq!(dto.members[0].uid, "900719925474099312345");
        assert_eq!(serde_json::to_value(dto).unwrap(), value);
        let invalid = serde_json::json!({"uid": 9007199254740993u64, "nickname": null, "status": "1", "roles": [0,3,4], "can_transfer": true});
        assert!(serde_json::from_value::<display::UiMemberDto>(invalid).is_err());
    }
}

#[cfg(test)]
mod receive_diagnostic_tests {
    use super::*;
    use contracts::{AccountId, Environment};
    fn ctx(gen: u64) -> AccountContext {
        AccountContext::new(AccountId::new("synthetic"), Environment::production(), gen)
    }
    fn payload(gid: &str, message_gid: &str) -> DisplayPayload {
        serde_json::from_value(serde_json::json!({
        "kind":"messages", "gid":gid, "replace":false, "items":[{
            "gid":message_gid,"message_id":"synthetic-id","local_id":null,"create_time_ms":1700000000000u64,
            "sender_role":"customer","kind":"text","text":"synthetic private body","translation":null,"original":null,"quote":null,"order_id":null,"disposition":null
        }]
    })).unwrap()
    }

    #[test]
    fn actual_display_apply_boundary_counts_decode_mapping_rejection_and_changes_per_account_generation(
    ) {
        let m = AdapterState::new(PinnedTable::default());
        assert!(apply_display_diagnosed(
            &m,
            &ctx(1),
            Err(AppError::new(
                "adapter.invalid_payload",
                "synthetic private error"
            ))
        )
        .is_err());
        assert!(apply_display_diagnosed(&m, &ctx(1), Ok(payload("room-a", "room-b"))).is_err());
        assert!(apply_display_diagnosed(&m, &ctx(1), Ok(payload("room-a", "room-a"))).is_ok());
        let counters = lock(&m.receive).snapshot(&ctx(1));
        assert_eq!(counters.display_entered, 3);
        assert_eq!(counters.display_decode_rejected, 1);
        assert_eq!(counters.display_apply_rejected, 1);
        assert_eq!(counters.message_items, 2);
        assert_eq!(counters.changed_messages, 1);
        assert_eq!(lock(&m.receive).snapshot(&ctx(2)).display_entered, 0);
        let other = AccountContext::new(AccountId::new("other"), Environment::production(), 1);
        assert_eq!(lock(&m.receive).snapshot(&other).display_entered, 0);
        let encoded = serde_json::to_string(&counters).unwrap();
        for value in ["synthetic", "room-a", "private", "text", "message_id"] {
            assert!(!encoded.contains(value));
        }
    }

    fn page_json() -> Value {
        serde_json::json!({
            "version":1,"captured_at_ms":1700000000000u64,"running":true,"run_generation":1,"sdk":null,
            "session":{"received":0,"ui_mapped":0,"ui_dropped":0,"display_batches":0,"display_items":0,"display_resolved":0,"display_rejected":0},
            "compensation":{"running":true,"mode":"normal","cursor_ms":1700000000000u64,"last_outcome_ms":null,"outcomes":{"success":0,"business_failure":0,"auth_invalid":0,"http_error":0,"malformed":0,"network_error":0,"timeout":0,"unknown":0},"rows":0,"mapped":0,"dropped":0}
        })
    }

    #[test]
    fn page_diagnostic_schema_rejects_raw_fields_unknown_enums_and_unsafe_numbers() {
        assert!(display::PageReceiveDiagnosticsDto::decode(page_json()).is_some());
        let mut raw = page_json();
        raw["session"]["error"] = serde_json::json!("synthetic private body");
        assert!(display::PageReceiveDiagnosticsDto::decode(raw).is_none());
        let mut raw = page_json();
        raw["compensation"]["mode"] = serde_json::json!("synthetic-url");
        assert!(display::PageReceiveDiagnosticsDto::decode(raw).is_none());
        for number in [
            serde_json::json!(-1),
            serde_json::json!(1.5),
            serde_json::json!(9007199254740992u64),
        ] {
            let mut raw = page_json();
            raw["session"]["received"] = number;
            assert!(display::PageReceiveDiagnosticsDto::decode(raw).is_none());
        }
        let mut raw = page_json();
        raw["version"] = serde_json::json!(2);
        assert!(display::PageReceiveDiagnosticsDto::decode(raw).is_none());
    }

    #[test]
    fn diagnostics_are_explicitly_opted_in_and_failures_never_replace_cached_transport_or_echo_errors(
    ) {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let calls = AtomicUsize::new(0);
        let absent =
            tauri::async_runtime::block_on(diagnostics_if_requested(false, true, None, || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(page_json())
            }));
        assert!(absent.is_none());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let no_account =
            tauri::async_runtime::block_on(diagnostics_if_requested(true, false, None, || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(page_json())
            }))
            .unwrap();
        assert!(no_account.availability == display::DiagnosticAvailability::NoAccount);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let bad =
            tauri::async_runtime::block_on(diagnostics_if_requested(true, true, None, || async {
                Ok(serde_json::json!({"body":"synthetic private body"}))
            }))
            .unwrap();
        assert!(bad.availability == display::DiagnosticAvailability::Invalid);
        assert!(bad.page.is_none());
        let unavailable =
            tauri::async_runtime::block_on(diagnostics_if_requested(true, true, None, || async {
                Err(RequestFailure::before_emit(AppError::new(
                    "synthetic.error",
                    "synthetic private error",
                )))
            }))
            .unwrap();
        assert!(unavailable.availability == display::DiagnosticAvailability::Unavailable);
        let result = display::NetStatusResult {
            status: display::TransportDto::Connected.into(),
            diagnostics: Some(unavailable),
        };
        let value = serde_json::to_value(result).unwrap();
        assert_eq!(value["online"], true);
        assert_eq!(value["transport"], "connected");
        assert!(!value.to_string().contains("synthetic"));
    }

    #[test]
    fn diagnostic_rpc_timeout_uses_the_real_bounded_reply_wait_without_resetting_transport() {
        let start = std::time::Instant::now();
        let result =
            tauri::async_runtime::block_on(diagnostics_if_requested(true, true, None, || async {
                let (_hold, rx) = oneshot::channel::<Result<Value, AppError>>();
                await_reply(rx, DIAGNOSTIC_TIMEOUT).await
            }))
            .unwrap();
        assert!(result.availability == display::DiagnosticAvailability::Timeout);
        assert!(result.page.is_none());
        assert_eq!(DIAGNOSTIC_TIMEOUT, Duration::from_secs(2));
        assert!(start.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn delayed_diagnostic_reply_is_scrubbed_when_account_or_generation_changes() {
        for focus in [
            ctx(2),
            AccountContext::new(AccountId::new("other"), Environment::production(), 1),
        ] {
            let mut result = tauri::async_runtime::block_on(diagnostics_if_requested(
                true,
                true,
                Some(display::HostReceiveDiagnosticsDto::default()),
                || async { Ok(page_json()) },
            ));
            assert!(result.as_ref().unwrap().page.is_some());
            bind_diagnostic_result(&mut result, Some(&ctx(1)), Some(&focus), true);
            let result = result.unwrap();
            assert!(result.availability == display::DiagnosticAvailability::Unavailable);
            assert!(result.page.is_none());
            assert!(result.host.is_none());
        }
        let mut result =
            tauri::async_runtime::block_on(diagnostics_if_requested(true, true, None, || async {
                Ok(page_json())
            }));
        bind_diagnostic_result(&mut result, Some(&ctx(1)), Some(&ctx(1)), false);
        assert!(result.unwrap().page.is_none());
    }

    #[test]
    fn diagnostic_for_valid_account_a_cannot_steal_existing_valid_focus_b() {
        let state = HostState::new(None, 1);
        let login = |buid: &str| {
            let mut cores = state.lock();
            let attempt = cores.accounts.start_login(Environment::production());
            cores
                .accounts
                .publish_identity(
                    &attempt.attempt_id,
                    core_account::UpstreamIdentity {
                        buid: core_account::Buid::new(buid),
                        uid: format!("synthetic-{buid}"),
                        agent_id: None,
                        environment: Environment::production(),
                    },
                )
                .unwrap()
                .ctx
        };
        let a = login("a");
        let b = login("b");
        assert!(state.lock().accounts.validate(&a).is_ok());
        assert!(state.lock().accounts.validate(&b).is_ok());
        let m = AdapterState::new(PinnedTable::default());
        *lock(&m.focus) = Some(b.clone());
        let requested =
            diagnostic_account(&state, (&a).into()).expect("A is valid for a read-only diagnostic");
        assert_eq!(requested, a);
        assert_eq!(
            *lock(&m.focus),
            Some(b.clone()),
            "diagnostics must not record or restore UI focus"
        );
        let mut result =
            tauri::async_runtime::block_on(diagnostics_if_requested(true, true, None, || async {
                Ok(page_json())
            }));
        bind_diagnostic_result(&mut result, Some(&requested), lock(&m.focus).as_ref(), true);
        let result = result.unwrap();
        assert!(result.availability == display::DiagnosticAvailability::Unavailable);
        assert!(result.page.is_none());
        assert_eq!(*lock(&m.focus), Some(b));
    }
}

#[cfg(test)]
mod history_page_read_tests {
    use super::*;
    use contracts::Environment;

    #[test]
    fn actual_page_read_scope_keeps_another_valid_accounts_focus_and_rejects_invalid_generations() {
        let state = HostState::new(None, 1);
        let login = |buid: &str| {
            let mut cores = state.lock();
            let attempt = cores.accounts.start_login(Environment::production());
            cores
                .accounts
                .publish_identity(
                    &attempt.attempt_id,
                    core_account::UpstreamIdentity {
                        buid: core_account::Buid::new(buid),
                        uid: format!("synthetic-{buid}"),
                        agent_id: None,
                        environment: Environment::production(),
                    },
                )
                .unwrap()
                .ctx
        };
        let a = login("page-a");
        let b = login("page-b");
        let module = AdapterState::new(PinnedTable::default());
        *lock(&module.focus) = Some(b.clone());
        assert!(state.lock().accounts.validate(&a).is_ok());
        assert!(state.lock().accounts.validate(&b).is_ok());
        assert_eq!(read_account(&state, (&a).into()).unwrap(), a);
        assert_eq!(*lock(&module.focus), Some(b.clone()));
        let mut stale = AccountContextDto::from(&a);
        stale.session_generation += 1;
        assert!(read_account(&state, stale).is_err());
        assert_eq!(*lock(&module.focus), Some(b));
        // Tie this behavioral proof to the actual production command, rather
        // than a duplicate test-only authorization implementation.
        let source = include_str!("adapter.rs");
        let command = source
            .split("pub async fn im_message_page(")
            .nth(1)
            .unwrap()
            .split("#[tauri::command")
            .next()
            .unwrap();
        assert!(command.contains("read_account(&state, account)?"));
        assert!(!command.contains("ui_account("));
        let after_await = command.split(".await").nth(1).unwrap();
        assert!(after_await.contains("accounts.validate(&ctx)"));
    }
}

#[cfg(test)]
mod outbound_lookup_tests {
    use super::*;
    #[test]
    fn host_lookup_whitelists_identity_metadata_and_rejects_numeric_ids() {
        let raw = serde_json::json!({ "items": [{ "gid": "synthetic-room", "message_id": "900719925474099312345", "local_id": "synthetic-local", "sender_role": "merchant_self", "text": "SYNTHETIC PRIVATE BODY", "media_url": "https://example.invalid/private" }] });
        let response: OutboundLookupDto = serde_json::from_value(raw.clone()).unwrap();
        let returned = serde_json::to_value(response).unwrap();
        assert_eq!(returned["items"][0]["message_id"], "900719925474099312345");
        assert_eq!(returned["items"][0].as_object().unwrap().len(), 4);
        assert!(!returned.to_string().contains("PRIVATE"));
        assert!(!returned.to_string().contains("private"));
        let mut numeric = raw;
        numeric["items"][0]["message_id"] = serde_json::json!(9007199254740992_u64);
        assert!(serde_json::from_value::<OutboundLookupDto>(numeric).is_err());
    }
}

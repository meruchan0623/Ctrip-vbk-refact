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
use core_im::RoundState;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Emitter, Manager, State, Webview};
use tokio::sync::oneshot;

use crate::commands::IngestReportDto;
use crate::dto::{
    AccountContextDto, AdapterFactDto, AdapterFactEnvelopeDto, AppErrorDto, SendDispositionDto,
};
use crate::events;
use crate::login;
use crate::peripheral_journal;
use crate::state::HostState;

use display::{
    AgentStatusDto, DisplayCache, DisplayConversationDto, DisplayDelta, DisplayPayload,
    PinnedTable, UiAgentStatusDto, UiConversationDto, UiMessageDto, UiMessageEventDto,
    UiNetStatusDto, UiNoticeCategoryDto,
};

type CmdResult<T> = Result<T, AppErrorDto>;

/// `ADAPTER_READ_TIMEOUT_MS` (adapterProtocol.ts).
pub const READ_TIMEOUT: Duration = Duration::from_millis(15_000);
/// `ADAPTER_WRITE_TIMEOUT_MS` (adapterProtocol.ts).
pub const WRITE_TIMEOUT: Duration = Duration::from_millis(20_000);

const BOOT_SCRIPT_ASSET: &str = "adapter/boot.js";
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

    /// Fails every request of `ctx`'s identity at or below its generation.
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
            if let Some(e) = self.map.remove(&id) {
                let _ = e.tx.send(Err(not_ready("account was removed")));
            }
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
        }
    }
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

fn emit_agent_status(app: &AppHandle, ctx: &AccountContext, s: UiAgentStatusDto) {
    events::to_main(
        app,
        events::AGENT_STATUS,
        Scoped {
            inner: s,
            account: ctx.into(),
        },
    );
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
    let (req_id, rx) = lock(&m.pending).insert(account.clone());
    let msg = serde_json::json!({ "req_id": req_id, "op": op, "args": args });
    if app
        .emit_to(label.as_str(), events::ADAPTER_REQUEST, msg)
        .is_err()
    {
        lock(&m.pending).cancel(&req_id);
        return Err(RequestFailure::before_emit(not_ready(
            "could not reach the official page",
        )));
    }
    let result = await_reply(rx, timeout).await;
    if result.is_err() {
        lock(&m.pending).cancel(&req_id);
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

/// Read-only recovery seam for the UI's future reconciliation entry point.
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
    let account = caller(&app, &state, &webview, "adapter_ready")?;
    let _payload: ReadyPayload = body(&request, "payload").map_err(e2dto)?;
    let account = account.filter(|c| state.lock().accounts.validate(c).is_ok());
    let begin_msg_time = account
        .as_ref()
        .map(|c| state.compensation_watermark(c))
        .unwrap_or(0);
    let initial_epoch = module(&app)
        .map_err(e2dto)?
        .epoch
        .fetch_add(1, Ordering::SeqCst)
        + 1;
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
    Ok((&ctx).into())
}

#[tauri::command]
pub fn adapter_push_fact(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    request: Request<'_>,
) -> CmdResult<IngestReportDto> {
    let ctx = bound_caller(&app, &state, &webview, "adapter_push_fact")?;
    let mut envelope: AdapterFactEnvelopeDto = body(&request, "envelope").map_err(e2dto)?;
    let claimed: AccountContext = envelope.account.clone().into();
    if claimed != ctx {
        return Err(e2dto(unauthorized(
            "envelope account does not match the calling webview",
        )));
    }
    envelope.account = (&ctx).into();
    let gid = match &envelope.fact {
        AdapterFactDto::Message { fact } => Some(fact.gid.clone()),
        AdapterFactDto::Conversation { fact } => Some(fact.gid.clone()),
        _ => None,
    };
    let report = state.push_fact(envelope).map_err(e2dto)?;
    if report.auth_invalid {
        login::on_auth_invalid(&app, &ctx);
    }
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
    let payload: DisplayPayload = body(&request, "payload").map_err(e2dto)?;
    let m = module(&app).map_err(e2dto)?;
    let delta = lock(&m.display).apply(&ctx, payload).map_err(e2dto)?;
    match delta {
        DisplayDelta::Conversations { changed, removed } => {
            emit_conversations(&app, &ctx, &changed);
            if !changed.is_empty() || !removed.is_empty() {
                sync_unread(&app, &ctx);
            }
        }
        DisplayDelta::Messages { changed, .. } => {
            let account = AccountContextDto::from(&ctx);
            for message in &changed {
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
        DisplayDelta::AgentStatus(s) => emit_agent_status(&app, &ctx, s),
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
    let m = module(&app).map_err(e2dto)?;
    match forward::<UiAgentStatusDto>(
        &app,
        &ctx,
        "agent.status",
        serde_json::json!({}),
        READ_TIMEOUT,
    )
    .await
    {
        Ok(s) => {
            let _ = lock(&m.display).set_agent_status(&ctx, s);
            Ok(s)
        }
        Err(e) => lock(&m.display).agent_status(&ctx).ok_or_else(|| e2dto(e)),
    }
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
    let m = module(&app).map_err(e2dto)?;
    let _ = lock(&m.display).set_agent_status(&ctx, s);
    emit_agent_status(&app, &ctx, s);
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
    if let Some(cached) = lock(&m.display).messages(&ctx, &gid).map_err(e2dto)? {
        return Ok(cached);
    }
    let items: Vec<UiMessageDto> = forward(
        &app,
        &ctx,
        "im.messages",
        serde_json::json!({ "gid": gid }),
        READ_TIMEOUT,
    )
    .await
    .map_err(e2dto)?;
    let r = lock(&m.display).replace_thread(&ctx, &gid, items);
    r.map_err(e2dto)
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
    let payload = outbound_journal::SendPayload {
        gid,
        text,
        original,
        quote_id,
    };
    outbound_journal::send_once(journal, &ctx, &local_id, &payload, || async {
        let result = request_inner(&app, &ctx, "im.send_text", args, WRITE_TIMEOUT).await;
        send_outcome(result)
    })
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
) -> CmdResult<()> {
    guard(&state, webview.label(), "im_mark_read")?;
    let ctx = ui_account(&app, &state, account)?;
    request(
        &app,
        &ctx,
        "im.mark_read",
        serde_json::json!({ "gid": gid }),
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
pub async fn im_invite_candidates(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
    gid: String,
    parent_skill_group_ids: Option<Vec<u64>>,
) -> CmdResult<display::UiInviteCandidatesDto> {
    guard(&state, webview.label(), "im_invite_candidates")?;
    let ctx = ui_account(&app, &state, account)?;
    let mut args = serde_json::json!({"gid": gid});
    if let Some(ids) = parent_skill_group_ids {
        args["parent_skill_group_ids"] = serde_json::json!(ids);
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

/// All three production commands cross this durable admission boundary before
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
        AppError::new("im.peripheral_journal_unavailable", "durable peripheral storage unavailable; nothing submitted")
    })?;
    peripheral_journal::dispatch_once(journal, ctx, intent, || async {
        let (op, args) = match intent.action {
            peripheral_journal::Action::Invite => ("im.invite", serde_json::json!({ "gid": intent.gid, "selection_token": intent.selection_token, "target_uids": intent.targets })),
            peripheral_journal::Action::Transfer => ("im.transfer", serde_json::json!({ "gid": intent.gid, "selection_token": intent.selection_token, "target_uid": intent.targets.first() })),
            peripheral_journal::Action::Finish => ("im.finish", serde_json::json!({ "gid": intent.gid, "selection_token": intent.selection_token })),
        };
        let result = request_inner(app, ctx, op, args, WRITE_TIMEOUT).await;
        state.lock().accounts.validate(ctx)?;
        peripheral_write_outcome(result)
    }).await
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
    let result = request_peripheral_once(&app, &state, &ctx, &peripheral_journal::Intent { gid, action: peripheral_journal::Action::Invite, targets: target_uids, selection_token }).await;
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
    let result = request_peripheral_once(&app, &state, &ctx, &peripheral_journal::Intent { gid, action: peripheral_journal::Action::Transfer, targets: vec![target_uid], selection_token }).await;
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
    let result = request_peripheral_once(&app, &state, &ctx, &peripheral_journal::Intent { gid, action: peripheral_journal::Action::Finish, targets: vec![], selection_token }).await;
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
        Err(e) => {
            let cached = lock(&m.display).notice_categories(&ctx);
            if cached.is_empty() {
                Err(e2dto(e))
            } else {
                Ok(cached)
            }
        }
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
) -> CmdResult<Vec<UiNoticeDto>> {
    guard(&state, webview.label(), "notice_list")?;
    let ctx = ui_account(&app, &state, account)?;
    forward(
        &app,
        &ctx,
        "notice.list",
        serde_json::json!({ "category_id": category_id }),
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

#[tauri::command]
pub fn net_status(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
) -> CmdResult<UiNetStatusDto> {
    guard(&state, webview.label(), "net_status")?;
    let m = module(&app).map_err(e2dto)?;
    let focus = lock(&m.focus).clone();
    let cache = lock(&m.display);
    if let Some(ctx) = focus {
        return Ok(cache
            .transport(&ctx)
            .map(UiNetStatusDto::from)
            .unwrap_or_else(UiNetStatusDto::offline));
    }
    // No account addressed yet: report the best transport of any account.
    let all = cache.transports();
    let best = all
        .iter()
        .find(|t| t.3 == display::TransportDto::Connected)
        .or_else(|| all.first());
    Ok(best
        .map(|t| UiNetStatusDto::from(t.3))
        .unwrap_or_else(UiNetStatusDto::offline))
}

// ------------------------------------------------------------------
// Cross-module interface (FROZEN signatures; bodies owned by host-adapter).

/// Initialization script injected into every `acct-*` webview (the bundled
/// `ui/bundle/adapter/boot.js`, read from the embedded assets).
pub fn boot_script(app: &AppHandle) -> String {
    match app.asset_resolver().get(BOOT_SCRIPT_ASSET.to_string()) {
        Some(asset) => match String::from_utf8(asset.bytes().to_vec()) {
            Ok(s) => s,
            Err(_) => missing_boot_script("adapter/boot.js is not UTF-8"),
        },
        None => missing_boot_script("adapter/boot.js is missing from the bundle"),
    }
}

fn missing_boot_script(reason: &str) -> String {
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
    let Ok(m) = module(app) else {
        return;
    };
    lock(&m.display).remove(account);
    lock(&m.pending).fail_account(account);
    let mut focus = lock(&m.focus);
    if focus
        .as_ref()
        .is_some_and(|f| f.persistent_key() == account.persistent_key())
    {
        *focus = None;
    }
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
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
        }))).expect("trusted page stage disposition");
        assert!(matches!(result.kind, PeripheralWriteKindDto::NotSubmitted));
        assert!(!result.confirmed);
        let bad = peripheral_write_outcome(Ok(serde_json::json!({
            "kind": "not_submitted", "confirmed": true
        }))).expect("inconsistent reply cannot release no-replay fence");
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
    fn peripheral_member_ids_preserve_string_precision_and_require_eligibility() {
        let value = serde_json::json!({"members": [{"uid": "900719925474099312345", "nickname": null, "avatar": null, "status": "1", "roles": [0,3,4], "can_transfer": true}], "fetched_at_ms": 1700000000000i64, "selection_token": "selection", "expires_at_ms": 1700000030000i64});
        let dto: display::UiMembersDto = serde_json::from_value(value.clone()).expect("members");
        assert_eq!(dto.members[0].uid, "900719925474099312345");
        assert_eq!(serde_json::to_value(dto).unwrap(), value);
        let invalid = serde_json::json!({"uid": 9007199254740993u64, "nickname": null, "status": "1", "roles": [0,3,4], "can_transfer": true});
        assert!(serde_json::from_value::<display::UiMemberDto>(invalid).is_err());
    }
}

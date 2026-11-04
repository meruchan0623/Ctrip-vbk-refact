//! Account lifecycle: login window, per-account profile webviews, identity
//! publication, account snapshot in UI shape, logout modes, keychain.
//!
//! Owner: host-login (plan M2, ACC-02/04/05, D2, D6).
//!
//! Flow (D6):
//! 1. `account_start_login` → `core-account::start_login` gives an attempt
//!    and a fresh `profile_id`; the `login` window hosts the local header
//!    (`login`) and the official login page (`login-remote-<attempt>`) in
//!    that profile. No script is injected into the login page and it is not
//!    registered in the `ViewRegistry`.
//! 2. When the login page leaves the official account pages for another
//!    vbooking page, a hidden `acct-<profile_id>` window (same profile, boot
//!    script) loads the official IM page and the login window is hidden.
//! 3. The adapter in that page reads the identity and calls
//!    `adapter_identity` → [`on_identity`] → `publish_identity`; the login
//!    window is destroyed and `account://changed` is emitted.
//!
//! Module state (bindings, display metadata, active account, unread) lives
//! in [`LoginState`]; account truth stays in `Cores.accounts`. Lock order:
//! `HostState` before `LoginState`, never the other way round.

#[path = "keychain.rs"]
mod keychain;
#[path = "profiles.rs"]
pub(crate) mod profiles;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use contracts::{codes, AccountContext, AccountId, AppError, Environment, ViewContext};
use core_account::{
    AccountRegistry, AccountStateKind, AttemptId, Buid, CredentialAction, LogoutMode, RevokeList,
    Secret, SecretStore, UpstreamIdentity,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Rect, State, Url, WebviewBuilder, WebviewUrl,
    Window,
};

use crate::data_guard::IndexLoad;
use crate::dto::{AccountContextDto, AppErrorDto, BridgeFaultReason};
use crate::events;
use crate::state::HostState;
use crate::views;

use keychain::KeychainStore;
use profiles::ProfileWindow;

type CmdResult<T> = Result<T, AppErrorDto>;

/// Hard cap on accounts (UI shows it as `max_accounts`).
pub const MAX_ACCOUNTS: usize = 16;
/// Avatar palette of the prototype account tabs.
const AVATAR_COLORS: &[&str] = &["#3D7BE0", "#8A5CD6", "#E07A2E", "#2F8A7A", "#5A7FA8"];
/// How long a hidden candidate webview may take to report the identity
/// before the login window is shown again.
const IDENTITY_TIMEOUT: Duration = Duration::from_secs(45);
const ACCOUNTS_FILE: &str = "accounts.json";
const REMARK_MAX_CHARS: usize = 32;

fn guard(state: &HostState, window: &Window, command: &str) -> CmdResult<()> {
    state
        .authorize(window.label(), command)
        .map_err(AppErrorDto::from)
}

fn guard_app(app: &AppHandle, window: &Window, command: &str) -> CmdResult<()> {
    guard(&app.state::<HostState>(), window, command)
}

fn app_err(code: &str, message: impl Into<String>) -> AppError {
    AppError::new(code, message)
}

// ------------------------------------------------------------------ state

/// What an `acct-*` webview currently serves.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Binding {
    /// Candidate page of a login attempt (identity not yet published).
    Attempt(String),
    /// Page of a published account.
    Account(String),
}

#[derive(Debug, Clone)]
struct AttemptRec {
    profile_id: String,
    /// Concrete runtime window owned by this attempt, never resolved by label.
    login_window: Option<Window>,
    /// The login page reached a non-login page and a hidden candidate
    /// account webview is waiting for the identity.
    candidate: bool,
    /// Cookie import owns this attempt until the complete store is verified.
    importing: bool,
    browser_imported: bool,
}

/// Host-side display metadata of an account (no secret, no customer data).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct AccountMeta {
    /// Runtime-only person data; signed avatar URLs never enter account persistence.
    #[serde(skip)]
    self_profile: Option<PersonProfileDto>,
    nick: String,
    party: String,
    color: String,
    /// Web profile currently bound to the account (None after logout).
    profile_id: Option<String>,
    /// Explicit exit-online or overload pause: never resumed automatically at startup.
    #[serde(default)]
    suspended_by_user: bool,
}

/// The latest READY of one actual registered adapter resource. Stream epochs
/// may advance independently; only this fixed boot epoch admits queue failure.
#[derive(Debug, Clone)]
struct AdapterReadyLease {
    account: AccountContext,
    view: ViewContext,
    boot_epoch: u64,
}

#[derive(Debug, Default)]
struct Inner {
    bindings: HashMap<String, Binding>,
    /// Detached adapter instances may still be alive until native destruction
    /// completes. Never reauthorize the same retiring instance on quick resume.
    retiring_views: HashSet<String>,
    adapter_ready: HashMap<String, AdapterReadyLease>,
    attempts: BTreeMap<String, AttemptRec>,
    meta: BTreeMap<String, AccountMeta>,
    /// Accounts whose page is loading with a kept profile and has not
    /// reported its identity yet (shown as `logging_in`).
    validating: HashSet<String>,
    unread: HashMap<String, u32>,
    active: Option<String>,
}

pub struct LoginState {
    inner: Mutex<Inner>,
    // Acquired before taking either state lock; held through the atomic rename.
    persist_lock: Mutex<()>,
    // Serializes the complete check/create/open sequence for new attempts.
    start_lock: Mutex<()>,
    // start_lock (when needed) -> lifecycle_lock -> outbound -> HostState -> inner.
    // Never hold lifecycle_lock while opening/destroying native windows.
    lifecycle_lock: Mutex<()>,
    restoring: AtomicBool,
    // Monotonic visit identity, including switching away and back to the same account.
    active_visit_epoch: AtomicU64,
    data_dir: PathBuf,
}

// Keep new login attempts out until registry replacement and orphan cleanup finish.
// Drop also releases the gate if the background restore thread unwinds.
struct RestoreCompletion<'a>(&'a AtomicBool);

impl Drop for RestoreCompletion<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl LoginState {
    /// Called only for an authorized account switch, while `inner` is locked.
    fn set_active_for_visit(&self, inner: &mut Inner, id: String) {
        if inner.active.as_deref() != Some(id.as_str()) {
            inner.active = Some(id);
            self.active_visit_epoch.fetch_add(1, Ordering::AcqRel);
        }
    }

    fn ensure_ready(&self) -> Result<(), AppError> {
        if self.restoring.load(Ordering::Acquire) {
            return Err(app_err(
                core_account::codes::ACCOUNT_INVALID_STATE,
                "account restoration is in progress; retry login shortly",
            )
            .retryable());
        }
        Ok(())
    }

    fn lifecycle(&self) -> MutexGuard<'_, ()> {
        self.lifecycle_lock
            .lock()
            .unwrap_or_else(|p| p.into_inner())
    }

    fn with_start<T>(&self, start: impl FnOnce() -> T) -> T {
        let _start = self.start_lock.lock().unwrap_or_else(|p| p.into_inner());
        start()
    }

    fn persist_snapshot(
        &self,
        snapshot: impl FnOnce() -> std::io::Result<PersistDoc>,
    ) -> std::io::Result<()> {
        let _write = self.persist_lock.lock().unwrap_or_else(|p| p.into_inner());
        // Snapshot only after serialization: an older caller cannot overwrite
        // a newer snapshot merely because its disk write was delayed.
        write_atomic(&self.data_dir.join(ACCOUNTS_FILE), &snapshot()?)
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        match self.inner.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        }
    }
}

fn login_state(app: &AppHandle) -> tauri::State<'_, LoginState> {
    app.state::<LoginState>()
}

#[derive(Debug, Serialize, Deserialize)]
struct PersistDoc {
    version: u32,
    active_account_id: Option<String>,
    accounts: BTreeMap<String, AccountMeta>,
    /// `AccountRegistry::to_json` (identity index, credential ledger refs,
    /// account rows). Non-secret.
    registry: serde_json::Value,
}

fn color_for(id: &str) -> String {
    let mut h: u32 = 0x811c_9dc5;
    for b in id.bytes() {
        h ^= u32::from(b);
        h = h.wrapping_mul(0x0100_0193);
    }
    AVATAR_COLORS[(h as usize) % AVATAR_COLORS.len()].to_string()
}

// ------------------------------------------------------------ persistence

fn persist(app: &AppHandle) {
    let result = persist_checked(app);
    if let Err(e) = result {
        log::warn!("account index not persisted: {e}");
        events::toast(app, "账号信息保存失败，请检查磁盘空间或权限后重试");
    }
}

fn persist_checked(app: &AppHandle) -> std::io::Result<()> {
    let ls = login_state(app);
    ls.persist_snapshot(|| {
        let host = app.state::<HostState>();
        let cores = host.lock();
        let inner = ls.lock();
        // HostState before LoginState; both halves are captured together.
        let registry = serde_json::from_str(&cores.accounts.to_json().to_json())
            .map_err(std::io::Error::other)?;
        Ok(PersistDoc {
            version: PERSIST_VERSION,
            active_account_id: inner.active.clone(),
            accounts: inner.meta.clone(),
            registry,
        })
    })
}

fn write_atomic(path: &Path, doc: &PersistDoc) -> std::io::Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| std::io::Error::other("missing account directory"))?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| std::io::Error::other("invalid account filename"))?;
    let text = serde_json::to_vec_pretty(doc).map_err(std::io::Error::other)?;
    core_store::write_atomic(dir, name, &text).map_err(std::io::Error::other)
}

/// Highest `PersistDoc::version` this build writes and understands.
const PERSIST_VERSION: u32 = 1;

/// 读取账号索引。读不出、解析失败或版本更新时返回 `Untrusted` 并先把原文件
/// 留底：之后的 `persist` 会重写 `accounts.json`，备份保证旧索引还能找回；
/// 调用方据此跳过孤儿 profile 清理（见 `data_guard::may_purge_orphans`）。
fn load_doc(path: &Path) -> (IndexLoad, Option<PersistDoc>) {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return (IndexLoad::Absent, None),
        Err(e) => {
            log::error!("{}: account index not readable: {e}", path.display());
            crate::data_guard::preserve_unreadable(path);
            return (IndexLoad::Untrusted, None);
        }
    };
    match serde_json::from_str::<PersistDoc>(&text) {
        Ok(d) if d.version <= PERSIST_VERSION => (IndexLoad::Restored, Some(d)),
        Ok(d) => {
            log::error!(
                "{}: account index version {} is newer than {PERSIST_VERSION}; preserved, not restored",
                path.display(),
                d.version
            );
            crate::data_guard::preserve_unreadable(path);
            (IndexLoad::Untrusted, None)
        }
        Err(e) => {
            log::error!("{}: unreadable account index: {e}", path.display());
            crate::data_guard::preserve_unreadable(path);
            (IndexLoad::Untrusted, None)
        }
    }
}

// --------------------------------------------------------------- snapshot

fn ui_state(kind: AccountStateKind, validating: bool) -> &'static str {
    match kind {
        AccountStateKind::Online => "online",
        AccountStateKind::LoginPending => "logging_in",
        _ if validating => "logging_in",
        AccountStateKind::Suspended => "suspended",
        AccountStateKind::Invalid | AccountStateKind::LoggedOut => "expired",
    }
}

/// `UiAccountSnapshot`.
fn snapshot(app: &AppHandle) -> serde_json::Value {
    let (rows, persist_failed) = {
        let host = app.state::<HostState>();
        let cores = host.lock();
        let rows: Vec<(core_account::AccountSummary, u64)> = cores
            .accounts
            .account_snapshot()
            .data
            .accounts
            .into_iter()
            .map(|s| {
                let last = cores
                    .accounts
                    .index()
                    .entry_for(&s.account_id)
                    .map(|e| e.last_generation)
                    .unwrap_or(0);
                (s, last)
            })
            .collect();
        // Tracker state as of the last receipt drain (scheduler tick / send
        // barrier); the scheduler re-emits this snapshot when it flips.
        (rows, cores.persist.persist_failed())
    };
    let ls = login_state(app);
    let inner = ls.lock();
    let mut accounts = Vec::with_capacity(rows.len() + inner.attempts.len());
    for (s, last_gen) in &rows {
        let id = s.account_id.as_str();
        let meta = inner.meta.get(id);
        accounts.push(json!({
            "context": {
                "account_id": id,
                "environment": s.environment.as_str(),
                "session_generation": s.session_generation.unwrap_or(*last_gen),
            },
            "self_profile": meta.and_then(|m| m.self_profile.as_ref()).filter(|_| matches!(s.state, AccountStateKind::Online)),
            "nick": meta.map(|m| m.nick.as_str()).filter(|n| !n.is_empty()).unwrap_or("账号"),
            "remark": s.remark,
            "party": meta.map(|m| m.party.as_str()).unwrap_or(""),
            "color": meta.map(|m| m.color.clone()).unwrap_or_else(|| color_for(id)),
            "state": ui_state(s.state, inner.validating.contains(id)),
            "unread": inner.unread.get(id).copied().unwrap_or(0),
        }));
    }
    for attempt_id in inner.attempts.keys() {
        // The login header resolves its attempt from this entry: the
        // attempt id doubles as the account id of a `logging_in` row.
        accounts.push(json!({
            "context": {
                "account_id": attempt_id,
                "environment": Environment::PRODUCTION,
                "session_generation": 0,
            },
            "self_profile": null,
            "nick": "正在登录",
            "remark": null,
            "party": "",
            "color": color_for(attempt_id),
            "state": "logging_in",
            "unread": 0,
        }));
    }
    let active = inner
        .active
        .clone()
        .filter(|a| rows.iter().any(|(s, _)| s.account_id.as_str() == a));
    json!({
        "accounts": accounts,
        "active_account_id": active,
        "max_accounts": MAX_ACCOUNTS,
        "persist_failed": persist_failed,
    })
}

/// Captured around async native actions so an A → B → A account visit cannot revive an old action.
pub(crate) fn active_visit_epoch(app: &AppHandle) -> Option<u64> {
    Some(
        app.try_state::<LoginState>()?
            .active_visit_epoch
            .load(Ordering::Acquire),
    )
}

/// Read only active-owner authority for local assistant windows. Never hold
/// LoginState and HostState locks together (snapshot uses the opposite order).
pub(crate) fn active_context(app: &AppHandle) -> Option<AccountContext> {
    let state = app.try_state::<LoginState>()?;
    let active = { state.lock().active.clone() }?;
    let context = {
        let host = app.state::<HostState>();
        let cores = host.lock();
        let context = cores
            .accounts
            .current_context(&AccountId::new(active.clone()))?;
        cores.accounts.validate(&context).ok()?;
        context
    };
    if state.lock().active.as_deref() != Some(active.as_str()) {
        return None;
    }
    Some(context)
}

pub(crate) fn emit_changed(app: &AppHandle) {
    events::to_local_windows(app, events::ACCOUNT_CHANGED, snapshot(app));
}

fn persist_and_emit(app: &AppHandle) {
    persist(app);
    emit_changed(app);
}

// ------------------------------------------------------------- validation

/// Checks a UI-supplied context against the registry and returns the
/// account's current context (any state). Older generations are rejected.
fn check_account(app: &AppHandle, dto: &AccountContextDto) -> Result<AccountContext, AppError> {
    let host = app.state::<HostState>();
    let cores = host.lock();
    let id = AccountId::new(dto.account_id.clone());
    let state = cores
        .accounts
        .state(&id)
        .ok_or_else(|| app_err(codes::ACCOUNT_UNKNOWN, "unknown account"))?;
    let entry = cores
        .accounts
        .index()
        .entry_for(&id)
        .ok_or_else(|| app_err(codes::ACCOUNT_UNKNOWN, "unknown account"))?;
    if entry.environment.as_str() != dto.environment {
        return Err(app_err(
            codes::ACCOUNT_UNKNOWN,
            "environment does not match account",
        ));
    }
    let current = state
        .context()
        .map(|c| c.session_generation)
        .unwrap_or(entry.last_generation);
    if dto.session_generation < current {
        return Err(app_err(
            codes::ACCOUNT_STALE_GENERATION,
            format!(
                "generation {} is older than {current}",
                dto.session_generation
            ),
        ));
    }
    if dto.session_generation > current {
        return Err(app_err(
            codes::ACCOUNT_UNKNOWN,
            "generation was never issued",
        ));
    }
    Ok(AccountContext::new(id, entry.environment.clone(), current))
}

// ---------------------------------------------------------- login window

fn login_window(app: &AppHandle) -> Option<Window> {
    app.get_window(views::LOGIN)
}

fn destroy_login_window(app: &AppHandle) {
    if let Some(w) = login_window(app) {
        let _ = w.destroy();
    }
}

fn layout_login(app: &AppHandle, window: &Window, attempt_id: &str) {
    let (Ok(size), Ok(scale)) = (window.inner_size(), window.scale_factor()) else {
        return;
    };
    let size = size.to_logical::<f64>(scale);
    let header_h = profiles::LOGIN_HEADER_HEIGHT.min(size.height);
    if let Some(header) = app.get_webview(views::LOGIN) {
        let _ = header.set_bounds(Rect {
            position: LogicalPosition::new(0.0, 0.0).into(),
            size: LogicalSize::new(size.width, header_h).into(),
        });
    }
    if let Some(remote) = app.get_webview(&profiles::login_remote_label(attempt_id)) {
        let _ = remote.set_bounds(Rect {
            position: LogicalPosition::new(0.0, header_h).into(),
            size: LogicalSize::new(size.width, (size.height - header_h).max(0.0)).into(),
        });
    }
}

/// Creates the login window: local header on top, official login page in
/// the attempt's profile below. Must not run on the main thread
/// (`add_child` blocks on it).
fn open_login_window(
    app: &AppHandle,
    attempt_id: &str,
    profile_id: &str,
    auto_browser: bool,
) -> tauri::Result<()> {
    destroy_login_window(app);
    let builder = tauri::window::WindowBuilder::new(app, views::LOGIN)
        .title("登录 VBooking")
        .inner_size(profiles::LOGIN_WIDTH, profiles::LOGIN_HEIGHT)
        .min_inner_size(profiles::LOGIN_MIN_WIDTH, profiles::LOGIN_MIN_HEIGHT)
        .resizable(true)
        .center()
        .visible(true)
        .focused(true);
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(false);
    let window = builder.build()?;
    {
        let ls = login_state(app);
        let mut inner = ls.lock();
        let Some(rec) = inner.attempts.get_mut(attempt_id) else {
            // Cancellation may have won while the native window was opening.
            // Destroy this runtime object, never whichever window now has its label.
            drop(inner);
            let _ = window.destroy();
            return Err(tauri::Error::Io(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "login attempt was cancelled while opening its window",
            )));
        };
        rec.login_window = Some(window.clone());
    }

    let size = window
        .inner_size()?
        .to_logical::<f64>(window.scale_factor()?);
    let header_h = profiles::LOGIN_HEADER_HEIGHT;

    // The header is built from a WindowConfig because that is the only
    // public way to give a child webview the macOS traffic-light inset.
    let header_cfg = tauri::utils::config::WindowConfig {
        label: views::LOGIN.to_string(),
        url: WebviewUrl::App(
            format!(
                "apps/login/index.html?attempt={attempt_id}&browser={}",
                if auto_browser { "auto" } else { "manual" }
            )
            .into(),
        ),
        #[cfg(target_os = "macos")]
        traffic_light_position: Some(tauri::utils::config::LogicalPosition { x: 14.0, y: 14.0 }),
        ..Default::default()
    };
    {
        let host = app.state::<HostState>();
        host.lock().views.register(views::LOGIN);
    }
    window.add_child(
        WebviewBuilder::from_config(&header_cfg),
        LogicalPosition::new(0.0, 0.0),
        LogicalSize::new(size.width, header_h),
    )?;

    let login_url = Url::parse(core_net::url::LOGIN_PAGE_URL).map_err(tauri::Error::InvalidUrl)?;
    let nav_app = app.clone();
    let nav_attempt = attempt_id.to_string();
    let remote = WebviewBuilder::new(
        profiles::login_remote_label(attempt_id),
        WebviewUrl::External(login_url),
    )
    .on_navigation(move |url| {
        if !profiles::allowed_navigation(url) {
            return false;
        }
        if profiles::is_login_complete_candidate(url) {
            let app = nav_app.clone();
            let attempt = nav_attempt.clone();
            tauri::async_runtime::spawn(async move { on_login_candidate(&app, &attempt) });
        }
        true
    });
    let remote = profiles::isolate!(remote, app, profile_id);
    window.add_child(
        remote,
        LogicalPosition::new(0.0, header_h),
        LogicalSize::new(size.width, (size.height - header_h).max(0.0)),
    )?;

    let ev_app = app.clone();
    let ev_window = window.clone();
    let ev_attempt = attempt_id.to_string();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. } => {
            layout_login(&ev_app, &ev_window, &ev_attempt);
        }
        // Programmatic teardown uses `destroy()`, which skips this event,
        // so CloseRequested is always the user closing the window.
        tauri::WindowEvent::CloseRequested { .. } => {
            let app = ev_app.clone();
            let attempt = ev_attempt.clone();
            tauri::async_runtime::spawn(async move { cancel_attempt(&app, &attempt) });
        }
        _ => {}
    });
    Ok(())
}

/// Login page reached a non-login vbooking page: open the hidden candidate
/// account webview in the same profile and hide the login window.
fn on_login_candidate(app: &AppHandle, attempt_id: &str) {
    if !begin_candidate(app, attempt_id) {
        return;
    }
    log::info!("attempt {attempt_id}: login page left, waiting for identity");
    let app = app.clone();
    let attempt = attempt_id.to_string();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(IDENTITY_TIMEOUT).await;
        let still_waiting = login_state(&app)
            .lock()
            .attempts
            .get(&attempt)
            .is_some_and(|r| r.candidate);
        if still_waiting {
            log::warn!("attempt {attempt}: identity not reported in time");
            if login_state(&app)
                .lock()
                .attempts
                .get(&attempt)
                .is_some_and(|r| r.browser_imported)
            {
                cancel_attempt(&app, &attempt);
                let _ = start_login_with_browser(&app, false);
                events::toast(&app, "浏览器登录态未通过核验，请使用官方登录页");
                return;
            }
            if let Some(w) = login_window(&app) {
                let _ = w.show();
                let _ = w.set_focus();
            }
            events::toast(&app, "登录确认超时，请重试或取消");
        }
    });
}

/// Opens the hidden candidate account webview of an attempt (same profile)
/// and hides the login window. Returns false when the attempt is gone, a
/// candidate is already pending, or the webview could not be created. The
/// identity (or a fall-back to the login page) then arrives through the
/// adapter exactly as after a manual login.
fn begin_candidate(app: &AppHandle, attempt_id: &str) -> bool {
    let ls = login_state(app);
    let profile_id = {
        let mut inner = ls.lock();
        let Some(rec) = inner.attempts.get_mut(attempt_id) else {
            return false;
        };
        if rec.candidate || rec.importing {
            return false;
        }
        rec.candidate = true;
        let profile_id = rec.profile_id.clone();
        inner.bindings.insert(
            profiles::account_label(&profile_id),
            Binding::Attempt(attempt_id.to_string()),
        );
        profile_id
    };
    let label = profiles::account_label(&profile_id);
    if app.get_webview_window(&label).is_none() {
        if let Err(e) = open_account_webview(app, &profile_id) {
            log::error!("attempt {attempt_id}: account webview not created: {e}");
            if let Some(rec) = ls.lock().attempts.get_mut(attempt_id) {
                rec.candidate = false;
            }
            return false;
        }
    }
    if let Some(w) = login_window(app) {
        let _ = w.hide();
    }
    true
}

/// Hidden `acct-<profile>` window on the official IM page with the adapter
/// boot script. Registered in the `ViewRegistry` under its label.
fn open_account_webview(app: &AppHandle, profile_id: &str) -> tauri::Result<()> {
    let label = profiles::account_label(profile_id);
    login_state(app).lock().adapter_ready.remove(&label);
    let source_view = {
        let ls = login_state(app);
        let _lifecycle = ls.lifecycle();
        let host = app.state::<HostState>();
        let view = host.lock().views.register(&label);
        view
    };
    let url = Url::parse(profiles::ACCOUNT_IM_URL).map_err(tauri::Error::InvalidUrl)?;
    let nav_app = app.clone();

    profiles::open_profile_window(
        app,
        ProfileWindow {
            label: &label,
            profile_id,
            url,
            title: "VBooking IM",
            visible: false,
            init_script: Some(crate::adapter::boot_script(app)),
        },
        move |url| {
            if profiles::is_login_page(url) {
                let app = nav_app.clone();
                let source_view = source_view.clone();
                tauri::async_runtime::spawn(
                    async move { on_account_landed_login(&app, &source_view) },
                );
            }
        },
    )?;
    Ok(())
}

/// Resolve only the captured native resource's binding. A queued callback
/// cannot borrow a new account context through a reused label.
fn resolve_login_redirect(
    cores: &crate::state::Cores,
    inner: &Inner,
    source: &ViewContext,
) -> Option<(Binding, Option<AccountContext>)> {
    if cores.views.current(&source.webview_label).as_ref() != Some(source)
        || inner.retiring_views.contains(&source.webview_label)
    {
        return None;
    }
    let binding = inner.bindings.get(&source.webview_label)?.clone();
    let account = match &binding {
        Binding::Account(id) => cores.accounts.current_context(&AccountId::new(id.clone())),
        Binding::Attempt(_) => None,
    };
    Some((binding, account))
}

/// An `acct-*` page was redirected to the official login page. Source nonce
/// survives the async queue and is checked inside lifecycle before resolution.
fn on_account_landed_login(app: &AppHandle, source: &ViewContext) {
    let ls = login_state(app);
    let lifecycle = ls.lifecycle();
    let host = app.state::<HostState>();
    let resolved = {
        let cores = host.lock();
        resolve_login_redirect(&cores, &ls.lock(), source)
    };
    let Some((binding, account)) = resolved else {
        return;
    };
    let label = &source.webview_label;
    match binding {
        Binding::Attempt(attempt_id) => {
            let imported = ls
                .lock()
                .attempts
                .get(&attempt_id)
                .is_some_and(|rec| rec.browser_imported);
            let (login_window, profile) = if imported {
                let Some(rec) = take_attempt(&mut ls.lock(), &attempt_id) else {
                    return;
                };
                crate::browser_bridge::cancel(&attempt_id);
                let _ = host
                    .lock()
                    .accounts
                    .cancel_login(&AttemptId::new(attempt_id.clone()));
                (rec.login_window, Some(rec.profile_id))
            } else {
                let mut inner = ls.lock();
                inner.bindings.remove(label);
                let login_window = inner.attempts.get_mut(&attempt_id).and_then(|rec| {
                    rec.candidate = false;
                    rec.login_window.clone()
                });
                (login_window, None)
            };
            ls.lock().retiring_views.insert(label.clone());
            let windows = capture_account_views(app, vec![label.clone()]);
            drop(lifecycle);
            destroy_captured_views(app, windows);
            if imported {
                if let Some(window) = login_window {
                    let _ = window.destroy();
                }
                if let Some(profile) = profile {
                    profiles::remove_profile_data(app, &profile);
                }
                let _ = start_login_with_browser(app, false);
                events::toast(app, "Chrome 登录态已失效，请使用官方登录页");
            } else if let Some(window) = login_window {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        Binding::Account(id) => {
            // The downstream transition reacquires lifecycle and checks both
            // this captured context and resource nonce before mutating cores.
            drop(lifecycle);
            match account {
                Some(account) => on_auth_invalid(app, &account, source),
                None => teardown_unpublished_account_views(app, &id, source),
            }
        }
    }
}

/// Remove only this attempt and carry its concrete window into teardown.
fn take_attempt(inner: &mut Inner, attempt_id: &str) -> Option<AttemptRec> {
    let rec = inner.attempts.remove(attempt_id)?;
    inner
        .bindings
        .remove(&profiles::account_label(&rec.profile_id));
    Some(rec)
}

fn cancel_attempt(app: &AppHandle, attempt_id: &str) {
    let ls = login_state(app);
    let lifecycle = ls.lifecycle();
    let removed = {
        let ls = login_state(app);
        let mut inner = ls.lock();
        take_attempt(&mut inner, attempt_id)
    };
    let Some(rec) = removed else {
        return;
    };
    crate::browser_bridge::cancel(attempt_id);
    {
        let host = app.state::<HostState>();
        let mut cores = host.lock();
        let _ = cores.accounts.cancel_login(&AttemptId::new(attempt_id));
    }
    // Settlement is complete before any native-window or profile operation.
    drop(lifecycle);
    if let Some(window) = rec.login_window {
        let _ = window.destroy();
    }
    profiles::destroy_window(app, &profiles::account_label(&rec.profile_id));
    // The profile was never published: its data must not survive.
    profiles::remove_profile_data(app, &rec.profile_id);
    log::info!("attempt {attempt_id}: cancelled");
    emit_changed(app);
}

// ------------------------------------------------------- account teardown

/// Detach metadata while lifecycle settlement is gated. The returned labels
/// are used only to capture native instances before releasing that gate.
fn detach_account_views(inner: &mut Inner, account_id: &str) -> Vec<String> {
    let labels: Vec<String> = inner
        .bindings
        .iter()
        .filter(|(_, binding)| **binding == Binding::Account(account_id.to_string()))
        .map(|(label, _)| label.clone())
        .collect();
    for label in &labels {
        inner.bindings.remove(label);
        inner.adapter_ready.remove(label);
        inner.retiring_views.insert(label.clone());
    }
    inner.validating.remove(account_id);
    labels
}

/// Called under lifecycle immediately before rebinding a retained profile.
/// Manager absence is the completion evidence; no native wait occurs here.
fn allow_retired_view_rebind(
    inner: &mut Inner,
    label: &str,
    native_present: bool,
) -> Result<(), AppError> {
    if inner.retiring_views.contains(label) {
        if native_present {
            return Err(app_err(
                codes::ADAPTER_NOT_READY,
                "旧账号页面仍在退出，请稍后重试；若持续失败请重新登录",
            )
            .retryable());
        }
        inner.retiring_views.remove(label);
    }
    Ok(())
}

fn require_identity_not_retiring(inner: &Inner, label: &str) -> Result<(), AppError> {
    if inner.retiring_views.contains(label) {
        Err(app_err(codes::ACCOUNT_STALE_GENERATION, "account page is retiring").retryable())
    } else {
        Ok(())
    }
}

/// A delayed cleanup owns instances, never a lookup by account or reusable
/// label. Generic only so barrier tests exercise this exact production plan.
struct CapturedViews<T>(Vec<T>);
impl<T> CapturedViews<T> {
    fn capture(labels: Vec<String>, mut lookup: impl FnMut(&str) -> Option<T>) -> Self {
        Self(labels.iter().filter_map(|label| lookup(label)).collect())
    }
    fn destroy(self, mut destroy: impl FnMut(T)) {
        for window in self.0 {
            destroy(window);
        }
    }
}
fn capture_account_views(
    app: &AppHandle,
    labels: Vec<String>,
) -> CapturedViews<tauri::WebviewWindow> {
    CapturedViews::capture(labels, |label| app.get_webview_window(label))
}
fn destroy_captured_views(app: &AppHandle, windows: CapturedViews<tauri::WebviewWindow>) {
    let mut failed = false;
    windows.destroy(|window| {
        if let Err(error) = window.destroy() {
            failed = true;
            log::warn!("retired account window destruction failed: {error}");
        }
    });
    // A successful destroy request may complete asynchronously. Keep the gate
    // until the manager actually no longer has that instance's label.
    login_state(app)
        .lock()
        .retiring_views
        .retain(|label| app.get_webview_window(label).is_some());
    if failed {
        events::toast(app, "旧账号页面未能关闭，请稍后重试或重新登录");
    }
}

fn settle_account_exit(
    inner: &mut Inner,
    account_id: &str,
    mode: LogoutMode,
) -> (Vec<String>, Option<String>) {
    let labels = detach_account_views(inner, account_id);
    inner.unread.remove(account_id);
    let profile = inner
        .meta
        .get(account_id)
        .and_then(|meta| meta.profile_id.clone());
    match mode {
        LogoutMode::ExitOnline => {
            if let Some(meta) = inner.meta.get_mut(account_id) {
                meta.suspended_by_user = true;
            }
        }
        LogoutMode::Logout => {
            if let Some(meta) = inner.meta.get_mut(account_id) {
                meta.profile_id = None;
                meta.suspended_by_user = false;
            }
        }
        LogoutMode::Forget => {
            inner.meta.remove(account_id);
            if inner.active.as_deref() == Some(account_id) {
                inner.active = None;
            }
        }
    }
    (labels, profile)
}

/// A navigation callback which found no context must recheck under lifecycle:
/// its earlier observation cannot authorize teardown of a newly published page.
fn teardown_unpublished_account_views(app: &AppHandle, account_id: &str, source: &ViewContext) {
    let ls = login_state(app);
    let lifecycle = ls.lifecycle();
    {
        let host = app.state::<HostState>();
        let cores = host.lock();
        if cores.views.current(&source.webview_label).as_ref() != Some(source)
            || cores
                .accounts
                .current_context(&AccountId::new(account_id))
                .is_some()
        {
            return;
        }
    }
    let labels = detach_account_views(&mut ls.lock(), account_id);
    let windows = capture_account_views(app, labels);
    drop(lifecycle);
    destroy_captured_views(app, windows);
}

/// Executes the store side of a revoke list: secret deletion and staged
/// leftovers. Runs without any lock held (keychain calls may block).
fn apply_credential_revoke(revoke: &RevokeList) {
    let mut store = KeychainStore::new();
    if let CredentialAction::Delete(cref) = &revoke.credential {
        if let Err(e) = store.delete(cref) {
            log::warn!("account {}: credential not deleted: {e}", revoke.account_id);
        }
    }
    for staged in &revoke.staged_to_discard {
        let _ = store.discard(staged);
    }
}

/// Commits the non-secret profile marker through the ledger so that the
/// account restarts as "suspended with credential" (quick login).
fn commit_profile_marker(
    host: &HostState,
    ctx: &AccountContext,
    profile_id: &str,
    store: &mut dyn SecretStore,
    persist_index: impl Fn() -> Result<(), AppError>,
) -> Result<(), AppError> {
    let marker = Secret::new(
        json!({ "v": 1, "kind": "webview_profile", "profile_id": profile_id }).to_string(),
    );
    let (operation, target) = {
        let mut cores = host.lock();
        let operation = cores.accounts.begin_credential_commit(ctx)?;
        let target = cores
            .accounts
            .credential_target(ctx, &operation.operation_id)?;
        (operation.operation_id, target)
    };
    // Persist the revision reservation before touching Keychain. Failed IO
    // never reports ready, and never deletes the previously committed key.
    persist_index()?;
    let staged = store.stage(&target, &marker)?;
    let recorded = host
        .lock()
        .accounts
        .record_credential_staged(ctx, &operation, &staged);
    if let Err(error) = recorded {
        let _ = store.discard(&staged);
        return Err(error);
    }
    persist_index()?;
    store.commit(&staged)?;
    let old = host
        .lock()
        .accounts
        .record_credential_promoted(ctx, &operation, &staged)?;
    // Old-key deletion is authorized only by the durable new index. A crash
    // before/after deletion leaves IndexCommitted recovery metadata on disk.
    persist_index()?;
    if let Some(old) = &old {
        store.delete(old)?;
    }
    host.lock()
        .accounts
        .record_credential_cleanup(&operation, old.as_ref())?;
    persist_index()
}

// ---------------------------------------------------------------- init

/// Called once from `lib.rs` setup.
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let data_dir = app.path().app_data_dir()?;
    let path = data_dir.join(ACCOUNTS_FILE);
    app.manage(LoginState {
        inner: Mutex::new(Inner::default()),
        persist_lock: Mutex::new(()),
        start_lock: Mutex::new(()),
        lifecycle_lock: Mutex::new(()),
        restoring: AtomicBool::new(true),
        active_visit_epoch: AtomicU64::new(0),
        data_dir,
    });
    #[cfg(debug_assertions)]
    if std::env::var_os("VBK_DEBUG_OPEN_LOGIN").is_some() {
        // Dev aid for manual verification: open the login window at startup
        // without going through the main shell UI.
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(800)).await;
            if let Err(e) = start_login(&app) {
                log::error!("debug login window: {} {}", e.code, e.message);
            }
        });
    }
    let (mut load, doc) = load_doc(&path);
    log::info!(
        "data dir {}: account index {load:?} ({} account(s))",
        path.parent()
            .map(|d| d.display().to_string())
            .unwrap_or_default(),
        doc.as_ref().map_or(0, |d| d.accounts.len())
    );
    // Keychain reads may block (or prompt) — never on the main thread.
    let app = app.clone();
    std::thread::Builder::new()
        .name("vbk-account-restore".into())
        .spawn(move || {
            let ls = login_state(&app);
            let _completion = RestoreCompletion(&ls.restoring);
            if let Some(doc) = doc {
                if !restore(&app, doc) {
                    crate::data_guard::preserve_unreadable(&path);
                    load = IndexLoad::Untrusted;
                }
            }
            // 索引不可信时不清理：否则一次读失败（升级后 schema 不认、半截写入）
            // 会把所有账号的 WebView 登录态当孤儿删掉。
            if crate::data_guard::may_purge_orphans(load) {
                purge_orphan_profiles(&app);
            } else if load == IndexLoad::Absent {
                // 首次启动没有索引是正常情况，不告警。
                log::info!("account index Absent: orphan profile cleanup skipped");
            } else {
                log::warn!("account index {load:?}: orphan profile cleanup skipped");
            }
        })
        .map_err(tauri::Error::Io)?;
    Ok(())
}

/// Returns whether the in-memory account set now mirrors the index on disk
/// (only then may unreferenced profiles be treated as orphans).
fn restore(app: &AppHandle, doc: PersistDoc) -> bool {
    let boot_epoch = app.state::<HostState>().lock().accounts.boot_epoch();
    let registry_doc = match contracts::json::JsonValue::parse(&doc.registry.to_string()) {
        Ok(v) => v,
        Err(e) => {
            log::error!("account index unreadable: {e:?}");
            return false;
        }
    };
    let mut registry = match AccountRegistry::restore(&registry_doc, boot_epoch) {
        Ok(r) => r,
        Err(e) => {
            log::error!("account index not restored: {} {}", e.code, e.message);
            return false;
        }
    };
    let report = registry.recover_credentials(&mut KeychainStore::new());
    for id in &report.missing_secret {
        log::warn!(
            "account {id}: quick-login marker missing from the credential store; needs a new login"
        );
    }
    for id in &report.unavailable_secret {
        log::warn!("account {id}: marker probe unavailable; profile kept, restoration deferred");
    }
    let resumable: Vec<(String, String)> = {
        let host = app.state::<HostState>();
        let mut cores = host.lock();
        if !cores.accounts.account_ids().is_empty() {
            log::warn!("account index restore skipped: accounts already present");
            return false;
        }
        let mut resumable = Vec::new();
        for id in registry.account_ids() {
            let kind = registry.state(&id).map(|s| s.kind());
            let meta = doc.accounts.get(id.as_str());
            let skip = if kind != Some(AccountStateKind::Suspended) {
                Some(format!("state {kind:?}"))
            } else if report.unavailable_secret.contains(&id) {
                Some("marker probe unavailable".to_string())
            } else if meta.map_or(true, |m| m.suspended_by_user) {
                Some("suspended by user".to_string())
            } else if meta.and_then(|m| m.profile_id.as_ref()).is_none() {
                Some("no profile".to_string())
            } else {
                None
            };
            match (skip, meta.and_then(|m| m.profile_id.clone())) {
                (None, Some(profile)) => resumable.push((id.as_str().to_string(), profile)),
                (reason, _) => log::info!(
                    "account {id}: not resumed at startup ({})",
                    reason.unwrap_or_default()
                ),
            }
        }
        cores.accounts = registry;
        resumable
    };
    {
        let ls = login_state(app);
        let mut inner = ls.lock();
        inner.meta = doc.accounts;
        inner.active = doc.active_account_id;
        for (id, profile) in &resumable {
            inner.bindings.insert(
                profiles::account_label(profile),
                Binding::Account(id.clone()),
            );
            inner.validating.insert(id.clone());
        }
    }
    for (id, profile) in &resumable {
        log::info!(
            "account {id}: resuming saved profile {profile} (web data {})",
            profile_storage_state(app, profile)
        );
        if let Err(e) = open_account_webview(app, profile) {
            log::error!("account {id}: webview not restored: {e}");
            login_state(app).lock().validating.remove(id);
        }
    }
    persist_and_emit(app);
    true
}

/// Whether a profile's web data (cookies) is still on disk, for the restore
/// log: a missing store explains a forced re-login without guessing.
fn profile_storage_state(app: &AppHandle, profile_id: &str) -> &'static str {
    #[cfg(target_os = "macos")]
    {
        match tauri::async_runtime::block_on(app.fetch_data_store_identifiers()) {
            Ok(ids) if ids.contains(&profiles::data_store_id(profile_id)) => "present",
            Ok(_) => "missing",
            Err(_) => "unknown",
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        match profiles::data_dir(app, profile_id) {
            Some(dir) if dir.is_dir() => "present",
            Some(_) => "missing",
            None => "unknown",
        }
    }
}

/// Profile ids still in use (published accounts and running attempts).
fn known_profiles(app: &AppHandle) -> HashSet<String> {
    let ls = login_state(app);
    let inner = ls.lock();
    inner
        .meta
        .values()
        .filter_map(|m| m.profile_id.clone())
        .chain(inner.attempts.values().map(|a| a.profile_id.clone()))
        .collect()
}

/// Deletes web profiles left behind by attempts that never finished (crash
/// or kill during login) or by a teardown that could not complete.
fn purge_orphan_profiles(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let ids = match tauri::async_runtime::block_on(app.fetch_data_store_identifiers()) {
            Ok(ids) => ids,
            Err(e) => {
                log::warn!("data stores not listed: {e}");
                Vec::new()
            }
        };
        let known: HashSet<[u8; 16]> = known_profiles(app)
            .iter()
            .map(|p| profiles::data_store_id(p))
            .collect();
        for id in ids.into_iter().filter(|id| !known.contains(id)) {
            if let Err(e) = tauri::async_runtime::block_on(app.remove_data_store(id)) {
                log::warn!("orphan data store not removed: {e}");
            }
        }
    }
    let Some(root) = app.path().app_data_dir().ok().map(|d| d.join("profiles")) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&root) else {
        return;
    };
    let known = known_profiles(app);
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if crate::data_guard::is_profile_dir_name(&name) && !known.contains(&name) {
            if let Err(e) = std::fs::remove_dir_all(entry.path()) {
                log::warn!("orphan profile directory {name} not removed: {e}");
            }
        }
    }
}

// ------------------------------------------------------------ commands

#[tauri::command]
pub fn account_snapshot(
    window: Window,
    state: State<'_, HostState>,
) -> CmdResult<serde_json::Value> {
    guard(&state, &window, "account_snapshot")?;
    Ok(snapshot(window.app_handle()))
}

#[tauri::command]
pub async fn account_start_login(window: Window) -> CmdResult<serde_json::Value> {
    let app = window.app_handle().clone();
    guard_app(&app, &window, "account_start_login")?;
    let attempt_id = start_login(&app)?;
    Ok(json!({ "attempt_id": attempt_id }))
}

/// Enumeration returns labels only. Cookie values remain in the host.
#[tauri::command]
pub async fn account_browser_profiles(
    window: Window,
) -> CmdResult<Vec<crate::browser_bridge::Choice>> {
    guard_app(window.app_handle(), &window, "account_browser_profiles")?;
    let attempt = login_state(window.app_handle())
        .lock()
        .attempts
        .keys()
        .next()
        .cloned()
        .ok_or_else(|| {
            AppErrorDto::from(app_err(codes::HOST_VIEW_UNAUTHORIZED, "登录窗口已失效"))
        })?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::browser_bridge::begin(&attempt)?;
        crate::browser_bridge::choices()
    })
    .await
    .map_err(|_| AppErrorDto::from(app_err(codes::ADAPTER_FAILED, "无法读取浏览器账号")))?
    .map_err(AppErrorDto::from)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn account_browser_connect(
    window: Window,
    attempt_id: String,
    profile_id: String,
) -> CmdResult<()> {
    let app = window.app_handle().clone();
    guard_app(&app, &window, "account_browser_connect")?;
    // One imported browser session at a time, including cancellation.
    static IMPORT: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
    let permit = IMPORT
        .try_acquire()
        .map_err(|_| AppErrorDto::from(app_err(codes::ADAPTER_FAILED, "正在导入浏览器登录态")))?;
    let valid = |app: &AppHandle| {
        login_state(app)
            .lock()
            .attempts
            .get(&attempt_id)
            .is_some_and(|a| !a.candidate)
    };
    if !valid(&app) {
        return Err(app_err(codes::HOST_VIEW_UNAUTHORIZED, "登录窗口已失效").into());
    }
    // The permit lives inside the blocking job: dropping IPC does not allow a
    // second import while the previous job is still pending.
    let (result, _permit) = tauri::async_runtime::spawn_blocking(move || {
        (crate::browser_bridge::read(&profile_id), permit)
    })
    .await
    .map_err(|_| AppErrorDto::from(app_err(codes::ADAPTER_FAILED, "读取浏览器登录态失败")))?;
    let result = result?;
    let remote = app
        .get_webview(&profiles::login_remote_label(&attempt_id))
        .ok_or_else(|| app_err(codes::HOST_VIEW_UNAUTHORIZED, "登录窗口已关闭"))?;
    {
        let state = login_state(&app);
        let mut inner = state.lock();
        let rec = inner
            .attempts
            .get_mut(&attempt_id)
            .filter(|a| !a.candidate && !a.importing)
            .ok_or_else(|| app_err(codes::HOST_VIEW_UNAUTHORIZED, "登录窗口已失效"))?;
        rec.importing = true;
    }
    let applied = async {
        remote
            .navigate(Url::parse("about:blank").expect("fixed URL"))
            .map_err(|_| app_err(codes::ADAPTER_FAILED, "无法准备登录窗口"))?;
        let mut apply = std::pin::pin!(crate::chrome_cookie_store::apply(remote.clone(), result));
        let mut cancellation = tokio::time::interval(Duration::from_millis(50));
        std::future::poll_fn(|cx| {
            if cancellation.poll_tick(cx).is_ready() && !valid(&app) {
                return std::task::Poll::Ready(Err(app_err(
                    codes::HOST_VIEW_UNAUTHORIZED,
                    "登录窗口已失效",
                )));
            }
            std::future::Future::poll(apply.as_mut(), cx)
        })
        .await
    }
    .await;
    if let Err(error) = applied {
        // Never leave a partially imported jar for a later login. The fresh
        // official login does not automatically retry the failed import.
        if valid(&app) {
            cancel_attempt(&app, &attempt_id);
            let _ = start_login_with_browser(&app, false);
        }
        return Err(error.into());
    }
    if !valid(&app) {
        return Err(app_err(codes::HOST_VIEW_UNAUTHORIZED, "登录窗口已失效").into());
    }
    if let Some(rec) = login_state(&app).lock().attempts.get_mut(&attempt_id) {
        rec.importing = false;
        rec.browser_imported = true;
    }
    // The official IM adapter verifies the seeded profile. No login-page
    // redirect alone is treated as success, and the ordinary timeout applies.
    on_login_candidate(&app, &attempt_id);
    if valid(&app) {
        cancel_attempt(&app, &attempt_id);
        let _ = start_login_with_browser(&app, false);
        return Err(app_err(
            codes::ADAPTER_FAILED,
            "无法核验浏览器登录态，请使用官方登录页",
        )
        .into());
    }
    Ok(())
}

/// Starts (or re-surfaces) the login attempt and opens the login window.
/// Must not run on the main thread.
fn start_login(app: &AppHandle) -> Result<String, AppError> {
    start_login_with_browser(app, true)
}

fn start_login_with_browser(app: &AppHandle, auto_browser: bool) -> Result<String, AppError> {
    let ls = login_state(app);
    ls.ensure_ready()?;
    ls.with_start(|| start_login_serialized(app, auto_browser))
}

fn start_login_serialized(app: &AppHandle, auto_browser: bool) -> Result<String, AppError> {
    // One login window at a time: re-surface the running attempt.
    let existing = login_state(app).lock().attempts.keys().next().cloned();
    if let Some(attempt_id) = existing {
        if let Some(w) = login_window(app) {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
            return Ok(attempt_id);
        }
        cancel_attempt(app, &attempt_id);
    }

    let handle = {
        let host = app.state::<HostState>();
        let mut cores = host.lock();
        if cores.accounts.account_ids().len() >= MAX_ACCOUNTS {
            return Err(app_err(
                core_account::codes::ACCOUNT_INVALID_STATE,
                format!("at most {MAX_ACCOUNTS} accounts"),
            ));
        }
        cores.accounts.start_login(Environment::production())
    };
    let attempt_id = handle.attempt_id.as_str().to_string();
    let profile_id = handle.profile_id.as_str().to_string();
    login_state(app).lock().attempts.insert(
        attempt_id.clone(),
        AttemptRec {
            profile_id: profile_id.clone(),
            login_window: None,
            candidate: false,
            importing: false,
            browser_imported: false,
        },
    );
    // A missing bridge must not block the official login fallback. Discovery
    // reports its actionable error in the local login header.
    if let Err(error) = crate::browser_bridge::begin(&attempt_id) {
        log::warn!("browser bridge unavailable: {}", error.code);
    }
    if let Err(e) = open_login_window(app, &attempt_id, &profile_id, auto_browser) {
        log::error!("login window not created: {e}");
        cancel_attempt(app, &attempt_id);
        return Err(app_err(
            codes::HOST_UNSUPPORTED,
            format!("login window: {e}"),
        ));
    }
    log::info!("attempt {attempt_id}: login window opened");
    emit_changed(app);
    Ok(attempt_id)
}

// JS sends snake_case keys (`{t1_seconds}` / `{attempt_id}`), not camelCase.
#[tauri::command(rename_all = "snake_case")]
pub async fn account_cancel_login(
    window: Window,
    attempt_id: String,
) -> CmdResult<serde_json::Value> {
    let app = window.app_handle().clone();
    guard_app(&app, &window, "account_cancel_login")?;
    cancel_attempt(&app, &attempt_id);
    Ok(snapshot(&app))
}

#[tauri::command]
pub async fn account_switch(
    window: Window,
    account: AccountContextDto,
) -> CmdResult<serde_json::Value> {
    let app = window.app_handle().clone();
    guard_app(&app, &window, "account_switch")?;
    let ls = login_state(&app);
    let lifecycle = ls.lifecycle();
    let ctx = check_account(&app, &account)?;
    let id = ctx.account_id.as_str().to_string();
    let kind = {
        let host = app.state::<HostState>();
        let cores = host.lock();
        cores.accounts.state(&ctx.account_id).map(|s| s.kind())
    };
    // Switching to a suspended account resumes it with its kept profile.
    let resume_profile = {
        let ls = login_state(&app);
        let mut inner = ls.lock();
        ls.set_active_for_visit(&mut inner, id.clone());
        let profile = inner.meta.get(&id).and_then(|m| m.profile_id.clone());
        let validating = inner.validating.contains(&id);
        match (kind, profile) {
            (Some(AccountStateKind::Suspended), Some(p)) if !validating => {
                let label = profiles::account_label(&p);
                allow_retired_view_rebind(
                    &mut inner,
                    &label,
                    app.get_webview_window(&label).is_some(),
                )?;
                if let Some(m) = inner.meta.get_mut(&id) {
                    m.suspended_by_user = false;
                }
                inner
                    .bindings
                    .insert(profiles::account_label(&p), Binding::Account(id.clone()));
                inner.validating.insert(id.clone());
                Some(p)
            }
            _ => None,
        }
    };
    drop(lifecycle);
    if let Some(p) = resume_profile {
        if app
            .get_webview_window(&profiles::account_label(&p))
            .is_none()
        {
            if let Err(e) = open_account_webview(&app, &p) {
                log::error!("account {id}: webview not resumed: {e}");
                login_state(&app).lock().validating.remove(&id);
            }
        }
    }
    persist_and_emit(&app);
    Ok(snapshot(&app))
}

/// Caller holds lifecycle then the outbound mutex; no Cores guard crosses IO.
fn lock_account_storage(
    host: &HostState,
    journal: Option<&crate::adapter::outbound_journal::OutboundJournal>,
    account: &AccountContext,
) -> Result<(), AppError> {
    // Attempt both stores even when one fails. Registry revocation has already
    // happened; a failed disk barrier cannot restore that authorization.
    let outbound = journal
        .ok_or_else(|| app_err("im.journal_unavailable", "account storage is unavailable"))
        .and_then(|journal| journal.logout_lock(account));
    let main = host.lock_namespace_ready(account);
    outbound.and(main)
}

fn reopen_account_storage(
    host: &HostState,
    journal: Option<&crate::adapter::outbound_journal::OutboundJournal>,
    account: &AccountContext,
) -> Result<(), AppError> {
    let result = host.unlock_namespace_ready(account).and_then(|()| {
        journal
            .ok_or_else(|| app_err("im.journal_unavailable", "account storage is unavailable"))?
            .unlock_after_reauth(account)
    });
    if let Err(error) = result {
        // Publication may have advanced the registry already. Revoke that
        // authorization instead of exposing an online but unusable account.
        let _ = host.logout_context(account, LogoutMode::ExitOnline);
        let _ = lock_account_storage(host, journal, account);
        return Err(app_err(&error.code, "账号存储恢复失败，已暂停；请重新登录"));
    }
    Ok(())
}

/// Shared part of the three exit modes.
fn exit_account(app: &AppHandle, ctx: &AccountContext, mode: LogoutMode) -> Result<(), AppError> {
    let id = ctx.account_id.as_str().to_string();
    let host = app.state::<HostState>();
    let ls = login_state(app);
    let lifecycle = ls.lifecycle();
    let (revoke, storage) = crate::adapter::with_outbound_transition(app, |journal| {
        host.check_account_context(ctx)?;
        let kind = host
            .lock()
            .accounts
            .state(&ctx.account_id)
            .map(|s| s.kind());
        let revoke = match (mode, kind) {
            // Not online (still validating, expired…): nothing to revoke for
            // exit-online beyond closing the page.
            (LogoutMode::ExitOnline, Some(k)) if k != AccountStateKind::Online => None,
            (LogoutMode::Logout, Some(AccountStateKind::LoggedOut)) => None,
            _ => Some(host.logout_context(ctx, mode)?),
        };
        let storage = if revoke.is_some() {
            lock_account_storage(&host, journal, ctx)
        } else {
            Ok(())
        };
        Ok::<_, AppError>((revoke, storage))
    })?;
    let (labels, profile) = settle_account_exit(&mut ls.lock(), &id, mode);
    let windows = capture_account_views(app, labels);
    drop(lifecycle);
    crate::browser_tabs::close_account(app, &id);
    destroy_captured_views(app, windows);
    crate::adapter::on_account_removed(app, ctx);
    if let Some(revoke) = &revoke {
        apply_credential_revoke(revoke);
    }
    if mode != LogoutMode::ExitOnline {
        let profile = revoke
            .as_ref()
            .and_then(|r| r.profile.as_ref().map(|p| p.as_str().to_string()))
            .or(profile);
        if let Some(p) = profile {
            profiles::remove_profile_data(app, &p);
        }
    }
    log::info!("account {id}: exit {mode:?}");
    persist_and_emit(app);
    storage
}

/// Async: the keychain cleanup must not block the main thread.
#[tauri::command]
pub async fn account_suspend(
    window: Window,
    account: AccountContextDto,
) -> CmdResult<serde_json::Value> {
    let app = window.app_handle().clone();
    guard_app(&app, &window, "account_suspend")?;
    let ctx = check_account(&app, &account)?;
    exit_account(&app, &ctx, LogoutMode::ExitOnline)?;
    Ok(snapshot(&app))
}

/// Async: the keychain cleanup must not block the main thread.
#[tauri::command]
pub async fn account_logout(
    window: Window,
    account: AccountContextDto,
) -> CmdResult<serde_json::Value> {
    let app = window.app_handle().clone();
    guard_app(&app, &window, "account_logout")?;
    let ctx = check_account(&app, &account)?;
    exit_account(&app, &ctx, LogoutMode::Logout)?;
    Ok(snapshot(&app))
}

/// Async: the keychain cleanup must not block the main thread.
#[tauri::command]
pub async fn account_forget(
    window: Window,
    account: AccountContextDto,
) -> CmdResult<serde_json::Value> {
    let app = window.app_handle().clone();
    guard_app(&app, &window, "account_forget")?;
    let ctx = check_account(&app, &account)?;
    exit_account(&app, &ctx, LogoutMode::Forget)?;
    Ok(snapshot(&app))
}

#[tauri::command]
pub fn account_set_remark(
    window: Window,
    state: State<'_, HostState>,
    account: AccountContextDto,
    remark: Option<String>,
) -> CmdResult<serde_json::Value> {
    guard(&state, &window, "account_set_remark")?;
    let app = window.app_handle();
    let ctx = check_account(app, &account)?;
    let remark = remark
        .map(|r| r.trim().chars().take(REMARK_MAX_CHARS).collect::<String>())
        .filter(|r| !r.is_empty());
    state.lock().accounts.set_remark(&ctx.account_id, remark)?;
    persist_and_emit(app);
    Ok(snapshot(app))
}

#[tauri::command]
pub async fn shell_open_webview(
    window: Window,
    account: AccountContextDto,
    url: String,
) -> CmdResult<crate::browser_tabs::BrowserTabDto> {
    let app = window.app_handle().clone();
    guard_app(&app, &window, "shell_open_webview")?;
    let ctx = check_account(&app, &account)?;
    app.state::<HostState>().lock().accounts.validate(&ctx)?;
    let parsed = crate::shell::check_external_url(&url).map_err(AppErrorDto::from)?;
    let id = ctx.account_id.as_str().to_string();
    let profile = login_state(&app)
        .lock()
        .meta
        .get(&id)
        .and_then(|m| m.profile_id.clone())
        .ok_or_else(|| {
            app_err(
                core_account::codes::ACCOUNT_INVALID_STATE,
                "no profile bound",
            )
        })?;
    let tab = crate::browser_tabs::open(&app, &id, &profile, parsed)?;
    if window.label() != crate::views::MAIN {
        crate::browser_tabs::hand_to_main(&app, &tab);
    }
    Ok(tab)
}

// ------------------------------------------------------------------
// Cross-module interface (FROZEN signatures; bodies owned by host-login).

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub struct PersonProfileDto {
    pub uid: String,
    pub name: Option<String>,
    pub avatar: Option<String>,
}

impl AccountMeta {
    fn update_identity(&mut self, identity: &UpstreamIdentityDto) {
        self.nick = identity.nick.clone();
        self.party = identity.party.clone();
        // Platform account, agentId and display name cannot identify an IM person.
        self.self_profile = identity
            .self_profile
            .as_ref()
            .filter(|p| {
                !identity.uid.trim().is_empty()
                    && p.uid.trim().eq_ignore_ascii_case(identity.uid.trim())
            })
            .cloned();
    }
}

/// Identity read on the official page (mirrors `AdapterIdentityPayload`).
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct UpstreamIdentityDto {
    #[serde(default)]
    pub self_profile: Option<PersonProfileDto>,
    pub buid: String,
    pub uid: String,
    pub agent_id: Option<String>,
    pub nick: String,
    pub party: String,
    pub environment: String,
}

/// The account bound to an `acct-*` webview, or None while identity is unknown.
pub fn account_for_webview(app: &AppHandle, label: &str) -> Option<contracts::AccountContext> {
    let ls = login_state(app);
    let inner = ls.lock();
    let binding = inner.bindings.get(label).cloned()?;
    let Binding::Account(id) = binding else {
        return None;
    };
    // A recovered page must publish and verify its upstream identity again.
    if inner.validating.contains(&id) {
        return None;
    }
    drop(inner);
    let host = app.state::<HostState>();
    let cores = host.lock();
    let id = AccountId::new(id);
    match cores.accounts.state(&id)?.kind() {
        AccountStateKind::Online => cores.accounts.current_context(&id),
        _ => None,
    }
}

fn current_adapter_account(
    inner: &Inner,
    registry: &AccountRegistry,
    label: &str,
) -> Option<AccountContext> {
    let Binding::Account(id) = inner.bindings.get(label)? else {
        return None;
    };
    if inner.validating.contains(id) || inner.retiring_views.contains(label) {
        return None;
    }
    let account = registry.current_context(&AccountId::new(id.clone()))?;
    registry.validate(&account).ok()?;
    Some(account)
}

/// Called for each allowed page-load start, before the new page issues READY.
/// Old queued failures cannot consume a successor document's boot lease.
pub(crate) fn adapter_page_started(app: &AppHandle, label: &str) {
    if !label.starts_with(views::ACCOUNT_WEBVIEW_PREFIX) {
        return;
    }
    let Some(ls) = app.try_state::<LoginState>() else {
        return;
    };
    let _lifecycle = ls.lifecycle();
    ls.lock().adapter_ready.remove(label);
}

pub(crate) fn adapter_account_removed(app: &AppHandle, account: &AccountContext) {
    if let Some(ls) = app.try_state::<LoginState>() {
        ls.lock()
            .adapter_ready
            .retain(|_, lease| lease.account != *account);
    }
}

/// Resolve binding and publish READY lease under the same lifecycle gate as
/// queue suspension and identity publication. No claimed page account is used.
pub(crate) fn issue_adapter_ready(
    app: &AppHandle,
    label: &str,
    boot_epoch: u64,
) -> Result<Option<AccountContext>, AppError> {
    let ls = login_state(app);
    let _lifecycle = ls.lifecycle();
    let host = app.state::<HostState>();
    let cores = host.lock();
    let result = publish_adapter_ready(
        &mut ls.lock(),
        &cores.accounts,
        &cores.views,
        label,
        boot_epoch,
    );
    result
}

fn publish_adapter_ready(
    inner: &mut Inner,
    registry: &AccountRegistry,
    views: &crate::views::ViewRegistry,
    label: &str,
    boot_epoch: u64,
) -> Result<Option<AccountContext>, AppError> {
    let view = views.current(label).ok_or_else(|| {
        app_err(
            codes::HOST_VIEW_UNAUTHORIZED,
            "adapter resource is no longer registered",
        )
    })?;
    if boot_epoch == 0
        || inner
            .adapter_ready
            .get(label)
            .is_some_and(|lease| lease.boot_epoch >= boot_epoch)
    {
        return Err(app_err("adapter.not_ready", "stale adapter READY lease"));
    }
    let account = current_adapter_account(inner, registry, label);
    inner.adapter_ready.remove(label);
    let Some(account) = account else {
        return Ok(None);
    };
    // At most one current boot per account; old profile/page leases cannot
    // accumulate or act on the newly bound account.
    inner.adapter_ready.retain(|_, lease| {
        lease.account.persistent_key() != account.persistent_key()
            && registry.validate(&lease.account).is_ok()
            && views.current(&lease.view.webview_label).as_ref() == Some(&lease.view)
    });
    if inner.adapter_ready.len() >= MAX_ACCOUNTS || boot_epoch == 0 {
        return Err(app_err(
            "adapter.not_ready",
            "adapter READY lease unavailable",
        ));
    }
    inner.adapter_ready.insert(
        label.into(),
        AdapterReadyLease {
            account: account.clone(),
            view,
            boot_epoch,
        },
    );
    Ok(Some(account))
}

fn take_queue_fault_lease(
    inner: &mut Inner,
    registry: &AccountRegistry,
    current_view: Option<&ViewContext>,
    label: &str,
    account: &AccountContext,
    boot_epoch: u64,
) -> Option<AdapterReadyLease> {
    let lease = inner.adapter_ready.get(label)?;
    if lease.account != *account
        || lease.boot_epoch != boot_epoch
        || boot_epoch == 0
        || current_view != Some(&lease.view)
        || current_adapter_account(inner, registry, label).as_ref() != Some(account)
    {
        return None;
    }
    inner.adapter_ready.remove(label)
}

fn detach_overloaded_account(inner: &mut Inner, id: &str) -> Vec<String> {
    settle_account_exit(inner, id, LogoutMode::ExitOnline).0
}

fn bridge_fault_message(reason: &BridgeFaultReason) -> &'static str {
    match reason {
        BridgeFaultReason::QueueOverflow => "消息通道过载，已暂停，请重新登录",
        BridgeFaultReason::DeliveryFailed => "消息同步失败，已暂停，请重新登录",
    }
}

/// Called only after the command's adapter-only ACL check. The registry and
/// view are checked atomically by HostState before generation revocation.
pub(crate) fn suspend_faulted_adapter(
    app: &AppHandle,
    label: &str,
    account: &AccountContext,
    boot_epoch: u64,
    reason: &BridgeFaultReason,
) -> Result<bool, AppError> {
    let ls = login_state(app);
    let lifecycle = ls.lifecycle();
    let host = app.state::<HostState>();
    let lease = {
        let cores = host.lock();
        let view = cores.views.current(label);
        take_queue_fault_lease(
            &mut ls.lock(),
            &cores.accounts,
            view.as_ref(),
            label,
            account,
            boot_epoch,
        )
    };
    let Some(lease) = lease else {
        return Ok(false);
    };
    // A concurrent fact may have invalidated the account after admission;
    // this operation rechecks the complete generation and view in one lock.
    let transition = crate::adapter::with_outbound_transition(app, |journal| {
        host.suspend_current_view(&lease.account, &lease.view)
            .map(|revoke| (revoke, lock_account_storage(&host, journal, &lease.account)))
    });
    let (revoke, storage) = match transition {
        Ok(result) => result,
        Err(_) => return Ok(false),
    };
    let id = account.account_id.as_str();
    let labels = detach_overloaded_account(&mut ls.lock(), id);
    // Capture concrete handles while settlement is gated. A late teardown
    // must never look up a reused label and destroy the replacement window.
    let windows: Vec<_> = labels
        .iter()
        .filter_map(|label| app.get_webview_window(label))
        .collect();
    drop(lifecycle);
    crate::browser_tabs::close_account(app, account.account_id.as_str());
    for window in windows {
        let _ = window.destroy();
    }
    crate::adapter::on_account_removed(app, account);
    apply_credential_revoke(&revoke); // ExitOnline keeps committed credentials.
    persist_and_emit(app);
    events::toast(app, bridge_fault_message(reason));
    storage?;
    Ok(true)
}

/// Label of the `acct-*` webview currently serving `account`.
pub fn account_webview_label(
    app: &AppHandle,
    account: &contracts::AccountContext,
) -> Option<String> {
    {
        let host = app.state::<HostState>();
        host.lock().accounts.validate(account).ok()?;
    }
    let ls = login_state(app);
    let inner = ls.lock();
    if inner.validating.contains(account.account_id.as_str()) {
        return None;
    }
    let wanted = Binding::Account(account.account_id.as_str().to_string());
    inner
        .bindings
        .iter()
        .find(|(_, b)| **b == wanted)
        .map(|(l, _)| l.clone())
}

fn require_identity_binding(inner: &Inner, label: &str, id: &str) -> Result<(), AppError> {
    require_identity_not_retiring(inner, label)?;
    if inner.bindings.get(label) != Some(&Binding::Account(id.into())) {
        return Err(app_err(
            codes::ACCOUNT_STALE_GENERATION,
            "adapter binding was revoked",
        ));
    }
    Ok(())
}

/// Called by `adapter_identity`: publishes the identity for the attempt bound
/// to this webview and returns the resulting context (emits account://changed).
pub fn on_identity(
    app: &AppHandle,
    label: &str,
    identity: UpstreamIdentityDto,
) -> Result<contracts::AccountContext, AppError> {
    if identity.buid.trim().is_empty() {
        return Err(app_err(codes::ACCOUNT_UNKNOWN, "identity without buid"));
    }
    let binding = login_state(app)
        .lock()
        .bindings
        .get(label)
        .cloned()
        .ok_or_else(|| {
            app_err(
                codes::ACCOUNT_UNKNOWN,
                "webview is not bound to a login or account",
            )
        })?;
    let environment = Environment::named(identity.environment.clone());
    let upstream = UpstreamIdentity {
        buid: Buid::new(identity.buid.clone()),
        uid: identity.uid.clone(),
        agent_id: identity.agent_id.clone(),
        environment: environment.clone(),
    };
    let host = app.state::<HostState>();
    match binding {
        Binding::Attempt(attempt_id) => {
            let ls = login_state(app);
            // Cancellation and publication have one winner, including the
            // credential commit and host metadata update. A stale binding
            // captured above is rechecked via the attempt under this guard.
            let lifecycle = ls.lifecycle();
            require_identity_not_retiring(&ls.lock(), label)?;
            let profile_id = login_state(app)
                .lock()
                .attempts
                .get(&attempt_id)
                .map(|r| r.profile_id.clone())
                .ok_or_else(|| {
                    app_err(
                        core_account::codes::ACCOUNT_ATTEMPT_UNKNOWN,
                        "attempt is gone",
                    )
                })?;
            let (outcome, old_profile, completed_window, storage) =
                crate::adapter::with_outbound_transition(app, |journal| {
                    let outcome = {
                        let mut cores = host.lock();
                        let outcome = cores
                            .accounts
                            .publish_identity(&AttemptId::new(attempt_id.clone()), upstream)?;
                        if outcome.revoke.is_some() {
                            let _ = cores.im.invalidate_generation(outcome.ctx.clone());
                        }
                        outcome
                    };
                    let id = outcome.ctx.account_id.as_str().to_string();
                    let (old_profile, completed_window) = {
                        let ls = login_state(app);
                        let mut inner = ls.lock();
                        let completed_window = inner
                            .attempts
                            .remove(&attempt_id)
                            .and_then(|rec| rec.login_window);
                        crate::browser_bridge::cancel(&attempt_id);
                        inner
                            .bindings
                            .insert(label.to_string(), Binding::Account(id.clone()));
                        inner.validating.remove(&id);
                        inner.active = Some(id.clone());
                        let meta = inner.meta.entry(id.clone()).or_insert_with(|| AccountMeta {
                            color: color_for(&id),
                            ..AccountMeta::default()
                        });
                        meta.update_identity(&identity);
                        meta.suspended_by_user = false;
                        (
                            meta.profile_id.replace(profile_id.clone()),
                            completed_window,
                        )
                    };
                    let storage = commit_profile_marker(
                        &host,
                        &outcome.ctx,
                        &profile_id,
                        &mut KeychainStore::new(),
                        || {
                            persist_checked(app).map_err(|_| {
                                app_err(
                                    "store.persist_failed",
                                    "credential index persistence failed",
                                )
                            })
                        },
                    )
                    .and_then(|()| reopen_account_storage(&host, journal, &outcome.ctx));
                    if storage.is_err() {
                        let _ = host.logout_context(&outcome.ctx, LogoutMode::ExitOnline);
                        let _ = lock_account_storage(&host, journal, &outcome.ctx);
                    }
                    Ok::<_, AppError>((outcome, old_profile, completed_window, storage))
                })?;
            let id = outcome.ctx.account_id.as_str().to_string();
            // Retire the previous binding and capture its exact native
            // instance before a successor can publish under the same label.
            let stale_profile = outcome.revoke.as_ref().and_then(|revoke| {
                revoke
                    .profile
                    .as_ref()
                    .map(|p| p.as_str().to_string())
                    .or(old_profile)
                    .filter(|p| p != &profile_id)
            });
            let stale_windows = if let Some(profile) = &stale_profile {
                let label = profiles::account_label(profile);
                {
                    let mut inner = ls.lock();
                    inner.bindings.remove(&label);
                    inner.adapter_ready.remove(&label);
                    inner.retiring_views.insert(label.clone());
                }
                capture_account_views(app, vec![label])
            } else {
                CapturedViews(Vec::new())
            };
            // Native destruction and events happen only after settlement.
            drop(lifecycle);
            destroy_captured_views(app, stale_windows);
            if let Some(profile) = stale_profile {
                profiles::remove_profile_data(app, &profile);
            }
            // Both stores were reopened before releasing the outbound gate.
            if let Some(revoke) = &outcome.revoke {
                // Same upstream identity logged in again: the previous
                // generation's page and profile go away, tabs in that profile included.
                crate::browser_tabs::close_account(app, revoke.account_id.as_str());
                let old_ctx = AccountContext::new(
                    revoke.account_id.clone(),
                    revoke.environment.clone(),
                    revoke.revoked_generation,
                );
                crate::adapter::on_account_removed(app, &old_ctx);
            }
            if let Some(window) = completed_window {
                let _ = window.destroy();
            }
            crate::windows::show_main(app);
            log::info!(
                "account {id}: identity published (new: {})",
                outcome.is_new_account
            );
            persist_and_emit(app);
            if let Err(error) = storage {
                events::toast(
                    app,
                    "账号存储恢复失败，已暂停；请检查磁盘或钥匙串后重新登录",
                );
                return Err(error);
            }
            Ok(outcome.ctx)
        }
        Binding::Account(id) => {
            let ls = login_state(app);
            let lifecycle = ls.lifecycle();
            require_identity_binding(&ls.lock(), label, &id)?;
            let account_id = AccountId::new(id.clone());
            let (ctx, old, storage) = crate::adapter::with_outbound_transition(app, |journal| {
                let mut old = None;
                let ctx = {
                    let mut cores = host.lock();
                    if cores.accounts.account_for(&environment, &upstream.buid)
                        != Some(account_id.clone())
                    {
                        return Err(app_err(
                            core_account::codes::ACCOUNT_IDENTITY_MISMATCH,
                            "page identity does not belong to the bound account",
                        ));
                    }
                    match cores.accounts.state(&account_id).map(|s| s.kind()) {
                        Some(AccountStateKind::Online) => cores
                            .accounts
                            .current_context(&account_id)
                            .ok_or_else(|| app_err(codes::ACCOUNT_UNKNOWN, "unknown account"))?,
                        Some(AccountStateKind::Suspended | AccountStateKind::Invalid) => {
                            old = cores.accounts.current_context(&account_id);
                            let ctx = cores.accounts.resume_quick_login(&account_id)?;
                            let _ = cores.im.invalidate_generation(ctx.clone());
                            ctx
                        }
                        _ => {
                            return Err(app_err(
                                core_account::codes::ACCOUNT_NOT_ONLINE,
                                "account needs a new login",
                            ))
                        }
                    }
                };
                // Also reopens a successfully identity-verified recovery page:
                // replace_identity kept it Online but its namespace was locked.
                let storage = reopen_account_storage(&host, journal, &ctx);
                Ok::<_, AppError>((ctx, old, storage))
            })?;
            {
                let ls = login_state(app);
                let mut inner = ls.lock();
                inner.validating.remove(&id);
                if let Some(m) = inner.meta.get_mut(&id) {
                    m.update_identity(&identity);
                }
            }
            drop(lifecycle);
            if let Some(old) = old {
                crate::adapter::on_account_removed(app, &old);
            }
            persist_and_emit(app);
            if let Err(error) = storage {
                events::toast(app, "账号存储恢复失败，已暂停；请检查磁盘后重新登录");
                return Err(error);
            }
            Ok(ctx)
        }
    }
}

/// Both account and source resource are checked in the same Cores critical
/// section as generation revocation. Caller already owns lifecycle + journal.
fn invalidate_redirect_account(
    cores: &mut crate::state::Cores,
    account: &AccountContext,
    source: &ViewContext,
) -> bool {
    if cores.views.current(&source.webview_label).as_ref() != Some(source) {
        return false;
    }
    let current = cores.accounts.current_context(&account.account_id);
    let kind = cores
        .accounts
        .state(&account.account_id)
        .map(|state| state.kind());
    if current.as_ref() != Some(account)
        || !matches!(
            kind,
            Some(AccountStateKind::Online | AccountStateKind::Suspended)
        )
    {
        return false;
    }
    if cores
        .accounts
        .invalidate(&account.account_id, "web session reported auth invalid")
        .is_err()
    {
        return false;
    }
    if let Some(new_ctx) = cores.accounts.current_context(&account.account_id) {
        let _ = cores.im.invalidate_generation(new_ctx);
    }
    true
}

/// Called only with the callback's captured account and native resource.
fn on_auth_invalid(app: &AppHandle, account: &AccountContext, source: &ViewContext) {
    let ls = login_state(app);
    let lifecycle = ls.lifecycle();
    let host = app.state::<HostState>();
    let transition = crate::adapter::with_outbound_transition(app, |journal| {
        let changed = invalidate_redirect_account(&mut host.lock(), account, source);
        changed.then(|| lock_account_storage(&host, journal, account))
    });
    let Some(storage) = transition else { return };
    let labels = detach_account_views(&mut ls.lock(), account.account_id.as_str());
    let windows = capture_account_views(app, labels);
    drop(lifecycle);
    finish_auth_invalid(app, account, windows, storage);
}

fn finish_auth_invalid(
    app: &AppHandle,
    account: &AccountContext,
    windows: CapturedViews<tauri::WebviewWindow>,
    storage: Result<(), AppError>,
) {
    destroy_captured_views(app, windows);
    crate::adapter::on_account_removed(app, account);
    events::toast(
        app,
        "账号登录已失效或可能已在其他位置登录，请重新登录；同一账号不支持与官方网页同时在线。",
    );
    if let Err(error) = storage {
        log::error!(
            "account {}: outbound logout lock failed: {}",
            account.account_id,
            error.code
        );
        events::toast(app, "账号已停用，但存储锁写入失败；请检查磁盘后重新登录");
    }
    persist_and_emit(app);
}

/// AuthInvalid's actual registry transition occurs in push_fact, not in the
/// later UI cleanup. Gate that transition and its marker as one operation.
pub(crate) fn push_auth_invalid(
    app: &AppHandle,
    envelope: crate::dto::AdapterFactEnvelopeDto,
) -> Result<core_im::IngestReport, AppError> {
    let account: AccountContext = envelope.account.clone().into();
    let ls = login_state(app);
    let lifecycle = ls.lifecycle();
    let host = app.state::<HostState>();
    let (report, storage) = crate::adapter::with_outbound_transition(app, |journal| {
        let report = host.push_fact(envelope)?;
        let storage = if report.auth_invalid {
            lock_account_storage(&host, journal, &account)
        } else {
            Ok(())
        };
        Ok::<_, AppError>((report, storage))
    })?;
    let windows = if report.auth_invalid {
        let labels = detach_account_views(&mut ls.lock(), account.account_id.as_str());
        capture_account_views(app, labels)
    } else {
        CapturedViews(Vec::new())
    };
    drop(lifecycle);
    if report.auth_invalid {
        finish_auth_invalid(app, &account, windows, storage.clone());
    }
    storage?;
    Ok(report)
}

/// Per-account unread total for the title-bar tab badge (emits account://changed when it changes).
pub fn set_unread(app: &AppHandle, account: &contracts::AccountContext, unread: u32) {
    {
        let host = app.state::<HostState>();
        if host.lock().accounts.validate(account).is_err() {
            return;
        }
    }
    let changed = {
        let ls = login_state(app);
        let mut inner = ls.lock();
        let id = account.account_id.as_str().to_string();
        inner.unread.insert(id, unread) != Some(unread)
    };
    if changed {
        emit_changed(app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colors_are_stable_and_from_palette() {
        let a = color_for("acc_0123456789abcdef");
        assert_eq!(a, color_for("acc_0123456789abcdef"));
        assert!(AVATAR_COLORS.contains(&a.as_str()));
    }

    #[test]
    fn ui_states() {
        assert_eq!(ui_state(AccountStateKind::Online, true), "online");
        assert_eq!(ui_state(AccountStateKind::Suspended, false), "suspended");
        assert_eq!(ui_state(AccountStateKind::Suspended, true), "logging_in");
        assert_eq!(ui_state(AccountStateKind::Invalid, false), "expired");
        assert_eq!(ui_state(AccountStateKind::LoggedOut, false), "expired");
    }

    #[test]
    fn identity_dto_keeps_person_profile_distinct_from_platform_nick() {
        let input = json!({"buid":"platform", "uid":"self", "agent_id":null, "nick":"Platform", "party":"Merchant", "environment":"production", "self_profile":{"uid":"self","name":"Agent","avatar":"https://example.invalid/self.png"}});
        let dto: UpstreamIdentityDto = serde_json::from_value(input.clone()).unwrap();
        let serialized = serde_json::to_value(dto).unwrap();
        assert_eq!(serialized["self_profile"], input["self_profile"]);
        assert_eq!(serialized["nick"], "Platform");
    }

    #[test]
    fn account_person_profile_requires_matching_uid_and_never_persists() {
        let mut dto: UpstreamIdentityDto = serde_json::from_value(json!({"buid":"platform", "uid":"self", "agent_id":null, "nick":"Platform", "party":"Merchant", "environment":"production", "self_profile":{"uid":"SELF","name":"Agent","avatar":"https://example.invalid/self.png?auth=synthetic"}})).unwrap();
        let mut meta = AccountMeta::default();
        meta.update_identity(&dto);
        assert_eq!(meta.self_profile.as_ref().unwrap().uid, "SELF");
        assert_eq!(meta.nick, "Platform");
        let serialized = serde_json::to_string(&meta).unwrap();
        assert!(!serialized.contains("self_profile"));
        assert!(!serialized.contains("synthetic"));
        assert!(serde_json::from_str::<AccountMeta>(&serialized)
            .unwrap()
            .self_profile
            .is_none());
        let mut other = AccountMeta::default();
        dto.uid = "other-person".into();
        other.update_identity(&dto);
        assert!(other.self_profile.is_none());
        assert!(
            meta.self_profile.is_some(),
            "accounts do not share mutable profiles"
        );
        meta.update_identity(&dto);
        assert!(
            meta.self_profile.is_none(),
            "changed IM identity must clear the previous image"
        );
        dto.self_profile = None;
        meta.update_identity(&dto);
        assert!(
            meta.self_profile.is_none(),
            "legacy identity input has no person picture"
        );
    }
}

#[cfg(test)]
#[path = "login_concurrency_tests.rs"]
mod concurrency_tests;

/// Crash recovery revokes the dead page's generation before any delayed reload.
/// It never retries an operation or changes the retained browser profile.
pub(crate) fn prepare_webview_recovery(app: &AppHandle, label: &str) -> Option<AccountContext> {
    let ls = login_state(app);
    let _lifecycle = ls.lifecycle();
    let id = match ls.lock().bindings.get(label).cloned()? {
        Binding::Account(id) => id,
        Binding::Attempt(_) => return None,
    };
    let host = app.state::<HostState>();
    let (old, new, storage) = crate::adapter::with_outbound_transition(app, |journal| {
        let (old, new) = {
            let mut cores = host.lock();
            let old = cores
                .accounts
                .current_context(&AccountId::new(id.clone()))?;
            cores.accounts.validate(&old).ok()?;
            let (new, _) = cores
                .accounts
                .replace_identity(&old.account_id, None)
                .ok()?;
            let _ = cores.im.invalidate_generation(new.clone());
            (old, new)
        };
        let storage = lock_account_storage(&host, journal, &old);
        if storage.is_err() {
            let _ = host.logout_context(&new, LogoutMode::ExitOnline);
        }
        Some((old, new, storage))
    })?;
    ls.lock().validating.insert(id);
    drop(_lifecycle);
    crate::adapter::on_account_removed(app, &old);
    persist_and_emit(app);
    if let Err(error) = storage {
        log::error!("recovery storage lock failed: {}", error.code);
        events::toast(app, "账号存储锁写入失败，已暂停；请重新登录");
        return None;
    }
    Some(new)
}

pub(crate) fn recovery_binding_is_current(
    app: &AppHandle,
    label: &str,
    expected: Option<&AccountContext>,
) -> bool {
    let ls = login_state(app);
    let binding = ls.lock().bindings.get(label).cloned();
    match (binding, expected) {
        (Some(Binding::Account(id)), Some(ctx)) if id == ctx.account_id.as_str() => {
            let host = app.state::<HostState>();
            let valid = host.lock().accounts.validate(ctx).is_ok();
            valid
        }
        (Some(Binding::Account(_)), _) | (_, Some(_)) => false,
        _ => true,
    }
}

#[cfg(test)]
mod adapter_queue_fault_tests {
    use super::*;
    use crate::adapter::outbound_journal::{self, OutboundJournal, SendPayload};
    use crate::dto::SendDispositionDto;
    use core_account::{AccountState, MemorySecretStore, ProfileAction};
    use core_store::{DraftBook, FileStore, Namespace};

    pub(super) fn online(host: &HostState, buid: &str) -> AccountContext {
        let mut cores = host.lock();
        let attempt = cores.accounts.start_login(Environment::production());
        let account = cores
            .accounts
            .publish_identity(
                &attempt.attempt_id,
                UpstreamIdentity {
                    buid: Buid::new(buid),
                    uid: format!("self-{buid}"),
                    agent_id: None,
                    environment: Environment::production(),
                },
            )
            .unwrap()
            .ctx;
        let mut secret_store = MemorySecretStore::new();
        let operation = cores.accounts.begin_credential_commit(&account).unwrap();
        cores
            .accounts
            .stage_credential(
                &operation.operation_id,
                &mut secret_store,
                &Secret::new(b"synthetic-retained-marker".to_vec()),
            )
            .unwrap();
        cores
            .accounts
            .commit_credential(&operation.operation_id, &mut secret_store)
            .unwrap();
        account
    }
    fn bind(
        host: &HostState,
        inner: &mut Inner,
        account: &AccountContext,
        label: &str,
        epoch: u64,
    ) -> ViewContext {
        let mut cores = host.lock();
        let view = cores.views.register(label);
        inner.bindings.insert(
            label.into(),
            Binding::Account(account.account_id.as_str().into()),
        );
        inner.meta.insert(
            account.account_id.as_str().into(),
            AccountMeta {
                profile_id: Some(format!("profile-{}", account.account_id)),
                ..AccountMeta::default()
            },
        );
        assert_eq!(
            publish_adapter_ready(inner, &cores.accounts, &cores.views, label, epoch).unwrap(),
            Some(account.clone())
        );
        view
    }
    fn claim(
        host: &HostState,
        inner: &mut Inner,
        label: &str,
        account: &AccountContext,
        epoch: u64,
    ) -> Option<AdapterReadyLease> {
        let cores = host.lock();
        take_queue_fault_lease(
            inner,
            &cores.accounts,
            cores.views.current(label).as_ref(),
            label,
            account,
            epoch,
        )
    }

    #[test]
    fn bridge_fault_notifications_distinguish_capacity_from_delivery_failure() {
        assert_eq!(
            bridge_fault_message(&BridgeFaultReason::QueueOverflow),
            "消息通道过载，已暂停，请重新登录"
        );
        let delivery = bridge_fault_message(&BridgeFaultReason::DeliveryFailed);
        assert_eq!(delivery, "消息同步失败，已暂停，请重新登录");
        assert!(!delivery.contains("过载"));
        assert!(!delivery.contains("登录失效"));
    }

    #[test]
    fn latest_ready_full_account_and_boot_are_required_without_consuming_a_valid_successor() {
        let host = HostState::new(None, 1);
        let a = online(&host, "a");
        let b = online(&host, "b");
        let mut inner = Inner::default();
        bind(&host, &mut inner, &a, "acct-a", 10);
        bind(&host, &mut inner, &b, "acct-b", 20);
        {
            let cores = host.lock();
            publish_adapter_ready(&mut inner, &cores.accounts, &cores.views, "acct-a", 11).unwrap();
        }
        {
            let cores = host.lock();
            // Epoch allocation can precede lifecycle-lock acquisition. A
            // delayed older READY must not overwrite the newer accepted lease.
            assert!(
                publish_adapter_ready(&mut inner, &cores.accounts, &cores.views, "acct-a", 10)
                    .is_err()
            );
            assert_eq!(inner.adapter_ready["acct-a"].boot_epoch, 11);
        }
        let mut foreign_environment = a.clone();
        foreign_environment.environment = Environment::named("other");
        let mut old = a.clone();
        old.session_generation -= 1;
        for (label, ctx, epoch) in [
            ("acct-a", b.clone(), 11),
            ("acct-b", a.clone(), 20),
            ("acct-a", foreign_environment, 11),
            ("acct-a", old, 11),
            ("acct-a", a.clone(), 10),
            ("acct-a", a.clone(), 0),
        ] {
            assert!(claim(&host, &mut inner, label, &ctx, epoch).is_none());
            assert!(host.lock().accounts.validate(&a).is_ok());
            assert!(host.lock().accounts.validate(&b).is_ok());
        }
        assert!(claim(&host, &mut inner, "acct-a", &a, 11).is_some());
        assert!(claim(&host, &mut inner, "acct-b", &b, 20).is_some());
    }

    #[test]
    fn replaced_native_resource_page_start_and_account_generation_invalidate_old_leases() {
        let host = HostState::new(None, 1);
        let old = online(&host, "a");
        let mut inner = Inner::default();
        let old_view = bind(&host, &mut inner, &old, "acct-a", 10);
        let replacement_view = host.lock().views.register("acct-a");
        assert_ne!(old_view, replacement_view);
        assert!(claim(&host, &mut inner, "acct-a", &old, 10).is_none());
        assert!(host.suspend_current_view(&old, &old_view).is_err());
        {
            let cores = host.lock();
            publish_adapter_ready(&mut inner, &cores.accounts, &cores.views, "acct-a", 11).unwrap();
        }
        // Same resource, new document: the page-start callback drops its lease.
        inner.adapter_ready.remove("acct-a");
        assert!(claim(&host, &mut inner, "acct-a", &old, 11).is_none());
        let new = online(&host, "a");
        assert_ne!(new.session_generation, old.session_generation);
        {
            let cores = host.lock();
            publish_adapter_ready(&mut inner, &cores.accounts, &cores.views, "acct-a", 12).unwrap();
        }
        assert!(claim(&host, &mut inner, "acct-a", &old, 11).is_none());
        assert!(host.lock().accounts.validate(&new).is_ok());
        assert!(claim(&host, &mut inner, "acct-a", &new, 12).is_some());
    }

    #[test]
    fn queue_fault_revokes_once_only_and_keeps_profile_credentials_and_other_accounts() {
        let host = HostState::new(None, 1);
        let a = online(&host, "a");
        let b = online(&host, "b");
        let mut inner = Inner::default();
        bind(&host, &mut inner, &a, "acct-a", 10);
        bind(&host, &mut inner, &b, "acct-b", 20);
        let profile = inner.meta[a.account_id.as_str()].profile_id.clone();
        let revision = host.lock().accounts.credential_revision(&a.account_id);
        let lease = claim(&host, &mut inner, "acct-a", &a, 10).unwrap();
        let revoke = host
            .suspend_current_view(&lease.account, &lease.view)
            .unwrap();
        let labels = detach_overloaded_account(&mut inner, a.account_id.as_str());
        assert_eq!(labels, ["acct-a"]);
        assert_eq!(revoke.credential, CredentialAction::Keep);
        assert_eq!(revoke.profile_action, ProfileAction::Isolate);
        assert!(matches!(
            host.lock().accounts.state(&a.account_id),
            Some(AccountState::Suspended(_))
        ));
        let paused = host.lock().accounts.current_context(&a.account_id).unwrap();
        assert!(paused.session_generation > a.session_generation);
        assert_eq!(
            host.lock().accounts.credential_revision(&a.account_id),
            revision
        );
        assert_eq!(inner.meta[a.account_id.as_str()].profile_id, profile);
        assert!(inner.meta[a.account_id.as_str()].suspended_by_user);
        assert!(current_adapter_account(&inner, &host.lock().accounts, "acct-a").is_none());
        assert!(claim(&host, &mut inner, "acct-a", &a, 10).is_none());
        assert_eq!(
            host.lock().accounts.current_context(&a.account_id),
            Some(paused)
        );
        assert!(host.lock().accounts.validate(&b).is_ok());
        assert!(inner.bindings.contains_key("acct-b"));
        assert!(require_identity_binding(&inner, "acct-a", a.account_id.as_str()).is_err());
        assert!(require_identity_binding(&inner, "acct-b", b.account_id.as_str()).is_ok());
        assert!(claim(&host, &mut inner, "acct-b", &b, 20).is_some());
    }

    #[test]
    fn queue_pause_preserves_real_draft_and_unknown_outbound_ledger_without_redispatch() {
        let root = std::env::temp_dir().join(format!("vbk-queue-pause-{}", uuid::Uuid::new_v4()));
        let host = HostState::new(Some(FileStore::open(root.join("state")).unwrap()), 1);
        let a = online(&host, "a");
        let mut inner = Inner::default();
        bind(&host, &mut inner, &a, "acct-a", 10);
        let store = host.lock().store.clone().unwrap();
        let ns = Namespace::from_context(&a);
        DraftBook::save(store.as_ref(), &ns, "room", "retained draft", 0).unwrap();
        let journal = Mutex::new(OutboundJournal::open(root.join("outbound")).unwrap());
        let payload = SendPayload {
            gid: "room".into(),
            text: "synthetic text".into(),
            original: None,
            quote_id: None,
        };
        let outcome = tauri::async_runtime::block_on(outbound_journal::send_once(
            &journal,
            &a,
            "local-unknown",
            &payload,
            || async { Ok(SendDispositionDto::Unknown) },
        ))
        .unwrap();
        assert_eq!(outcome, SendDispositionDto::Unknown);
        let before = journal.lock().unwrap().unknown_metadata(&a).unwrap();
        assert_eq!(before.len(), 1);
        let lease = claim(&host, &mut inner, "acct-a", &a, 10).unwrap();
        host.suspend_current_view(&lease.account, &lease.view)
            .unwrap();
        detach_overloaded_account(&mut inner, a.account_id.as_str());
        assert!(host.flush_persist(Duration::from_secs(5)));
        let paused = host.lock().accounts.current_context(&a.account_id).unwrap();
        assert_eq!(
            DraftBook::load(store.as_ref(), &ns).unwrap()[0].text,
            "retained draft"
        );
        assert!(journal.lock().unwrap().unknown_metadata(&paused).unwrap() == before);
        let replay = tauri::async_runtime::block_on(outbound_journal::send_once(
            &journal,
            &paused,
            "local-unknown",
            &payload,
            || async { panic!("queue pause cannot authorize redispatch") },
        ))
        .unwrap();
        assert_eq!(replay, SendDispositionDto::Unknown);
        drop(journal);
        drop(store);
        drop(host);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn attempt_or_unverified_identity_has_no_ready_lease_to_fault() {
        let host = HostState::new(None, 1);
        let a = online(&host, "a");
        let mut inner = Inner::default();
        bind(&host, &mut inner, &a, "acct-a", 10);
        inner.validating.insert(a.account_id.as_str().into());
        {
            let cores = host.lock();
            assert!(
                publish_adapter_ready(&mut inner, &cores.accounts, &cores.views, "acct-a", 11)
                    .unwrap()
                    .is_none()
            );
        }
        assert!(claim(&host, &mut inner, "acct-a", &a, 10).is_none());
        inner.validating.clear();
        inner
            .bindings
            .insert("acct-a".into(), Binding::Attempt("unpublished".into()));
        {
            let cores = host.lock();
            assert!(
                publish_adapter_ready(&mut inner, &cores.accounts, &cores.views, "acct-a", 12)
                    .unwrap()
                    .is_none()
            );
        }
        assert!(inner.adapter_ready.is_empty());
    }
}

#[cfg(test)]
mod outbound_lifecycle_tests {
    use super::adapter_queue_fault_tests::online;
    use super::*;
    use crate::adapter::outbound_journal::{self, OutboundJournal, SendPayload};
    use crate::dto::SendDispositionDto;
    use core_account::{CredentialRef, MemorySecretStore, StagedRef};
    use core_store::{FileStore, Namespace, Store};
    use std::future::Future;
    use std::sync::{Arc, Barrier};

    struct Fixture {
        root: std::path::PathBuf,
        host: Arc<HostState>,
        journal: Arc<Mutex<OutboundJournal>>,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("vbk-lifecycle-{}", uuid::Uuid::new_v4()));
            let host = Arc::new(HostState::new(
                Some(FileStore::open(root.join("main")).unwrap()),
                10,
            ));
            let journal = Arc::new(Mutex::new(
                OutboundJournal::open(root.join("outbound")).unwrap(),
            ));
            Self {
                root,
                host,
                journal,
            }
        }
        fn main(&self) -> FileStore {
            FileStore::open(self.root.join("main")).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.host.flush_persist(Duration::from_secs(5));
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
    fn run<T>(f: impl Future<Output = T>) -> T {
        struct Wake;
        impl std::task::Wake for Wake {
            fn wake(self: Arc<Self>) {}
        }
        let w = std::task::Waker::from(Arc::new(Wake));
        let mut cx = std::task::Context::from_waker(&w);
        let mut f = std::pin::pin!(f);
        loop {
            if let std::task::Poll::Ready(v) = f.as_mut().poll(&mut cx) {
                return v;
            }
        }
    }
    fn payload() -> SendPayload {
        SendPayload {
            gid: "room".into(),
            text: "private".into(),
            original: None,
            quote_id: None,
        }
    }
    fn confirmed() -> SendDispositionDto {
        SendDispositionDto::Confirmed {
            server_message_id: "server-1".into(),
            server_time_ms: 1,
        }
    }
    fn send(f: &Fixture, ctx: &AccountContext, id: &str) -> Result<SendDispositionDto, AppError> {
        run(outbound_journal::send_once_authorized(
            &f.journal,
            ctx,
            id,
            &payload(),
            || f.host.lock().accounts.validate(ctx),
            || async { Ok(confirmed()) },
        ))
    }

    #[test]
    fn old_command_waiting_for_gate_cannot_write_after_reauthentication() {
        let f = Fixture::new();
        let old = online(&f.host, "race");
        let barrier = Arc::new(Barrier::new(2));
        let held = f.journal.lock().unwrap();
        let host = f.host.clone();
        let journal = f.journal.clone();
        let ready = barrier.clone();
        let stale = old.clone();
        let queued = std::thread::spawn(move || {
            // The initial command ACL check passed before waiting for storage.
            host.lock().accounts.validate(&stale).unwrap();
            ready.wait();
            run(outbound_journal::send_once_authorized(
                &journal,
                &stale,
                "old",
                &payload(),
                || host.lock().accounts.validate(&stale),
                || async { panic!("old dispatch") },
            ))
        });
        barrier.wait();
        f.host.logout_context(&old, LogoutMode::ExitOnline).unwrap();
        held.logout_lock(&old).unwrap();
        let new = online(&f.host, "race");
        reopen_account_storage(&f.host, Some(&held), &new).unwrap();
        drop(held);
        assert!(queued.join().unwrap().is_err());
        assert_eq!(send(&f, &new, "new").unwrap(), confirmed());
        assert!(f
            .journal
            .lock()
            .unwrap()
            .unknown_metadata(&new)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn logout_wins_late_confirmation_and_relogin_never_replays_it() {
        let f = Fixture::new();
        let old = online(&f.host, "late");
        let observed = run(outbound_journal::send_once_authorized(
            &f.journal,
            &old,
            "intent",
            &payload(),
            || f.host.lock().accounts.validate(&old),
            || async {
                outbound_journal::with_transition(Some(&f.journal), |journal| {
                    f.host.logout_context(&old, LogoutMode::ExitOnline).unwrap();
                    journal.unwrap().logout_lock(&old).unwrap();
                    let new = online(&f.host, "late");
                    reopen_account_storage(&f.host, journal, &new).unwrap();
                });
                Ok(confirmed())
            },
        ))
        .unwrap();
        assert_eq!(observed, SendDispositionDto::Unknown);
        let new = f
            .host
            .lock()
            .accounts
            .current_context(&old.account_id)
            .unwrap();
        assert_eq!(
            send(&f, &new, "intent").unwrap(),
            SendDispositionDto::Unknown
        );
        let reopened = OutboundJournal::open(f.root.join("outbound")).unwrap();
        let unknown = reopened.unknown_metadata(&new).unwrap();
        assert_eq!(unknown.len(), 1);
        assert_eq!(unknown[0].creation_generation, old.session_generation);
    }

    #[test]
    fn completed_before_logout_stays_confirmed_and_failed_transition_never_relocks_new_session() {
        let f = Fixture::new();
        let old = online(&f.host, "finished");
        assert_eq!(send(&f, &old, "complete").unwrap(), confirmed());
        let new = outbound_journal::with_transition(Some(&f.journal), |journal| {
            f.host.logout_context(&old, LogoutMode::ExitOnline).unwrap();
            journal.unwrap().logout_lock(&old).unwrap();
            let new = online(&f.host, "finished");
            reopen_account_storage(&f.host, journal, &new).unwrap();
            new
        });
        let stale_transition = outbound_journal::with_transition(Some(&f.journal), |journal| {
            f.host.logout_context(&old, LogoutMode::ExitOnline)?;
            journal.unwrap().logout_lock(&old)
        });
        assert!(stale_transition.is_err());
        assert!(!f
            .journal
            .lock()
            .unwrap()
            .store
            .is_locked(&Namespace::from_context(&new))
            .unwrap());
        assert_eq!(send(&f, &new, "complete").unwrap(), confirmed());
        assert_eq!(send(&f, &new, "fresh").unwrap(), confirmed());
    }

    #[test]
    fn namespace_lock_failure_revokes_authority_and_never_erases_unknown() {
        use core_store::hooks::{inject, FailPoint, FaultAction};
        let f = Fixture::new();
        let old = online(&f.host, "disk-failure");
        let value = run(outbound_journal::send_once_authorized(
            &f.journal,
            &old,
            "unknown",
            &payload(),
            || f.host.lock().accounts.validate(&old),
            || async { Ok(SendDispositionDto::Unknown) },
        ))
        .unwrap();
        assert_eq!(value, SendDispositionDto::Unknown);
        let fault = inject(
            &f.root.join("outbound"),
            FailPoint::BeforeSyncAll,
            FaultAction::Io(std::io::ErrorKind::StorageFull, "ENOSPC"),
            0,
            Some(1),
        );
        let result = outbound_journal::with_transition(Some(&f.journal), |journal| {
            f.host.logout_context(&old, LogoutMode::ExitOnline).unwrap();
            lock_account_storage(&f.host, journal, &old)
        });
        assert!(result.is_err());
        drop(fault);
        assert!(send(&f, &old, "no-send").is_err());
        assert_eq!(
            f.journal
                .lock()
                .unwrap()
                .unknown_metadata(&old)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn outbound_unlock_failure_does_not_publish_online_authority() {
        let f = Fixture::new();
        let ctx = online(&f.host, "unlock-failure");
        let result = outbound_journal::with_transition(Some(&f.journal), |journal| {
            let journal = journal.unwrap();
            journal.logout_lock(&ctx).unwrap();
            let marker = journal
                .store
                .namespace_dir(&Namespace::from_context(&ctx))
                .join("logout.lock");
            // A directory cannot be unlinked as the marker. This is an actual
            // filesystem failure at the unlock operation, not a mocked status.
            std::fs::remove_file(&marker).unwrap();
            std::fs::create_dir(&marker).unwrap();
            reopen_account_storage(&f.host, Some(journal), &ctx)
        });
        assert!(result.is_err());
        assert!(f.host.lock().accounts.validate(&ctx).is_err());
        assert!(send(&f, &ctx, "blocked").is_err());
    }

    #[test]
    fn late_media_confirm_after_reauth_keeps_unknown_pin_and_new_draft_reference() {
        use crate::media_outbound::{FrozenAttachment, MediaTarget};
        let f = Fixture::new();
        let old = online(&f.host, "media-late");
        let source = f.root.join("source.bin");
        std::fs::write(&source, b"old attachment").unwrap();
        let target = || MediaTarget {
            target_token: "current-page-only".into(),
            identity_sha256: "a".repeat(64),
            sender_id: "self".into(),
        };
        let mut frozen = FrozenAttachment::read(&source, "file", &old, "room", target()).unwrap();
        let lease = outbound_journal::with_authorized(
            &f.journal,
            || f.host.lock().accounts.validate(&old),
            |journal| {
                let id = journal.persist_attachment(&frozen)?;
                frozen.dto.lease_id = Some(id.clone());
                journal.set_draft_attachment(&old, "room", Some(&id), 0, &f.main())?;
                let captured = journal.capture_media_draft_version(&old, &frozen)?;
                assert!(journal.reserve_media_attachment_captured(
                    &old,
                    "media-intent",
                    &frozen,
                    captured
                )?);
                Ok(id)
            },
        )
        .unwrap();
        let new = outbound_journal::with_transition(Some(&f.journal), |journal| {
            f.host.logout_context(&old, LogoutMode::ExitOnline).unwrap();
            lock_account_storage(&f.host, journal, &old).unwrap();
            let new = online(&f.host, "media-late");
            reopen_account_storage(&f.host, journal, &new).unwrap();
            new
        });
        std::fs::write(&source, b"new attachment").unwrap();
        let newer = FrozenAttachment::read(&source, "file", &new, "room", target()).unwrap();
        let new_id = outbound_journal::with_authorized(
            &f.journal,
            || f.host.lock().accounts.validate(&new),
            |journal| {
                let pending = journal.load_draft(&new, "room", &f.main())?.unwrap();
                assert_eq!(
                    pending.attachments[0].state,
                    crate::attachment_leases::LeaseState::Pending
                );
                assert!(journal
                    .restore_attachment(&new, "room", &lease, target())
                    .is_err());
                let id = journal.persist_attachment(&newer)?;
                journal.set_draft_attachment(
                    &new,
                    "room",
                    Some(&id),
                    pending.attachment_version,
                    &f.main(),
                )?;
                Ok(id)
            },
        )
        .unwrap();
        assert!(outbound_journal::with_authorized(
            &f.journal,
            || f.host.lock().accounts.validate(&old),
            |journal| journal.finish_media(&old, "media-intent", &frozen.payload(), confirmed())
        )
        .is_err());
        let reopened = OutboundJournal::open(f.root.join("outbound")).unwrap();
        reopened.release_attachment(&new, "room", &lease).unwrap();
        let unknown_lease = reopened
            .store
            .get(&Namespace::from_context(&new), "attachment_leases", &lease)
            .unwrap()
            .unwrap();
        assert!(
            unknown_lease.to_json().contains("media-intent"),
            "unknown owns its durable outbox reference"
        );
        let draft = reopened
            .load_draft(&new, "room", &f.main())
            .unwrap()
            .unwrap();
        assert_eq!(draft.attachments[0].lease_id, new_id);
        assert_eq!(draft.attachment_version, 2);
        assert_eq!(reopened.unknown_metadata(&new).unwrap().len(), 1);
    }

    #[test]
    fn delayed_exit_and_auth_cleanup_destroy_only_captured_instances_and_preserve_new_metadata() {
        for mode in [
            Some(LogoutMode::ExitOnline),
            Some(LogoutMode::Logout),
            Some(LogoutMode::Forget),
            None,
        ] {
            let f = Fixture::new();
            let old = online(&f.host, "cleanup-race");
            let ls = Arc::new(LoginState {
                active_visit_epoch: AtomicU64::new(0),
                inner: Mutex::new(Inner::default()),
                persist_lock: Mutex::new(()),
                start_lock: Mutex::new(()),
                lifecycle_lock: Mutex::new(()),
                restoring: AtomicBool::new(false),
                data_dir: f.root.clone(),
            });
            let old_instance = Arc::new(AtomicBool::new(false));
            let new_instance = Arc::new(AtomicBool::new(false));
            let instances = Arc::new(Mutex::new(HashMap::from([(
                "reused-label".to_string(),
                old_instance.clone(),
            )])));
            {
                let mut inner = ls.lock();
                inner.bindings.insert(
                    "reused-label".into(),
                    Binding::Account(old.account_id.as_str().into()),
                );
                inner.meta.insert(
                    old.account_id.as_str().into(),
                    AccountMeta {
                        profile_id: Some("old-profile".into()),
                        ..AccountMeta::default()
                    },
                );
                inner.unread.insert(old.account_id.as_str().into(), 7);
            }
            let captured = Arc::new(Barrier::new(2));
            let resume = Arc::new(Barrier::new(2));
            let (
                thread_host,
                thread_journal,
                thread_login,
                thread_instances,
                entered,
                release,
                old_ctx,
            ) = (
                f.host.clone(),
                f.journal.clone(),
                ls.clone(),
                instances.clone(),
                captured.clone(),
                resume.clone(),
                old.clone(),
            );
            let cleanup = std::thread::spawn(move || {
                let lifecycle = thread_login.lifecycle();
                outbound_journal::with_transition(Some(&thread_journal), |journal| {
                    if let Some(mode) = mode {
                        thread_host.logout_context(&old_ctx, mode).unwrap();
                    } else {
                        thread_host
                            .lock()
                            .accounts
                            .invalidate(&old_ctx.account_id, "auth invalid")
                            .unwrap();
                    }
                    lock_account_storage(&thread_host, journal, &old_ctx).unwrap();
                });
                // These are the same settlement/capture functions used by
                // exit_account and both AuthInvalid production entry points.
                let labels = if let Some(mode) = mode {
                    let (labels, profile) = settle_account_exit(
                        &mut thread_login.lock(),
                        old_ctx.account_id.as_str(),
                        mode,
                    );
                    assert_eq!(profile.as_deref(), Some("old-profile"));
                    labels
                } else {
                    detach_account_views(&mut thread_login.lock(), old_ctx.account_id.as_str())
                };
                let plan = CapturedViews::capture(labels, |label| {
                    thread_instances.lock().unwrap().get(label).cloned()
                });
                drop(lifecycle);
                entered.wait();
                release.wait();
                plan.destroy(|instance| instance.store(true, Ordering::SeqCst));
            });
            captured.wait();
            let new = {
                let _lifecycle = ls.lifecycle();
                outbound_journal::with_transition(Some(&f.journal), |journal| {
                    let new = online(&f.host, "cleanup-race");
                    reopen_account_storage(&f.host, journal, &new).unwrap();
                    let mut inner = ls.lock();
                    assert!(
                        allow_retired_view_rebind(&mut inner, "reused-label", true)
                            .unwrap_err()
                            .retryable
                    );
                    assert!(require_identity_not_retiring(&inner, "reused-label").is_err());
                    // Native manager no longer owns the old instance; only
                    // then may a distinct successor reuse the label.
                    allow_retired_view_rebind(&mut inner, "reused-label", false).unwrap();
                    inner.bindings.insert(
                        "reused-label".into(),
                        Binding::Account(new.account_id.as_str().into()),
                    );
                    inner.meta.insert(
                        new.account_id.as_str().into(),
                        AccountMeta {
                            profile_id: Some("new-profile".into()),
                            suspended_by_user: false,
                            ..AccountMeta::default()
                        },
                    );
                    inner.unread.insert(new.account_id.as_str().into(), 99);
                    inner.active = Some(new.account_id.as_str().into());
                    instances
                        .lock()
                        .unwrap()
                        .insert("reused-label".into(), new_instance.clone());
                    new
                })
            };
            resume.wait();
            cleanup.join().unwrap();
            assert!(old_instance.load(Ordering::SeqCst));
            assert!(
                !new_instance.load(Ordering::SeqCst),
                "old cleanup must never resolve the reused label again"
            );
            let inner = ls.lock();
            assert_eq!(
                inner.bindings.get("reused-label"),
                Some(&Binding::Account(new.account_id.as_str().into()))
            );
            let meta = &inner.meta[new.account_id.as_str()];
            assert_eq!(meta.profile_id.as_deref(), Some("new-profile"));
            assert!(!meta.suspended_by_user);
            assert_eq!(inner.unread[new.account_id.as_str()], 99);
            drop(inner);
            assert!(f.host.lock().accounts.validate(&new).is_ok());
            assert!(!f
                .journal
                .lock()
                .unwrap()
                .store
                .is_locked(&Namespace::from_context(&new))
                .unwrap());
        }
    }

    #[test]
    fn queued_old_login_redirect_cannot_borrow_new_context_from_reused_label() {
        let f = Fixture::new();
        let old = online(&f.host, "redirect-race");
        let ls = Arc::new(LoginState {
            active_visit_epoch: AtomicU64::new(0),
            inner: Mutex::new(Inner::default()),
            persist_lock: Mutex::new(()),
            start_lock: Mutex::new(()),
            lifecycle_lock: Mutex::new(()),
            restoring: AtomicBool::new(false),
            data_dir: f.root.clone(),
        });
        let source = f.host.lock().views.register("acct-reused");
        ls.lock().bindings.insert(
            source.webview_label.clone(),
            Binding::Account(old.account_id.as_str().into()),
        );
        let queued = Arc::new(Barrier::new(2));
        let resume = Arc::new(Barrier::new(2));
        let (host, journal, login, entered, release, callback_source) = (
            f.host.clone(),
            f.journal.clone(),
            ls.clone(),
            queued.clone(),
            resume.clone(),
            source.clone(),
        );
        let callback = std::thread::spawn(move || {
            // This closure carries the original ViewContext through the same
            // async-queue gap as open_account_webview's navigation callback.
            entered.wait();
            release.wait();
            let _lifecycle = login.lifecycle();
            outbound_journal::with_transition(Some(&journal), |journal| {
                let account = {
                    let cores = host.lock();
                    resolve_login_redirect(&cores, &login.lock(), &callback_source)
                        .and_then(|(_, account)| account)
                };
                let Some(account) = account else { return false };
                let changed =
                    invalidate_redirect_account(&mut host.lock(), &account, &callback_source);
                if changed {
                    lock_account_storage(&host, journal, &account).unwrap();
                }
                changed
            })
        });
        queued.wait();
        let (fresh, new_view) = {
            let _lifecycle = ls.lifecycle();
            outbound_journal::with_transition(Some(&f.journal), |journal| {
                f.host.logout_context(&old, LogoutMode::ExitOnline).unwrap();
                lock_account_storage(&f.host, journal, &old).unwrap();
                f.host.lock().views.unregister_if_current(&source);
                let new_view = f.host.lock().views.register(&source.webview_label);
                let fresh = online(&f.host, "redirect-race");
                ls.lock().bindings.insert(
                    source.webview_label.clone(),
                    Binding::Account(fresh.account_id.as_str().into()),
                );
                reopen_account_storage(&f.host, journal, &fresh).unwrap();
                (fresh, new_view)
            })
        };
        assert_ne!(source, new_view);
        resume.wait();
        assert!(!callback.join().unwrap());
        assert!(f.host.lock().accounts.validate(&fresh).is_ok());
        assert!(!f
            .journal
            .lock()
            .unwrap()
            .store
            .is_locked(&Namespace::from_context(&fresh))
            .unwrap());
        assert!(!f
            .main()
            .is_locked(&Namespace::from_context(&fresh))
            .unwrap());
        // A genuinely current source still revokes and durably locks normally.
        let _lifecycle = ls.lifecycle();
        outbound_journal::with_transition(Some(&f.journal), |journal| {
            let resolved = {
                let cores = f.host.lock();
                resolve_login_redirect(&cores, &ls.lock(), &new_view)
                    .unwrap()
                    .1
                    .unwrap()
            };
            assert!(invalidate_redirect_account(
                &mut f.host.lock(),
                &resolved,
                &new_view
            ));
            lock_account_storage(&f.host, journal, &resolved).unwrap();
        });
        assert!(f.host.lock().accounts.validate(&fresh).is_err());
        assert!(f
            .main()
            .is_locked(&Namespace::from_context(&fresh))
            .unwrap());
    }

    #[test]
    fn redirected_resource_is_rechecked_at_mutation_even_when_account_generation_is_unchanged() {
        let f = Fixture::new();
        let account = online(&f.host, "redirect-view-only");
        let source = f.host.lock().views.register("acct-recreated");
        let mut inner = Inner::default();
        inner.bindings.insert(
            source.webview_label.clone(),
            Binding::Account(account.account_id.as_str().into()),
        );
        let captured = resolve_login_redirect(&f.host.lock(), &inner, &source)
            .unwrap()
            .1
            .unwrap();
        let replacement = f.host.lock().views.register(&source.webview_label);
        assert_ne!(source, replacement);
        assert!(!invalidate_redirect_account(
            &mut f.host.lock(),
            &captured,
            &source
        ));
        assert!(f.host.lock().accounts.validate(&account).is_ok());
        assert!(invalidate_redirect_account(
            &mut f.host.lock(),
            &captured,
            &replacement
        ));
    }

    #[derive(Debug)]
    struct UnlockGate {
        entered: Barrier,
        release: Barrier,
        armed: AtomicBool,
        fail: bool,
    }
    #[derive(Debug)]
    struct GatedIo {
        inner: crate::attachment_leases::SafeNamespaceIo,
        gate: Arc<UnlockGate>,
    }
    struct GatedDirectory {
        inner: Box<dyn core_store::file::NamespaceDirectory>,
        gate: Arc<UnlockGate>,
    }
    impl core_store::file::NamespaceIo for GatedIo {
        fn directory(
            &self,
            path: &Path,
            create: bool,
        ) -> std::io::Result<Box<dyn core_store::file::NamespaceDirectory>> {
            Ok(Box::new(GatedDirectory {
                inner: self.inner.directory(path, create)?,
                gate: self.gate.clone(),
            }))
        }
        fn rename(&self, from: &Path, to: &Path) -> std::io::Result<()> {
            self.inner.rename(from, to)
        }
    }
    impl core_store::file::NamespaceDirectory for GatedDirectory {
        fn open_file(&self, name: &str, write: bool) -> std::io::Result<std::fs::File> {
            self.inner.open_file(name, write)
        }
        fn create_new(&self, name: &str) -> std::io::Result<std::fs::File> {
            self.inner.create_new(name)
        }
        fn rename(&self, from: &str, to: &str) -> std::io::Result<()> {
            self.inner.rename(from, to)
        }
        fn remove(&self, name: &str) -> std::io::Result<()> {
            if name == "logout.lock" && self.gate.armed.swap(false, Ordering::SeqCst) {
                self.gate.entered.wait();
                self.gate.release.wait();
                if self.gate.fail {
                    return Err(std::io::Error::other("injected unlink failure"));
                }
            }
            self.inner.remove(name)
        }
        fn names(&self) -> std::io::Result<Vec<String>> {
            self.inner.names()
        }
        fn sync(&self) -> std::io::Result<()> {
            self.inner.sync()
        }
    }

    #[test]
    fn ready_waits_for_actual_main_unlock_receipt_without_holding_cores() {
        for fail in [false, true] {
            let f = Fixture::new();
            let root = f.root.join("gated-main");
            let gate = Arc::new(UnlockGate {
                entered: Barrier::new(2),
                release: Barrier::new(2),
                armed: AtomicBool::new(false),
                fail,
            });
            let store = FileStore::open(&root)
                .unwrap()
                .with_namespace_io(Arc::new(GatedIo {
                    inner: crate::attachment_leases::SafeNamespaceIo::new(&root).unwrap(),
                    gate: gate.clone(),
                }));
            let host = Arc::new(HostState::new(Some(store), 1));
            let ctx = online(&host, "gated");
            let main = FileStore::open(&root).unwrap();
            main.logout_lock(&Namespace::from_context(&ctx)).unwrap();
            f.journal.lock().unwrap().logout_lock(&ctx).unwrap();
            gate.armed.store(true, Ordering::SeqCst);
            let h = host.clone();
            let journal = f.journal.clone();
            let account = ctx.clone();
            let ready = Arc::new(AtomicBool::new(false));
            let published = ready.clone();
            let worker = std::thread::spawn(move || {
                let result = outbound_journal::with_transition(Some(&journal), |journal| {
                    reopen_account_storage(&h, journal, &account)
                });
                published.store(result.is_ok(), Ordering::SeqCst);
                result
            });
            gate.entered.wait();
            assert!(
                host.cores_available_for_test(),
                "disk worker must not retain Cores"
            );
            assert!(
                host.persist_barrier().is_ok(),
                "old barrier alone cannot imply Unlock completed"
            );
            assert!(
                f.journal.try_lock().is_err(),
                "outbound remains gated until main receipt"
            );
            assert!(!ready.load(Ordering::SeqCst));
            gate.release.wait();
            assert_eq!(worker.join().unwrap().is_err(), fail);
            assert_eq!(ready.load(Ordering::SeqCst), !fail);
            assert_eq!(host.lock().accounts.validate(&ctx).is_ok(), !fail);
            assert_eq!(
                main.is_locked(&Namespace::from_context(&ctx)).unwrap(),
                fail
            );
        }
    }

    #[test]
    fn main_logout_disk_failure_is_reported_even_if_outbound_lock_succeeds() {
        use core_store::hooks::{inject, FailPoint, FaultAction};
        let f = Fixture::new();
        let ctx = online(&f.host, "main-lock-fail");
        let fault = inject(
            &f.root.join("main"),
            FailPoint::BeforeSyncAll,
            FaultAction::Io(std::io::ErrorKind::StorageFull, "ENOSPC"),
            0,
            None,
        );
        let result = outbound_journal::with_transition(Some(&f.journal), |journal| {
            f.host.logout_context(&ctx, LogoutMode::ExitOnline).unwrap();
            lock_account_storage(&f.host, journal, &ctx)
        });
        assert!(result.is_err());
        assert!(f.host.lock().accounts.validate(&ctx).is_err());
        assert!(f
            .journal
            .lock()
            .unwrap()
            .store
            .is_locked(&Namespace::from_context(&ctx))
            .unwrap());
        drop(fault);
        let fresh = outbound_journal::with_transition(Some(&f.journal), |journal| {
            let fresh = online(&f.host, "main-lock-fail");
            reopen_account_storage(&f.host, journal, &fresh).unwrap();
            fresh
        });
        assert!(
            !f.main()
                .is_locked(&Namespace::from_context(&fresh))
                .unwrap(),
            "older failed LogoutLock must not land after fresh Unlock"
        );
        assert_eq!(send(&f, &fresh, "fresh").unwrap(), confirmed());
    }

    struct CheckedSecrets<'a> {
        host: &'a HostState,
        store: MemorySecretStore,
        fail: Option<&'static str>,
        calls: Vec<&'static str>,
    }
    impl CheckedSecrets<'_> {
        fn before(&mut self, step: &'static str) -> Result<(), AppError> {
            assert!(
                self.host.cores_available_for_test(),
                "Cores held during {step}"
            );
            self.calls.push(step);
            if self.fail == Some(step) {
                Err(app_err("credential.test_io", step))
            } else {
                Ok(())
            }
        }
    }
    impl SecretStore for CheckedSecrets<'_> {
        fn stage(
            &mut self,
            target: &CredentialRef,
            secret: &Secret,
        ) -> Result<StagedRef, AppError> {
            self.before("stage")?;
            self.store.stage(target, secret)
        }
        fn commit(&mut self, staged: &StagedRef) -> Result<(), AppError> {
            self.before("commit")?;
            self.store.commit(staged)
        }
        fn discard(&mut self, staged: &StagedRef) -> Result<(), AppError> {
            self.before("discard")?;
            self.store.discard(staged)
        }
        fn delete(&mut self, target: &CredentialRef) -> Result<(), AppError> {
            self.before("delete")?;
            self.store.delete(target)
        }
        fn contains(&self, target: &CredentialRef) -> bool {
            self.store.contains(target)
        }
    }

    #[test]
    fn profile_marker_external_io_never_holds_cores_and_each_failure_preserves_recovery_record() {
        for failing in [None, Some("stage"), Some("commit"), Some("delete")] {
            let f = Fixture::new();
            let ctx = online(&f.host, "credential");
            let before = f.host.lock().accounts.credential_revision(&ctx.account_id);
            let mut secrets = CheckedSecrets {
                host: &f.host,
                store: MemorySecretStore::new(),
                fail: failing,
                calls: vec![],
            };
            let persisted = std::cell::Cell::new(0);
            let result = commit_profile_marker(&f.host, &ctx, "profile", &mut secrets, || {
                let doc = f.host.lock().accounts.to_json().to_json();
                assert!(f.host.cores_available_for_test());
                core_store::write_atomic(&f.root, "registry.json", doc.as_bytes())?;
                persisted.set(persisted.get() + 1);
                Ok(())
            });
            assert_eq!(result.is_ok(), failing.is_none());
            let after = f.host.lock().accounts.credential_revision(&ctx.account_id);
            if failing == Some("stage") || failing == Some("commit") {
                assert_eq!(before, after, "index must not switch on failed secret IO");
            } else {
                assert!(after > before);
            }
            if failing.is_none() {
                assert_eq!(persisted.get(), 4);
            }
            if failing == Some("delete") {
                assert_eq!(persisted.get(), 3);
            }
            let disk = std::fs::read_to_string(f.root.join("registry.json")).unwrap();
            assert!(disk.contains("ledger"));
            if failing == Some("delete") {
                assert!(disk.contains("index_committed"));
            }
        }
    }

    #[test]
    fn failed_new_index_persistence_keeps_old_secret_and_pending_cleanup() {
        let f = Fixture::new();
        let ctx = online(&f.host, "credential-persist");
        let mut secrets = CheckedSecrets {
            host: &f.host,
            store: MemorySecretStore::new(),
            fail: None,
            calls: vec![],
        };
        let writes = std::cell::Cell::new(0);
        let result = commit_profile_marker(&f.host, &ctx, "profile", &mut secrets, || {
            writes.set(writes.get() + 1);
            if writes.get() == 3 {
                return Err(app_err(
                    "store.persist_failed",
                    "injected index disk failure",
                ));
            }
            let doc = f.host.lock().accounts.to_json().to_json();
            core_store::write_atomic(&f.root, "registry.json", doc.as_bytes())
        });
        assert!(result.is_err());
        assert!(!secrets.calls.contains(&"delete"));
        assert!(f
            .host
            .lock()
            .accounts
            .to_json()
            .to_json()
            .contains("index_committed"));
        assert!(std::fs::read_to_string(f.root.join("registry.json"))
            .unwrap()
            .contains("secret_staged"));
    }
}

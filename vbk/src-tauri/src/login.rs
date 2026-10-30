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
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use contracts::{codes, AccountContext, AccountId, AppError, Environment};
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

use crate::dto::{AccountContextDto, AppErrorDto};
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
    /// The login page reached a non-login page and a hidden candidate
    /// account webview is waiting for the identity.
    candidate: bool,
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
    /// "退出在线" chosen by the user: not resumed automatically at startup.
    #[serde(default)]
    suspended_by_user: bool,
}

#[derive(Debug, Default)]
struct Inner {
    bindings: HashMap<String, Binding>,
    attempts: BTreeMap<String, AttemptRec>,
    meta: BTreeMap<String, AccountMeta>,
    /// Accounts whose page is loading with a kept profile and has not
    /// reported its identity yet (shown as `logging_in`).
    validating: HashSet<String>,
    unread: HashMap<String, u32>,
    active: Option<String>,
    /// `webview-*` windows opened per account.
    extra_views: HashMap<String, Vec<String>>,
    view_seq: u64,
}

pub struct LoginState {
    inner: Mutex<Inner>,
    data_dir: PathBuf,
}

impl LoginState {
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
    let registry = {
        let host = app.state::<HostState>();
        let cores = host.lock();
        cores.accounts.to_json().to_json()
    };
    let registry: serde_json::Value = match serde_json::from_str(&registry) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("account index not persisted: {e}");
            return;
        }
    };
    let ls = login_state(app);
    let doc = {
        let inner = ls.lock();
        PersistDoc {
            version: 1,
            active_account_id: inner.active.clone(),
            accounts: inner.meta.clone(),
            registry,
        }
    };
    if let Err(e) = write_atomic(&ls.data_dir.join(ACCOUNTS_FILE), &doc) {
        log::warn!("account index not persisted: {e}");
    }
}

fn write_atomic(path: &Path, doc: &PersistDoc) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let text = serde_json::to_vec_pretty(doc).map_err(std::io::Error::other)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)
}

fn load_doc(path: &Path) -> Option<PersistDoc> {
    let text = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str(&text) {
        Ok(d) => Some(d),
        Err(e) => {
            log::error!("{}: unreadable account index: {e}", path.display());
            None
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
    let rows: Vec<(core_account::AccountSummary, u64)> = {
        let host = app.state::<HostState>();
        let cores = host.lock();
        cores
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
            .collect()
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
    })
}

fn emit_changed(app: &AppHandle) {
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
fn open_login_window(app: &AppHandle, attempt_id: &str, profile_id: &str) -> tauri::Result<()> {
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

    let size = window
        .inner_size()?
        .to_logical::<f64>(window.scale_factor()?);
    let header_h = profiles::LOGIN_HEADER_HEIGHT;

    // The header is built from a WindowConfig because that is the only
    // public way to give a child webview the macOS traffic-light inset.
    let header_cfg = tauri::utils::config::WindowConfig {
        label: views::LOGIN.to_string(),
        url: WebviewUrl::App(format!("apps/login/index.html?attempt={attempt_id}").into()),
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
    let ls = login_state(app);
    let profile_id = {
        let mut inner = ls.lock();
        let Some(rec) = inner.attempts.get_mut(attempt_id) else {
            return;
        };
        if rec.candidate {
            return;
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
            return;
        }
    }
    if let Some(w) = login_window(app) {
        let _ = w.hide();
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
            if let Some(w) = login_window(&app) {
                let _ = w.show();
                let _ = w.set_focus();
            }
            events::toast(&app, "登录确认超时，请重试或取消");
        }
    });
}

/// Hidden `acct-<profile>` window on the official IM page with the adapter
/// boot script. Registered in the `ViewRegistry` under its label.
fn open_account_webview(app: &AppHandle, profile_id: &str) -> tauri::Result<()> {
    let label = profiles::account_label(profile_id);
    {
        let host = app.state::<HostState>();
        host.lock().views.register(&label);
    }
    let url = Url::parse(profiles::ACCOUNT_IM_URL).map_err(tauri::Error::InvalidUrl)?;
    let nav_app = app.clone();
    let nav_label = label.clone();
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
                let label = nav_label.clone();
                tauri::async_runtime::spawn(async move { on_account_landed_login(&app, &label) });
            }
        },
    )?;
    Ok(())
}

/// An `acct-*` page was redirected to the official login page.
fn on_account_landed_login(app: &AppHandle, label: &str) {
    let binding = login_state(app).lock().bindings.get(label).cloned();
    match binding {
        Some(Binding::Attempt(attempt_id)) => {
            // The login window's "success" was not a real session.
            log::warn!("attempt {attempt_id}: candidate page fell back to login");
            {
                let ls = login_state(app);
                let mut inner = ls.lock();
                inner.bindings.remove(label);
                if let Some(rec) = inner.attempts.get_mut(&attempt_id) {
                    rec.candidate = false;
                }
            }
            profiles::destroy_window(app, label);
            if let Some(w) = login_window(app) {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }
        Some(Binding::Account(id)) => {
            let ctx = {
                let host = app.state::<HostState>();
                let cores = host.lock();
                cores.accounts.current_context(&AccountId::new(id.clone()))
            };
            match ctx {
                Some(ctx) => on_auth_invalid(app, &ctx),
                None => teardown_account_views(app, &id),
            }
        }
        None => {}
    }
}

fn cancel_attempt(app: &AppHandle, attempt_id: &str) {
    let rec = {
        let ls = login_state(app);
        let mut inner = ls.lock();
        let rec = inner.attempts.remove(attempt_id);
        if let Some(r) = &rec {
            inner
                .bindings
                .remove(&profiles::account_label(&r.profile_id));
        }
        rec
    };
    {
        let host = app.state::<HostState>();
        let mut cores = host.lock();
        let _ = cores.accounts.cancel_login(&AttemptId::new(attempt_id));
    }
    destroy_login_window(app);
    if let Some(rec) = rec {
        profiles::destroy_window(app, &profiles::account_label(&rec.profile_id));
        // The profile was never published: its data must not survive.
        profiles::remove_profile_data(app, &rec.profile_id);
        log::info!("attempt {attempt_id}: cancelled");
        emit_changed(app);
    }
}

// ------------------------------------------------------- account teardown

/// Closes every webview of an account (hidden adapter page and detail
/// windows). Profile data is kept.
fn teardown_account_views(app: &AppHandle, account_id: &str) {
    let (labels, extra) = {
        let ls = login_state(app);
        let mut inner = ls.lock();
        let labels: Vec<String> = inner
            .bindings
            .iter()
            .filter(|(_, b)| **b == Binding::Account(account_id.to_string()))
            .map(|(l, _)| l.clone())
            .collect();
        for l in &labels {
            inner.bindings.remove(l);
        }
        inner.validating.remove(account_id);
        let extra = inner.extra_views.remove(account_id).unwrap_or_default();
        (labels, extra)
    };
    for l in labels.iter().chain(extra.iter()) {
        profiles::destroy_window(app, l);
    }
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
fn commit_profile_marker(registry: &mut AccountRegistry, ctx: &AccountContext, profile_id: &str) {
    let marker = json!({
        "v": 1,
        "kind": "webview_profile",
        "profile_id": profile_id,
    })
    .to_string();
    let mut store = KeychainStore::new();
    let result = registry.begin_credential_commit(ctx).and_then(|op| {
        match registry.stage_credential(&op.operation_id, &mut store, &Secret::new(marker)) {
            Ok(_) => registry.commit_credential(&op.operation_id, &mut store),
            Err(e) => {
                let _ = registry.abort_credential(&op.operation_id, &mut store);
                Err(e)
            }
        }
    });
    if let Err(e) = result {
        log::warn!(
            "account {}: quick-login marker not committed ({}): restart will need a new login",
            ctx.account_id,
            e.code
        );
    }
}

// ---------------------------------------------------------------- init

/// Called once from `lib.rs` setup.
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let data_dir = app.path().app_data_dir()?;
    let path = data_dir.join(ACCOUNTS_FILE);
    app.manage(LoginState {
        inner: Mutex::new(Inner::default()),
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
    let doc = load_doc(&path);
    // Keychain reads may block (or prompt) — never on the main thread.
    let app = app.clone();
    std::thread::Builder::new()
        .name("vbk-account-restore".into())
        .spawn(move || {
            if let Some(doc) = doc {
                restore(&app, doc);
            }
            purge_orphan_profiles(&app);
        })
        .map_err(tauri::Error::Io)?;
    Ok(())
}

fn restore(app: &AppHandle, doc: PersistDoc) {
    let boot_epoch = app.state::<HostState>().lock().accounts.boot_epoch();
    let registry_doc = match contracts::json::JsonValue::parse(&doc.registry.to_string()) {
        Ok(v) => v,
        Err(e) => {
            log::error!("account index unreadable: {e:?}");
            return;
        }
    };
    let mut registry = match AccountRegistry::restore(&registry_doc, boot_epoch) {
        Ok(r) => r,
        Err(e) => {
            log::error!("account index not restored: {} {}", e.code, e.message);
            return;
        }
    };
    let report = registry.recover_credentials(&mut KeychainStore::new());
    if !report.missing_secret.is_empty() {
        log::warn!(
            "{} account(s) lost their quick-login marker and need a new login",
            report.missing_secret.len()
        );
    }
    if !report.unavailable_secret.is_empty() {
        log::warn!("{} account marker probe(s) unavailable; preserving profiles and deferring restoration", report.unavailable_secret.len());
    }
    let resumable: Vec<(String, String)> = {
        let host = app.state::<HostState>();
        let mut cores = host.lock();
        if !cores.accounts.account_ids().is_empty() {
            log::warn!("account index restore skipped: accounts already present");
            return;
        }
        let resumable = registry
            .account_ids()
            .into_iter()
            .filter(|id| {
                matches!(
                    registry.state(id).map(|s| s.kind()),
                    Some(AccountStateKind::Suspended)
                )
            })
            .filter(|id| !report.unavailable_secret.contains(id))
            .filter_map(|id| {
                let meta = doc.accounts.get(id.as_str())?;
                if meta.suspended_by_user {
                    return None;
                }
                Some((id.as_str().to_string(), meta.profile_id.clone()?))
            })
            .collect();
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
        if let Err(e) = open_account_webview(app, profile) {
            log::error!("account {id}: webview not restored: {e}");
            login_state(app).lock().validating.remove(id);
        }
    }
    persist_and_emit(app);
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
        if name.starts_with("p_") && !known.contains(&name) {
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

/// Starts (or re-surfaces) the login attempt and opens the login window.
/// Must not run on the main thread.
fn start_login(app: &AppHandle) -> Result<String, AppError> {
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
            candidate: false,
        },
    );
    if let Err(e) = open_login_window(app, &attempt_id, &profile_id) {
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
        inner.active = Some(id.clone());
        let profile = inner.meta.get(&id).and_then(|m| m.profile_id.clone());
        let validating = inner.validating.contains(&id);
        match (kind, profile) {
            (Some(AccountStateKind::Suspended), Some(p)) if !validating => {
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

/// Shared part of the three exit modes.
fn exit_account(app: &AppHandle, ctx: &AccountContext, mode: LogoutMode) -> Result<(), AppError> {
    let id = ctx.account_id.as_str().to_string();
    let host = app.state::<HostState>();
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
        _ => Some(host.logout(&id, mode)?),
    };
    teardown_account_views(app, &id);
    crate::adapter::on_account_removed(app, ctx);
    let profile = {
        let ls = login_state(app);
        let mut inner = ls.lock();
        inner.unread.remove(&id);
        let profile = inner.meta.get(&id).and_then(|m| m.profile_id.clone());
        match mode {
            LogoutMode::ExitOnline => {
                if let Some(m) = inner.meta.get_mut(&id) {
                    m.suspended_by_user = true;
                }
            }
            LogoutMode::Logout => {
                if let Some(m) = inner.meta.get_mut(&id) {
                    m.profile_id = None;
                    m.suspended_by_user = false;
                }
            }
            LogoutMode::Forget => {
                inner.meta.remove(&id);
                if inner.active.as_deref() == Some(id.as_str()) {
                    inner.active = None;
                }
            }
        }
        profile
    };
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
    Ok(())
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
) -> CmdResult<serde_json::Value> {
    let app = window.app_handle().clone();
    guard_app(&app, &window, "shell_open_webview")?;
    let ctx = check_account(&app, &account)?;
    app.state::<HostState>().lock().accounts.validate(&ctx)?;
    let parsed = Url::parse(&url)
        .ok()
        .filter(profiles::is_openable_official_url)
        .ok_or_else(|| {
            app_err(
                codes::HOST_URL_REJECTED,
                "only official vbooking / imvendor https URLs",
            )
        })?;
    let id = ctx.account_id.as_str().to_string();
    let (label, profile) = {
        let ls = login_state(&app);
        let mut inner = ls.lock();
        let profile = inner
            .meta
            .get(&id)
            .and_then(|m| m.profile_id.clone())
            .ok_or_else(|| {
                app_err(
                    core_account::codes::ACCOUNT_INVALID_STATE,
                    "no profile bound",
                )
            })?;
        inner.view_seq += 1;
        let label = profiles::view_label(inner.view_seq);
        inner
            .extra_views
            .entry(id.clone())
            .or_default()
            .push(label.clone());
        (label, profile)
    };
    let result = profiles::open_profile_window(
        &app,
        ProfileWindow {
            label: &label,
            profile_id: &profile,
            url: parsed,
            title: "VBooking",
            visible: true,
            init_script: None,
        },
        |_| {},
    );
    if let Err(e) = result {
        if let Some(v) = login_state(&app).lock().extra_views.get_mut(&id) {
            v.retain(|l| l != &label);
        }
        return Err(app_err(codes::HOST_UNSUPPORTED, format!("webview: {e}")).into());
    }
    Ok(serde_json::Value::Null)
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
        self.self_profile = identity.self_profile.as_ref().filter(|p| {
            !identity.uid.trim().is_empty() && p.uid.trim().eq_ignore_ascii_case(identity.uid.trim())
        }).cloned();
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
    let binding = login_state(app).lock().bindings.get(label).cloned()?;
    let Binding::Account(id) = binding else {
        return None;
    };
    let host = app.state::<HostState>();
    let cores = host.lock();
    let id = AccountId::new(id);
    match cores.accounts.state(&id)?.kind() {
        AccountStateKind::Online => cores.accounts.current_context(&id),
        _ => None,
    }
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
    let wanted = Binding::Account(account.account_id.as_str().to_string());
    inner
        .bindings
        .iter()
        .find(|(_, b)| **b == wanted)
        .map(|(l, _)| l.clone())
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
            let outcome = {
                let mut cores = host.lock();
                let outcome = cores
                    .accounts
                    .publish_identity(&AttemptId::new(attempt_id.clone()), upstream)?;
                if outcome.revoke.is_some() {
                    let _ = cores.im.invalidate_generation(outcome.ctx.clone());
                }
                commit_profile_marker(&mut cores.accounts, &outcome.ctx, &profile_id);
                outcome
            };
            let id = outcome.ctx.account_id.as_str().to_string();
            let old_profile = {
                let ls = login_state(app);
                let mut inner = ls.lock();
                inner.attempts.remove(&attempt_id);
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
                meta.profile_id.replace(profile_id.clone())
            };
            if let Some(revoke) = &outcome.revoke {
                // Same upstream identity logged in again: the previous
                // generation's page and profile go away.
                let old_ctx = AccountContext::new(
                    revoke.account_id.clone(),
                    revoke.environment.clone(),
                    revoke.revoked_generation,
                );
                let stale_profile = revoke
                    .profile
                    .as_ref()
                    .map(|p| p.as_str().to_string())
                    .or(old_profile)
                    .filter(|p| p != &profile_id);
                if let Some(p) = stale_profile {
                    let old_label = profiles::account_label(&p);
                    login_state(app).lock().bindings.remove(&old_label);
                    profiles::destroy_window(app, &old_label);
                    profiles::remove_profile_data(app, &p);
                }
                crate::adapter::on_account_removed(app, &old_ctx);
            }
            destroy_login_window(app);
            crate::windows::show_main(app);
            log::info!(
                "account {id}: identity published (new: {})",
                outcome.is_new_account
            );
            persist_and_emit(app);
            Ok(outcome.ctx)
        }
        Binding::Account(id) => {
            let account_id = AccountId::new(id.clone());
            let ctx =
                {
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
                            let old = cores.accounts.current_context(&account_id);
                            let ctx = cores.accounts.resume_quick_login(&account_id)?;
                            let _ = cores.im.invalidate_generation(ctx.clone());
                            drop(cores);
                            if let Some(old) = old {
                                crate::adapter::on_account_removed(app, &old);
                            }
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
            {
                let ls = login_state(app);
                let mut inner = ls.lock();
                inner.validating.remove(&id);
                if let Some(m) = inner.meta.get_mut(&id) {
                    m.update_identity(&identity);
                }
            }
            persist_and_emit(app);
            Ok(ctx)
        }
    }
}

/// Called when the page reports `auth_invalid` or lands on the login page.
pub fn on_auth_invalid(app: &AppHandle, account: &contracts::AccountContext) {
    let host = app.state::<HostState>();
    let invalidated = {
        let mut cores = host.lock();
        let current = cores.accounts.current_context(&account.account_id);
        let kind = cores.accounts.state(&account.account_id).map(|s| s.kind());
        match (current, kind) {
            (Some(cur), Some(AccountStateKind::Online | AccountStateKind::Suspended))
                if cur.session_generation == account.session_generation =>
            {
                match cores
                    .accounts
                    .invalidate(&account.account_id, "web session reported auth invalid")
                {
                    Ok(_) => {
                        if let Some(new_ctx) = cores.accounts.current_context(&account.account_id) {
                            let _ = cores.im.invalidate_generation(new_ctx);
                        }
                        true
                    }
                    Err(e) => {
                        log::warn!(
                            "account {}: not invalidated: {}",
                            account.account_id,
                            e.code
                        );
                        false
                    }
                }
            }
            // Already invalidated by the fact pipeline: only the host-side
            // teardown below is still due. Anything else is a stale callback.
            (_, Some(AccountStateKind::Invalid)) => true,
            _ => {
                log::info!("account {}: stale auth_invalid ignored", account.account_id);
                false
            }
        }
    };
    if !invalidated {
        return;
    }
    teardown_account_views(app, account.account_id.as_str());
    crate::adapter::on_account_removed(app, account);
    events::toast(app, "账号登录已失效，请重新登录");
    persist_and_emit(app);
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
        assert!(serde_json::from_str::<AccountMeta>(&serialized).unwrap().self_profile.is_none());
        let mut other = AccountMeta::default();
        dto.uid = "other-person".into();
        other.update_identity(&dto);
        assert!(other.self_profile.is_none());
        assert!(meta.self_profile.is_some(), "accounts do not share mutable profiles");
        meta.update_identity(&dto);
        assert!(meta.self_profile.is_none(), "changed IM identity must clear the previous image");
        dto.self_profile = None;
        meta.update_identity(&dto);
        assert!(meta.self_profile.is_none(), "legacy identity input has no person picture");
    }

}

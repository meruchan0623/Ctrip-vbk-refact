//! TSim merchant assistant: HTTP execution of core-assistant requests, TSim login state in keychain, outbound translation, package quick view.
//!
//! Owner: host-assistant. `core-assistant` builds requests and parses
//! responses; [`service`] runs them through an [`http::Executor`]
//! (reqwest in production) and keeps the TSim session, persisted only in
//! the system credential store (service `tech.tsim.vbk.client.tsim`).
//! TSim identity is independent of the Ctrip accounts; passwords are never
//! stored or logged, tokens never logged.

#[path = "assistant/http.rs"]
pub mod http;
#[path = "assistant/service.rs"]
pub mod service;

use std::sync::Arc;
use std::time::Duration;

use contracts::{codes as shared_codes, AccountContext, AppError};
use core_assistant::session::codes;
use serde::Serialize;
use tauri::{AppHandle, Manager, State, Window};

use crate::dto::{AccountContextDto, AppErrorDto};
use crate::state::HostState;

use http::ReqwestExecutor;
use service::{PackageInfo, Service, TsimStatus, Vault};

type CmdResult<T> = Result<T, AppErrorDto>;

/// Keychain / Credential Manager service name for the TSim session.
pub const KEYRING_SERVICE: &str = "tech.tsim.vbk.client.tsim";
const KEYRING_ACCOUNT: &str = "session";
/// Background upkeep period (refresh when due, load profile once).
const UPKEEP_PERIOD: Duration = Duration::from_secs(60);

fn guard(state: &HostState, window: &Window, command: &str) -> CmdResult<()> {
    state
        .authorize(window.label(), command)
        .map_err(AppErrorDto::from)
}

/// System credential store. The stored value is the serialized session
/// (user name, access token, session_ref, expiry); never a password.
pub struct KeyringVault;

fn keyring_error(_e: keyring::Error) -> AppError {
    // The keyring error text may include platform details; keep only a code.
    AppError::new(
        shared_codes::STORE_IO,
        "system credential store unavailable",
    )
}

impl KeyringVault {
    fn entry() -> Result<keyring::Entry, AppError> {
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(keyring_error)
    }
}

impl Vault for KeyringVault {
    fn load(&self) -> Result<Option<String>, AppError> {
        match Self::entry()?.get_password() {
            Ok(s) => Ok(Some(s)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(keyring_error(e)),
        }
    }

    fn save(&self, value: &str) -> Result<(), AppError> {
        Self::entry()?.set_password(value).map_err(keyring_error)
    }

    fn clear(&self) -> Result<(), AppError> {
        match Self::entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(keyring_error(e)),
        }
    }
}

type HostService = Service<ReqwestExecutor, KeyringVault>;

/// Managed module state.
pub struct AssistantState(Arc<HostService>);

fn wall_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Called once from `lib.rs` setup: restores the TSim session from the
/// credential store and starts the refresh upkeep.
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let svc = Arc::new(Service::new(
        ReqwestExecutor::new(),
        KeyringVault,
        Box::new(wall_ms),
    ));
    svc.restore();
    app.manage(AssistantState(Arc::clone(&svc)));
    tauri::async_runtime::spawn(async move {
        loop {
            svc.maintain().await;
            tokio::time::sleep(UPKEEP_PERIOD).await;
        }
    });
    Ok(())
}

fn service(app: &AppHandle) -> Option<Arc<HostService>> {
    app.try_state::<AssistantState>().map(|s| Arc::clone(&s.0))
}

fn require(app: &AppHandle) -> CmdResult<Arc<HostService>> {
    service(app).ok_or_else(|| {
        AppError::new(shared_codes::ADAPTER_NOT_READY, "assistant not initialized").into()
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn assistant_tsim_status(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
) -> CmdResult<TsimStatus> {
    guard(&state, &window, "assistant_tsim_status")?;
    Ok(require(&app)?.status())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn assistant_tsim_login(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
    user: String,
    password: String,
) -> CmdResult<TsimStatus> {
    guard(&state, &window, "assistant_tsim_login")?;
    let svc = require(&app)?;
    let st = svc.login(&user, password).await.map_err(|e| {
        log::info!("assistant: tsim login failed: {}", e.code);
        AppErrorDto::from(e)
    })?;
    Ok(st)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn assistant_tsim_logout(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
) -> CmdResult<TsimStatus> {
    guard(&state, &window, "assistant_tsim_logout")?;
    Ok(require(&app)?.logout().await)
}

#[derive(Debug, Clone, Serialize)]
pub struct TranslateResult {
    pub draft_version: u64,
    pub text: String,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn assistant_translate(
    window: Window,
    state: State<'_, HostState>,
    account: AccountContextDto,
    gid: String,
    draft_version: u64,
    text: String,
    target: String,
) -> CmdResult<TranslateResult> {
    guard(&state, &window, "assistant_translate")?;
    if gid.is_empty() {
        return Err(AppError::new(codes::INVALID_INPUT, "gid is required").into());
    }
    let svc = require(window.app_handle())?;
    let ctx: AccountContext = account.into();
    let host: &HostState = &state;
    let validate = |c: &AccountContext| host.lock().accounts.validate(c);
    let translated = svc
        .translate(&ctx, draft_version, &text, &target, &validate)
        .await
        .map_err(AppErrorDto::from)?;
    Ok(TranslateResult {
        draft_version,
        text: translated,
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn assistant_package_quick_view(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
    iccid: String,
) -> CmdResult<PackageInfo> {
    guard(&state, &window, "assistant_package_quick_view")?;
    let svc = require(&app)?;
    svc.package_quick_view(&iccid)
        .await
        .map_err(AppErrorDto::from)
}

// ---------------------------------------------------------------------------
// Cross-module interface (signatures owned by host-assistant).

/// TSim login state for `PrefsSnapshot.assistant.{tsim_logged_in, tsim_user}`.
/// `prefs_snapshot` (host-shell) should read it instead of keeping a copy.
pub fn tsim_status(app: &AppHandle) -> (bool, Option<String>) {
    match service(app) {
        Some(svc) => {
            let st = svc.status();
            (st.logged_in, st.user)
        }
        None => (false, None),
    }
}

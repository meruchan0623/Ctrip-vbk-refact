//! Host commands of the I-30 feature items (plan I-30 access rule 3).
//!
//! Each sub-item owns one file here and never touches `adapter.rs`; the
//! commands forward ONE fixed op to the account's official page through
//! `adapter::request` and judge nothing the std-only `core_im::feature_rules`
//! can judge. Registration (`pub mod features;` in `lib.rs`, the
//! `generate_handler!` lines, `commands.txt`, `views.rs` role lists and
//! `capabilities/main.json`) is an integration change request; the exact
//! list is in the module G work report.
//!
//! NOTE: this package is not compiled in the cloud check environment (no
//! Tauri toolchain / registry). Every function below was written against the
//! signatures of `adapter.rs`, `state.rs` and `dto.rs` and must be compiled
//! on the target machine before merging.

pub mod draft;
pub mod queue;
pub mod recall;
pub mod typing;

use contracts::AccountContext;
use tauri::Webview;

use crate::dto::{AccountContextDto, AppErrorDto};
use crate::state::HostState;

pub(crate) type CmdResult<T> = Result<T, AppErrorDto>;

/// Runtime ACL check for the calling webview + the account must be the
/// current, online authorization. Returns the validated context.
pub(crate) fn authorize(
    state: &HostState,
    webview: &Webview,
    command: &str,
    account: AccountContextDto,
) -> CmdResult<AccountContext> {
    state
        .authorize(webview.label(), command)
        .map_err(AppErrorDto::from)?;
    let ctx: AccountContext = account.into();
    state
        .lock()
        .accounts
        .validate(&ctx)
        .map_err(AppErrorDto::from)?;
    Ok(ctx)
}

/// Anchored server time in ms, or `None` while the clock is not trusted.
pub(crate) fn trusted_server_ms(state: &HostState) -> Option<i64> {
    let mut cores = state.lock();
    let reading = state.reading(&mut cores);
    if reading.quality.is_trusted() {
        Some(reading.server_now_ms)
    } else {
        None
    }
}

/// Stable per-account key for throttles: `environment|account|generation`.
pub(crate) fn account_key(ctx: &AccountContext) -> String {
    format!(
        "{}|{}|{}",
        ctx.environment.0, ctx.account_id.0, ctx.session_generation
    )
}

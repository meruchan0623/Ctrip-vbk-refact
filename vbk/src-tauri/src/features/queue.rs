//! I-30d queue state: `im_queue_status` (one-shot read) and `im_queue_drop_out`.
//!
//! * `im_queue_status` forwards `queue.status`
//!   (`checkManualAgentStatus` = `POST 16037/checkSessionStatus`). Cadence,
//!   backoff and stop conditions live in the UI feature; the host never loops.
//! * `im_queue_drop_out` forwards `queue.drop_out`; the `dropOutManual`
//!   endpoint was never captured, so the page answers `unsupported` and sends
//!   nothing. The command exists so the UI contract is complete the day the
//!   endpoint is captured; until then it is a verified no-op.
//!
//! Plan deviation to record: the plan lists one new command for I-30d
//! (`im_queue_drop_out`); a read command is unavoidable for the status poll.

use core_im::feature_rules::validate_gid;
use serde_json::{json, Value};
use tauri::{AppHandle, State, Webview};

use super::{authorize, CmdResult};
use crate::adapter;
use crate::dto::{AccountContextDto, AppErrorDto};
use crate::state::HostState;

#[tauri::command(rename_all = "snake_case")]
pub async fn im_queue_status(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
    gid: String,
) -> CmdResult<Value> {
    let ctx = authorize(&state, &webview, "im_queue_status", account)?;
    validate_gid(&gid).map_err(AppErrorDto::from)?;
    adapter::request(
        &app,
        &ctx,
        "queue.status",
        json!({ "gid": gid }),
        adapter::READ_TIMEOUT,
    )
    .await
    .map_err(AppErrorDto::from)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn im_queue_drop_out(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
    gid: String,
) -> CmdResult<Value> {
    let ctx = authorize(&state, &webview, "im_queue_drop_out", account)?;
    validate_gid(&gid).map_err(AppErrorDto::from)?;
    adapter::request(
        &app,
        &ctx,
        "queue.drop_out",
        json!({ "gid": gid }),
        adapter::WRITE_TIMEOUT,
    )
    .await
    .map_err(AppErrorDto::from)
}

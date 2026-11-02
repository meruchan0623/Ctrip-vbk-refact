//! I-30b active recall: `im_recall_message`.
//!
//! The UI already hides the action outside the window; the host re-judges
//! with the ANCHORED server clock (`core_im::feature_rules::recall_gate`; an
//! unanchored clock is a refusal) and with the 19-digit id form before it
//! forwards `recall.message` to the account's official page, which sends
//! `POST 11679/recallMessage {messageId, partnerId}` exactly once. A reply
//! that never arrives is an error here and is NEVER retried: recall is a
//! write whose outcome may be unknown (the UI shows that state).
//!
//! `partnerId` is the conversation gid (checked 19-digit); the page derives
//! it from the gid, so the UI cannot supply a different partner.

use contracts::AppError;
use core_im::feature_rules::{recall_gate, validate_recall_ids};
use serde_json::{json, Value};
use tauri::{AppHandle, State, Webview};

use super::{authorize, trusted_server_ms, CmdResult};
use crate::adapter;
use crate::dto::{AccountContextDto, AppErrorDto};
use crate::state::HostState;

/// Pure argument gate shared by the command and its tests.
pub(crate) fn gate(
    gid: &str,
    message_id: &str,
    created_ms: i64,
    server_now_ms: Option<i64>,
) -> Result<(), AppError> {
    // partnerId == gid on the wire, so the gid obeys the same 19-digit form
    validate_recall_ids(message_id, gid)?;
    if created_ms <= 0 {
        return Err(AppError::new(
            core_im::feature_rules::codes::IM_FEATURE_INVALID_ARGUMENT,
            "created_ms must be positive",
        ));
    }
    recall_gate(created_ms, server_now_ms)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn im_recall_message(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
    gid: String,
    message_id: String,
    created_ms: i64,
) -> CmdResult<Value> {
    let ctx = authorize(&state, &webview, "im_recall_message", account)?;
    let server_now_ms = trusted_server_ms(&state);
    gate(&gid, &message_id, created_ms, server_now_ms).map_err(AppErrorDto::from)?;
    // `gate` only passes with an anchored clock, so the anchor is always Some
    // here. The page has no server-time anchor of its own; it re-judges the
    // window with this host-supplied value (the UI never reaches this field:
    // the command builds the op arguments itself).
    let server_now_ms = server_now_ms.ok_or_else(|| {
        AppErrorDto::from(AppError::new(
            core_im::feature_rules::codes::IM_RECALL_CLOCK_UNKNOWN,
            "server time is not anchored; the recall window cannot be judged",
        ))
    })?;
    // single attempt, write timeout; the caller maps a timeout to "outcome unknown"
    adapter::request(
        &app,
        &ctx,
        "recall.message",
        json!({
            "gid": gid,
            "message_id": message_id,
            "created_ms": created_ms,
            "server_now_ms": server_now_ms,
        }),
        adapter::WRITE_TIMEOUT,
    )
    .await
    .map_err(AppErrorDto::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use core_im::feature_rules::codes;

    const ID: &str = "1234567890123456789";

    #[test]
    fn gate_accepts_a_fresh_message_on_an_anchored_clock() {
        assert!(gate(ID, ID, 1_000_000, Some(1_010_000)).is_ok());
    }

    #[test]
    fn gate_refuses_old_unanchored_and_malformed_requests() {
        assert!(gate(ID, ID, 1_000_000, Some(1_130_000))
            .expect_err("expired")
            .is(codes::IM_RECALL_EXPIRED));
        assert!(gate(ID, ID, 1_000_000, None)
            .expect_err("unanchored")
            .is(codes::IM_RECALL_CLOCK_UNKNOWN));
        assert!(gate("12", ID, 1_000_000, Some(1_000_001))
            .expect_err("gid")
            .is(codes::IM_RECALL_INVALID_ID));
        assert!(gate(ID, "local-1", 1_000_000, Some(1_000_001))
            .expect_err("local id")
            .is(codes::IM_RECALL_INVALID_ID));
        assert!(gate(ID, ID, 0, Some(1_000_001))
            .expect_err("created")
            .is(codes::IM_FEATURE_INVALID_ARGUMENT));
    }
}

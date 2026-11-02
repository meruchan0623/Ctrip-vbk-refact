//! I-30a typing state: `im_send_input_state`.
//!
//! XMPP `<message type="input_state">` is emitted by the account's official
//! page (SDK); the host only throttles (3 s per account+conversation, the
//! same rule as `core_im::feature_rules::InputStateThrottle`) and forwards
//! the `typing.send` op. The page answers `{sent, reason?}`; a slot that did
//! not result in a sent frame is released so a retry is not blocked.

use std::sync::{Mutex, OnceLock};

use core_im::feature_rules::{validate_gid, InputStateThrottle};
use serde_json::{json, Value};
use tauri::{AppHandle, State, Webview};

use super::{account_key, authorize, CmdResult};
use crate::adapter;
use crate::dto::{AccountContextDto, AppErrorDto};
use crate::state::HostState;

fn throttle() -> &'static Mutex<InputStateThrottle> {
    static THROTTLE: OnceLock<Mutex<InputStateThrottle>> = OnceLock::new();
    THROTTLE.get_or_init(|| Mutex::new(InputStateThrottle::new()))
}

fn lock_throttle() -> std::sync::MutexGuard<'static, InputStateThrottle> {
    match throttle().lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// True when the page reply says a frame really went out.
fn reply_sent(reply: &Value) -> bool {
    reply.get("sent").and_then(Value::as_bool) == Some(true)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn im_send_input_state(
    app: AppHandle,
    webview: Webview,
    state: State<'_, HostState>,
    account: AccountContextDto,
    gid: String,
) -> CmdResult<Value> {
    let ctx = authorize(&state, &webview, "im_send_input_state", account)?;
    validate_gid(&gid).map_err(AppErrorDto::from)?;
    let key = format!("{}#{}", account_key(&ctx), gid);
    let now = state.clock.wall_ms();
    if !lock_throttle().admit(&key, now) {
        return Ok(json!({ "sent": false, "reason": "throttled" }));
    }
    let result = adapter::request(
        &app,
        &ctx,
        "typing.send",
        json!({ "gid": gid }),
        adapter::READ_TIMEOUT,
    )
    .await;
    match result {
        Ok(reply) => {
            if !reply_sent(&reply) {
                lock_throttle().forget(&key);
            }
            Ok(reply)
        }
        Err(e) => {
            lock_throttle().forget(&key);
            Err(AppErrorDto::from(e))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_explicit_true_counts_as_sent() {
        assert!(reply_sent(&json!({ "sent": true })));
        assert!(!reply_sent(
            &json!({ "sent": false, "reason": "unsupported" })
        ));
        assert!(!reply_sent(&json!({ "sent": "true" })));
        assert!(!reply_sent(&json!(null)));
    }
}

//! Event names emitted by the host and small directed-emit helpers.
//! FROZEN 2026-10-30 (integration owner). Mirrors `Events` / `UiEvents` in
//! `ui/packages/ipc/src/{commands,client}.ts`. Every emit is directed to a
//! local window label; remote webviews only ever receive `adapter://request`.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::views;

pub const ACCOUNT_CHANGED: &str = "account://changed"; // UiAccountSnapshot
pub const AGENT_STATUS: &str = "account://agent-status"; // UiAgentStatus
pub const ALARM_SNAPSHOT: &str = "notify://alarm-snapshot"; // AlarmSnapshotDto
pub const IM_CONVERSATION_CHANGED: &str = "im://conversation-changed"; // UiConversation
pub const IM_MESSAGE_NEW: &str = "im://message-new"; // UiMessage (+ account)
pub const IM_LOCATE_CONVERSATION: &str = "im://locate-conversation"; // {account, gid}
pub const NET_CLOCK: &str = "net://clock"; // ClockReading
pub const NET_STATUS: &str = "net://status"; // UiNetStatus
pub const PREFS_CHANGED: &str = "prefs://changed"; // PrefsSnapshot
pub const SHELL_TOAST: &str = "shell://toast"; // {text}
pub const NOTIFY_BANNER: &str = "notify://banner";
pub const NOTIFY_PLAY_SOUND: &str = "notify://play-sound";
pub const NOTIFY_STOP_SOUND: &str = "notify://stop-sound";
/// Host → one `acct-*` webview only.
pub const ADAPTER_REQUEST: &str = "adapter://request";

/// Emit to the main window (ignored if it does not exist).
pub fn to_main<S: Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    let _ = app.emit_to(views::MAIN, event, payload);
}

/// Emit to every local window that shows account-scoped UI (main, setting, login).
pub fn to_local_windows<S: Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    for label in [views::MAIN, views::SETTING, views::LOGIN] {
        let _ = app.emit_to(label, event, payload.clone());
    }
}

/// Toast shown by the main window.
pub fn toast(app: &AppHandle, text: impl Into<String>) {
    to_main(app, SHELL_TOAST, serde_json::json!({ "text": text.into() }));
}

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
pub const IM_CONVERSATIONS_INVALIDATED: &str = "im://conversations-invalidated"; // AccountContextDto; re-read current cache
pub const IM_MESSAGE_NEW: &str = "im://message-new"; // UiMessage (+ account)
pub const IM_MESSAGE_READ_STATUSES: &str = "im://message-read-statuses"; // {account, gid, items}
pub const IM_LOCATE_CONVERSATION: &str = "im://locate-conversation"; // {account, gid}
pub const NET_CLOCK: &str = "net://clock"; // ClockReading
pub const NET_STATUS: &str = "net://status"; // UiNetStatus
pub const MEDIA_SEND_PROGRESS: &str = "media://send-progress";
pub const PREFS_CHANGED: &str = "prefs://changed"; // PrefsSnapshot
pub const SHELL_TOAST: &str = "shell://toast"; // {text}
pub const NOTIFY_BANNER: &str = "notify://banner";
pub const NOTIFY_TAB_ATTENTION: &str = "notify://tab-attention"; // {account}; main only, no gid or text
pub const NOTIFY_PLAY_SOUND: &str = "notify://play-sound";
pub const NOTIFY_NOTICE: &str = "notify://notice"; // {account, gid, title, preview, count, stay_ms}
pub const NOTIFY_NOTICE_UPDATE: &str = "notify://notice-update"; // {account, gid, title, preview}
pub const NOTIFY_STOP_SOUND: &str = "notify://stop-sound";
pub const NOTICE_NEW: &str = "notice://new"; // {account, category_id}; main re-reads the overview
pub const NOTICE_LOCATE_CATEGORY: &str = "notice://locate-category"; // {account, category_id}
/// Validated page feature fact (typing / recalled / queue notice) → main
/// window; payload `FeatureFactEventDto`. Mirrors `FeatureEvents.FACT` in
/// `ui/apps/main/features/context.ts` (added 2026-11-02, main window only).
pub const FEATURE_FACT: &str = "feature://fact";
/// Host → one `acct-*` webview only.
pub const ADAPTER_REQUEST: &str = "adapter://request";

/// Emit to the main window (ignored if it does not exist).
pub fn to_main<S: Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    let _ = app.emit_to(views::MAIN, event, payload);
}

/// Emit to every local window that shows account-scoped UI (main, setting, login).
pub fn to_local_windows<S: Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    if event == ACCOUNT_CHANGED {
        crate::assistant::order_commands::on_account_snapshot(app);
        crate::media_viewer::on_account_snapshot(app);
    }
    for label in [views::MAIN, views::SETTING, views::LOGIN] {
        let _ = app.emit_to(label, event, payload.clone());
    }
}

/// Toast shown by the main window.
pub fn toast(app: &AppHandle, text: impl Into<String>) {
    to_main(app, SHELL_TOAST, serde_json::json!({ "text": text.into() }));
}

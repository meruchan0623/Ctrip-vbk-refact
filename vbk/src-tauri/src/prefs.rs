//! Full PrefsSnapshot persistence and prefs_set.
//!
//! Owner: host-shell.
//!
//! * The snapshot shape mirrors `PrefsSnapshot` in
//!   `ui/packages/ipc/src/client.ts`.
//! * `reminder` is owned by the notify core (`state.settings()`); this
//!   module only mirrors it into `prefs.json` so the threshold and switches
//!   survive a restart, and re-applies the stored copy at startup.
//! * Every other section is owned here and persisted to
//!   `app_data_dir/prefs.json` (atomic write: temp file + rename).
//! * Every change emits `prefs://changed` with the full snapshot to the
//!   local windows (never to a remote webview).
//!
//! Lock order: the cores mutex (`HostState::lock`) is never held while the
//! module mutex is taken, and vice versa.

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use contracts::{AppError, ReminderSettings};
use core_notify::Effect;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, State, Window};

use crate::dto::{AppErrorDto, ReminderSettingsDto};
use crate::events;
use crate::state::HostState;

type CmdResult<T> = Result<T, AppErrorDto>;

/// Module-private error codes (prefix `prefs.`).
pub mod codes {
    /// `enabled` / `t1_seconds` / `timeout_sound` have dedicated
    /// `notify_set_*` commands and are rejected by `prefs_set`.
    pub const USE_NOTIFY: &str = "prefs.use_notify";
    /// Unknown section or key.
    pub const UNKNOWN_KEY: &str = "prefs.unknown_key";
    /// Value has the wrong type or is outside the allowed set.
    pub const INVALID_VALUE: &str = "prefs.invalid_value";
    /// Field is a host read-back (e.g. TSim login state) and cannot be set.
    pub const READ_ONLY: &str = "prefs.read_only";
}

const FILE_NAME: &str = "prefs.json";

fn guard(state: &HostState, window: &Window, command: &str) -> CmdResult<()> {
    state
        .authorize(window.label(), command)
        .map_err(AppErrorDto::from)
}

// ------------------------------------------------------------------ model

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CloseAction {
    Tray,
    Quit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SendKey {
    Enter,
    CtrlEnter,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SendMode {
    ReplaceDraft,
    SendDirect,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct GeneralPrefs {
    pub autostart: bool,
    pub close_action: CloseAction,
    pub start_hidden: bool,
    pub show_msg_time: bool,
    pub spell_check: bool,
}

impl Default for GeneralPrefs {
    fn default() -> Self {
        Self {
            autostart: true,
            close_action: CloseAction::Tray,
            start_hidden: false,
            show_msg_time: true,
            spell_check: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct DisplayPrefs {
    /// One of 75 / 100 / 125 / 150.
    pub zoom: u32,
    pub gpu: bool,
}

impl Default for DisplayPrefs {
    fn default() -> Self {
        Self {
            zoom: 100,
            gpu: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct KeyPrefs {
    pub send_key: SendKey,
    pub screenshot: String,
    pub toggle_main: String,
}

impl Default for KeyPrefs {
    fn default() -> Self {
        Self {
            send_key: SendKey::Enter,
            screenshot: "Ctrl+Shift+X".into(),
            toggle_main: "Ctrl+Alt+V".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AssistantPrefs {
    pub enabled: bool,
    pub outbound_translation: bool,
    pub send_mode: SendMode,
    pub package_quick_view: bool,
    /// Read-back from the assistant module; never set through `prefs_set`.
    pub tsim_logged_in: bool,
    pub tsim_user: Option<String>,
}

impl Default for AssistantPrefs {
    fn default() -> Self {
        Self {
            enabled: true,
            outbound_translation: true,
            send_mode: SendMode::ReplaceDraft,
            package_quick_view: true,
            tsim_logged_in: false,
            tsim_user: None,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct DndPrefs {
    pub schedule_enabled: bool,
    pub follow_system: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct NetworkPrefs {
    pub system_proxy: bool,
}

impl Default for NetworkPrefs {
    fn default() -> Self {
        Self { system_proxy: true }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct StoragePrefs {
    /// One of 30 / 90 / 180 / 365.
    pub cache_days: u32,
    pub cache_mb: u32,
}

impl Default for StoragePrefs {
    fn default() -> Self {
        Self {
            cache_days: 90,
            cache_mb: 1024,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct PrivacyPrefs {
    pub analytics: bool,
    pub crash_upload: bool,
}

/// Host-owned sections (everything except `reminder`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct LocalPrefs {
    pub general: GeneralPrefs,
    pub display: DisplayPrefs,
    pub keys: KeyPrefs,
    pub assistant: AssistantPrefs,
    pub dnd: DndPrefs,
    pub network: NetworkPrefs,
    pub storage: StoragePrefs,
    pub privacy: PrivacyPrefs,
}

/// On-disk layout of `prefs.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct PrefsFile {
    /// Mirror of the notify core settings (restored at startup).
    reminder: Option<ReminderSettingsDto>,
    #[serde(flatten)]
    local: LocalPrefs,
}

/// Wire shape of `PrefsSnapshot`.
#[derive(Debug, Clone, Serialize)]
pub struct PrefsSnapshotDto {
    pub reminder: ReminderSettingsDto,
    #[serde(flatten)]
    pub local: LocalPrefs,
}

const REMINDER_LOCAL_KEYS: &[&str] = &[
    "continuous_l4",
    "position_bottom_right",
    "alert_during_dnd",
    "alert_during_fullscreen",
    "tray_flash",
    "taskbar_badge",
];
const REMINDER_NOTIFY_KEYS: &[&str] = &["enabled", "t1_seconds", "timeout_sound"];
const READ_ONLY_KEYS: &[(&str, &str)] =
    &[("assistant", "tsim_logged_in"), ("assistant", "tsim_user")];

fn invalid(key: &str, why: impl std::fmt::Display) -> AppError {
    AppError::new(
        codes::INVALID_VALUE,
        format!("invalid value for {key}: {why}"),
    )
}

/// Pure update of one host-owned field; validates type and allowed values.
pub fn apply_local(
    prefs: &LocalPrefs,
    section: &str,
    key: &str,
    value: Value,
) -> Result<LocalPrefs, AppError> {
    if READ_ONLY_KEYS.contains(&(section, key)) {
        return Err(AppError::new(
            codes::READ_ONLY,
            format!("{section}.{key} is read-only"),
        ));
    }
    let mut tree = serde_json::to_value(prefs).map_err(|e| invalid(key, e))?;
    let slot = tree
        .get_mut(section)
        .and_then(Value::as_object_mut)
        .and_then(|obj| obj.get_mut(key))
        .ok_or_else(|| {
            AppError::new(
                codes::UNKNOWN_KEY,
                format!("unknown preference {section}.{key}"),
            )
        })?;
    *slot = value;
    let next: LocalPrefs = serde_json::from_value(tree).map_err(|e| invalid(key, e))?;
    if ![75, 100, 125, 150].contains(&next.display.zoom) {
        return Err(invalid(key, "zoom must be 75/100/125/150"));
    }
    if ![30, 90, 180, 365].contains(&next.storage.cache_days) {
        return Err(invalid(key, "cache_days must be 30/90/180/365"));
    }
    if next.keys.screenshot.trim().is_empty() || next.keys.toggle_main.trim().is_empty() {
        return Err(invalid(key, "shortcut must not be empty"));
    }
    Ok(next)
}

/// Pure update of one locally-settable reminder field.
pub fn apply_reminder(
    current: &ReminderSettings,
    key: &str,
    value: &Value,
) -> Result<ReminderSettings, AppError> {
    if REMINDER_NOTIFY_KEYS.contains(&key) {
        return Err(AppError::new(
            codes::USE_NOTIFY,
            format!("reminder.{key} is set through notify_set_*"),
        ));
    }
    if !REMINDER_LOCAL_KEYS.contains(&key) {
        return Err(AppError::new(
            codes::UNKNOWN_KEY,
            format!("unknown preference reminder.{key}"),
        ));
    }
    let v = value
        .as_bool()
        .ok_or_else(|| invalid(key, "expected boolean"))?;
    let mut next = current.clone();
    match key {
        "continuous_l4" => next.continuous_l4 = v,
        "position_bottom_right" => next.position_bottom_right = v,
        "alert_during_dnd" => next.alert_during_dnd = v,
        "alert_during_fullscreen" => next.alert_during_fullscreen = v,
        "tray_flash" => next.tray_flash = v,
        "taskbar_badge" => next.taskbar_badge = v,
        _ => unreachable!("checked against REMINDER_LOCAL_KEYS"),
    }
    Ok(next)
}

// ------------------------------------------------------------------ module state

struct Inner {
    local: LocalPrefs,
    /// Last reminder settings written to disk / announced.
    reminder: Option<ReminderSettingsDto>,
}

struct PrefsModule {
    path: Option<PathBuf>,
    inner: Mutex<Inner>,
    /// Notify effects produced by settings changes made here; drained by
    /// the scheduler on its next tick.
    pending: Mutex<Vec<Effect>>,
}

impl PrefsModule {
    fn data(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn save(&self, inner: &Inner) {
        let Some(path) = &self.path else { return };
        let file = PrefsFile {
            reminder: inner.reminder.clone(),
            local: inner.local.clone(),
        };
        let result = (|| -> std::io::Result<()> {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let bytes = serde_json::to_vec_pretty(&file)?;
            let tmp = path.with_extension("json.tmp");
            std::fs::write(&tmp, bytes)?;
            std::fs::rename(&tmp, path)
        })();
        if let Err(e) = result {
            log::warn!("prefs: save failed: {e}");
        }
    }
}

fn load(path: &PathBuf) -> PrefsFile {
    match std::fs::read(path) {
        Ok(bytes) => match serde_json::from_slice::<PrefsFile>(&bytes) {
            Ok(f) => f,
            Err(e) => {
                log::warn!("prefs: {FILE_NAME} unreadable ({e}); using defaults");
                PrefsFile::default()
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => PrefsFile::default(),
        Err(e) => {
            log::warn!("prefs: cannot read {FILE_NAME}: {e}; using defaults");
            PrefsFile::default()
        }
    }
}

/// Replaces the notify core settings; returns the effects to execute.
fn set_core_settings(
    state: &HostState,
    settings: ReminderSettings,
) -> Result<Vec<Effect>, AppError> {
    let mut cores = state.lock();
    let now = state.now(&mut cores);
    cores.notify.set_settings(settings, &now)
}

/// Called once from `lib.rs` setup. Register module state with `app.manage(..)` here.
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let path = app.path().app_data_dir().ok().map(|d| d.join(FILE_NAME));
    let file = path.as_ref().map(load).unwrap_or_default();
    let mut pending = Vec::new();
    let state = app.state::<HostState>();
    if let Some(saved) = file.reminder.clone() {
        let saved: ReminderSettings = saved.into();
        if saved != state.settings() {
            match set_core_settings(&state, saved) {
                Ok(effects) => pending.extend(effects),
                Err(e) => log::warn!("prefs: stored reminder settings rejected: {e}"),
            }
        }
    }
    let reminder = Some(ReminderSettingsDto::from(&state.settings()));
    app.manage(PrefsModule {
        path,
        inner: Mutex::new(Inner {
            local: file.local,
            reminder,
        }),
        pending: Mutex::new(pending),
    });
    Ok(())
}

fn module(app: &AppHandle) -> Option<State<'_, PrefsModule>> {
    app.try_state::<PrefsModule>()
}

/// Full snapshot (reminder from the notify core).
pub fn snapshot(app: &AppHandle) -> PrefsSnapshotDto {
    let reminder = ReminderSettingsDto::from(&app.state::<HostState>().settings());
    let mut local = module(app)
        .map(|m| m.data().local.clone())
        .unwrap_or_default();
    // Read-through: the assistant module is the source of truth for TSim state.
    let (logged_in, user) = crate::assistant::tsim_status(app);
    local.assistant.tsim_logged_in = logged_in;
    local.assistant.tsim_user = user;
    PrefsSnapshotDto { reminder, local }
}

fn announce(app: &AppHandle) -> PrefsSnapshotDto {
    let snap = snapshot(app);
    events::to_local_windows(app, events::PREFS_CHANGED, snap.clone());
    snap
}

/// Scheduler hook: notices reminder changes made through `notify_set_*`
/// (commands.rs), persists them and emits `prefs://changed`.
pub fn sync_reminder(app: &AppHandle) {
    let Some(m) = module(app) else { return };
    let current = ReminderSettingsDto::from(&app.state::<HostState>().settings());
    let changed = {
        let mut inner = m.data();
        if inner.reminder.as_ref() == Some(&current) {
            false
        } else {
            inner.reminder = Some(current);
            m.save(&inner);
            true
        }
    };
    if changed {
        announce(app);
    }
    // TSim login state is owned by the assistant module (login, logout and
    // background session clears); mirror it here so `prefs://changed` fires
    // within one scheduler tick. `set_tsim_status` only announces on change.
    let (logged_in, user) = crate::assistant::tsim_status(app);
    set_tsim_status(app, logged_in, user);
}

/// Scheduler hook: notify effects produced by settings changes made here.
pub fn take_pending_effects(app: &AppHandle) -> Vec<Effect> {
    match module(app) {
        Some(m) => std::mem::take(&mut *m.pending.lock().unwrap_or_else(|p| p.into_inner())),
        None => Vec::new(),
    }
}

/// `general.close_action == quit`.
pub fn close_quits(app: &AppHandle) -> bool {
    module(app)
        .map(|m| m.data().local.general.close_action == CloseAction::Quit)
        .unwrap_or(false)
}

/// Read-back hook for the assistant module (TSim login state).
pub fn set_tsim_status(app: &AppHandle, logged_in: bool, user: Option<String>) {
    let Some(m) = module(app) else { return };
    let changed = {
        let mut inner = m.data();
        let a = &mut inner.local.assistant;
        if a.tsim_logged_in == logged_in && a.tsim_user == user {
            false
        } else {
            a.tsim_logged_in = logged_in;
            a.tsim_user = user;
            m.save(&inner);
            true
        }
    };
    if changed {
        announce(app);
    }
}

// ------------------------------------------------------------------ commands

#[tauri::command]
pub fn prefs_snapshot(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
) -> CmdResult<PrefsSnapshotDto> {
    guard(&state, &window, "prefs_snapshot")?;
    Ok(snapshot(&app))
}

#[tauri::command]
pub fn prefs_set(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
    section: String,
    key: String,
    value: Value,
) -> CmdResult<PrefsSnapshotDto> {
    guard(&state, &window, "prefs_set")?;
    let m = module(&app).ok_or_else(|| {
        AppError::new(contracts::codes::HOST_UNSUPPORTED, "prefs not initialised")
    })?;
    if section == "reminder" {
        let next = apply_reminder(&state.settings(), &key, &value)?;
        let effects = set_core_settings(&state, next)?;
        m.pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .extend(effects);
        sync_reminder(&app);
        return Ok(snapshot(&app));
    }
    {
        let mut inner = m.data();
        let next = apply_local(&inner.local, &section, &key, value)?;
        if next == inner.local {
            drop(inner);
            return Ok(snapshot(&app));
        }
        inner.local = next;
        m.save(&inner);
    }
    Ok(announce(&app))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn snapshot_shape_matches_client_ts() {
        let snap = PrefsSnapshotDto {
            reminder: ReminderSettingsDto::from(&ReminderSettings::default()),
            local: LocalPrefs::default(),
        };
        let v = serde_json::to_value(&snap).unwrap();
        for section in [
            "reminder",
            "general",
            "display",
            "keys",
            "assistant",
            "dnd",
            "network",
            "storage",
            "privacy",
        ] {
            assert!(v.get(section).is_some(), "missing {section}");
        }
        assert_eq!(v["general"]["close_action"], "tray");
        assert_eq!(v["keys"]["send_key"], "enter");
        assert_eq!(v["assistant"]["send_mode"], "replace_draft");
        assert_eq!(v["assistant"]["tsim_user"], Value::Null);
        assert_eq!(v["display"]["zoom"], 100);
    }

    #[test]
    fn local_set_validates() {
        let p = LocalPrefs::default();
        let n = apply_local(&p, "keys", "send_key", json!("ctrl_enter")).unwrap();
        assert_eq!(n.keys.send_key, SendKey::CtrlEnter);
        let n = apply_local(&p, "general", "close_action", json!("quit")).unwrap();
        assert_eq!(n.general.close_action, CloseAction::Quit);
        assert_eq!(
            apply_local(&p, "display", "zoom", json!(110))
                .unwrap_err()
                .code,
            codes::INVALID_VALUE
        );
        assert_eq!(
            apply_local(&p, "display", "gpu", json!("yes"))
                .unwrap_err()
                .code,
            codes::INVALID_VALUE
        );
        assert_eq!(
            apply_local(&p, "display", "nope", json!(true))
                .unwrap_err()
                .code,
            codes::UNKNOWN_KEY
        );
        assert_eq!(
            apply_local(&p, "nope", "gpu", json!(true))
                .unwrap_err()
                .code,
            codes::UNKNOWN_KEY
        );
        assert_eq!(
            apply_local(&p, "assistant", "tsim_logged_in", json!(true))
                .unwrap_err()
                .code,
            codes::READ_ONLY
        );
    }

    #[test]
    fn reminder_set_rules() {
        let s = ReminderSettings::default();
        for key in ["enabled", "t1_seconds", "timeout_sound"] {
            assert_eq!(
                apply_reminder(&s, key, &json!(true)).unwrap_err().code,
                codes::USE_NOTIFY
            );
        }
        let n = apply_reminder(&s, "continuous_l4", &json!(true)).unwrap();
        assert!(n.continuous_l4);
        assert_eq!(
            apply_reminder(&s, "tray_flash", &json!(1))
                .unwrap_err()
                .code,
            codes::INVALID_VALUE
        );
    }

    #[test]
    fn file_roundtrip_tolerates_missing_fields() {
        let f: PrefsFile =
            serde_json::from_value(json!({ "general": { "start_hidden": true } })).unwrap();
        assert!(f.local.general.start_hidden);
        assert!(f.local.general.show_msg_time);
        assert!(f.reminder.is_none());
    }
}

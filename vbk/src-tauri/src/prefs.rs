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

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use contracts::{AccountContext, AppError, ReminderSettings};
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
            autostart: false,
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
#[serde(default)]
pub struct KeyPrefs {
    pub send_key: SendKey,
    pub toggle_main: String,
}

impl Default for KeyPrefs {
    fn default() -> Self {
        Self {
            send_key: SendKey::Enter,
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

/// Notice categories that use a banner, per `environment:account_id`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct NoticeBannerPrefs {
    pub accounts: BTreeMap<String, Vec<String>>,
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
    pub notice_banner: NoticeBannerPrefs,
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

/// `categoryId:categorySubId` as the adapter's `parseNoticeCategoryId` accepts it.
pub fn is_notice_category_id(id: &str) -> bool {
    let number =
        |part: &str| (1..=9).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_digit());
    id.split_once(':')
        .is_some_and(|(parent, sub)| number(parent) && number(sub))
}

fn validate_notice_banner(prefs: &NoticeBannerPrefs) -> Result<(), &'static str> {
    const MAX_ACCOUNTS: usize = 64;
    const MAX_CATEGORIES: usize = 64;
    if prefs.accounts.len() > MAX_ACCOUNTS {
        return Err("too many accounts");
    }
    for (account, categories) in &prefs.accounts {
        if account.is_empty() || account.len() > 256 || categories.len() > MAX_CATEGORIES {
            return Err("bad account entry");
        }
        if !categories.iter().all(|id| is_notice_category_id(id)) {
            return Err("bad notice category id");
        }
    }
    Ok(())
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
    // Historical files can deserialize values that this version no longer
    // accepts. Validate the field being edited so each such value remains
    // independently repairable and cannot block unrelated safe settings.
    match (section, key) {
        ("display", "zoom") if ![75, 100, 125, 150].contains(&next.display.zoom) => {
            return Err(invalid(key, "zoom must be 75/100/125/150"));
        }
        ("storage", "cache_days") if ![30, 90, 180, 365].contains(&next.storage.cache_days) => {
            return Err(invalid(key, "cache_days must be 30/90/180/365"));
        }
        ("keys", "toggle_main") if next.keys.toggle_main.trim().is_empty() => {
            return Err(invalid(key, "shortcut must not be empty"));
        }
        _ => {}
    }
    validate_notice_banner(&next.notice_banner).map_err(|why| invalid(key, why))?;
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
    reminder_sync: Mutex<()>,
    /// Notify effects produced by settings changes made here; drained by
    /// the scheduler on its next tick.
    pending: Mutex<Vec<Effect>>,
}

impl PrefsModule {
    fn data(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn save(&self, inner: &Inner) -> Result<(), AppError> {
        let path = self
            .path
            .as_ref()
            .ok_or_else(|| AppError::new("prefs.persistence", "preference storage unavailable"))?;
        let file = PrefsFile {
            reminder: inner.reminder.clone(),
            local: inner.local.clone(),
        };
        let dir = path.parent().ok_or_else(|| {
            AppError::new("prefs.persistence", "preference directory unavailable")
        })?;
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| AppError::new("prefs.persistence", "preference filename unavailable"))?;
        let bytes = serde_json::to_vec_pretty(&file).map_err(|e| {
            AppError::new(
                "prefs.persistence",
                format!("preference encode failed: {e}"),
            )
        })?;
        core_store::write_atomic(dir, name, &bytes)
            .map_err(|e| AppError::new("prefs.persistence", format!("preference save failed: {e}")))
    }

    /// Durable configuration and runtime application share one serial gate.
    /// Never acquire Cores while holding prefs data or doing the disk write.
    fn set_dnd_schedule(&self, state: &HostState, value: Value) -> Result<bool, AppError> {
        let _serial = self.reminder_sync.lock().unwrap_or_else(|p| p.into_inner());
        let enabled;
        {
            let mut inner = self.data();
            let next = apply_local(&inner.local, "dnd", "schedule_enabled", value)?;
            if next == inner.local {
                return Ok(false);
            }
            let candidate = Inner {
                local: next,
                reminder: inner.reminder.clone(),
            };
            self.save(&candidate)?;
            enabled = candidate.local.dnd.schedule_enabled;
            inner.local = candidate.local;
        }
        state.set_dnd_schedule_enabled(enabled);
        Ok(true)
    }

    /// Local reminder preferences promise durable save before runtime effects.
    /// Dedicated notify commands retain their immediate/asynchronous-save contract.
    fn set_reminder(&self, state: &HostState, key: &str, value: &Value) -> Result<(), AppError> {
        let _serial = self.reminder_sync.lock().unwrap_or_else(|p| p.into_inner());
        let next = apply_reminder(&state.settings(), key, value)?;
        self.persist_reminder(ReminderSettingsDto::from(&next))?;
        // notify_set_* can run during fsync. Patch only the requested field on
        // the latest core settings, never replace their concurrent changes.
        let effects = apply_core_reminder_patch(state, key, value)?;
        self.pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .extend(effects);
        Ok(())
    }

    /// The actual local preference transaction, shared with command-level tests.
    fn set_local(
        &self,
        section: &str,
        key: &str,
        value: Value,
        commit: impl FnOnce(&LocalPrefs, &Inner) -> Result<(), AppError>,
    ) -> Result<Option<LocalPrefs>, AppError> {
        ensure_runtime_support(section, key)?;
        let mut inner = self.data();
        let next = apply_local(&inner.local, section, key, value)?;
        let system_setting = (section == "general" && key == "autostart")
            || (section == "keys" && key == "toggle_main");
        if next == inner.local && !system_setting {
            return Ok(None);
        }
        let candidate = Inner {
            local: next.clone(),
            reminder: inner.reminder.clone(),
        };
        commit(&next, &candidate)?;
        Ok(Some(std::mem::replace(&mut inner.local, next)))
    }

    fn sync_reminder_from(
        &self,
        read: impl FnOnce() -> ReminderSettingsDto,
    ) -> Result<bool, AppError> {
        let _serial = self.reminder_sync.lock().unwrap_or_else(|p| p.into_inner());
        self.persist_reminder(read())
    }

    /// Only advance the persisted reminder snapshot after the durable write.
    /// On failure the next scheduler tick can retry the same core settings.
    fn persist_reminder(&self, current: ReminderSettingsDto) -> Result<bool, AppError> {
        let mut inner = self.data();
        if inner.reminder.as_ref() == Some(&current) {
            return Ok(false);
        }
        let candidate = Inner {
            local: inner.local.clone(),
            reminder: Some(current),
        };
        self.save(&candidate)?;
        inner.reminder = candidate.reminder;
        Ok(true)
    }
}

fn load(path: &PathBuf) -> PrefsFile {
    match std::fs::read(path) {
        Ok(bytes) => match serde_json::from_slice::<PrefsFile>(&bytes) {
            Ok(f) => f,
            Err(e) => {
                // 跨版本时（新版新增/旧版删掉的字段、枚举新值）整份严格解析会失败；
                // 先留底，再逐项保留本版本认得的字段，不能整份退回默认值。
                log::warn!("prefs: {FILE_NAME} not fully readable ({e}); salvaging known fields");
                crate::data_guard::preserve_unreadable(path);
                salvage(&bytes).unwrap_or_default()
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => PrefsFile::default(),
        Err(e) => {
            log::warn!("prefs: cannot read {FILE_NAME}: {e}; using defaults");
            PrefsFile::default()
        }
    }
}

/// 宽松读取：逐个 `section.key` 试着套进默认值，类型或取值不合本版本的项
/// 丢弃（原文件已由调用方留底），其余全部保留。不是 JSON 对象时返回 `None`。
fn salvage(bytes: &[u8]) -> Option<PrefsFile> {
    let root: Value = serde_json::from_slice(bytes).ok()?;
    let saved = root.as_object()?;
    let mut tree = serde_json::to_value(LocalPrefs::default()).ok()?;
    let sections: Vec<String> = tree.as_object()?.keys().cloned().collect();
    for section in sections {
        let Some(fields) = saved.get(&section).and_then(Value::as_object) else {
            continue;
        };
        for (key, value) in fields {
            if tree.get(&section).and_then(|s| s.get(key)).is_none() {
                continue;
            }
            let mut candidate = tree.clone();
            candidate[section.as_str()][key.as_str()] = value.clone();
            if serde_json::from_value::<LocalPrefs>(candidate.clone()).is_ok() {
                tree = candidate;
            }
        }
    }
    let local: LocalPrefs = serde_json::from_value(tree).ok()?;
    let reminder = saved
        .get("reminder")
        .and_then(|v| serde_json::from_value::<Option<ReminderSettingsDto>>(v.clone()).ok())
        .flatten();
    Some(PrefsFile { reminder, local })
}

/// Unsupported legacy values remain readable and mergeable, but cannot be
/// acknowledged as a working preference by the live command.
pub(crate) fn ensure_runtime_support(section: &str, key: &str) -> Result<(), AppError> {
    if matches!(
        (section, key),
        ("display", "gpu") | ("storage", "cache_days") | ("storage", "cache_mb")
    ) {
        return Err(AppError::new(
            contracts::codes::HOST_UNSUPPORTED,
            "unsupported preference runtime",
        ));
    }
    Ok(())
}

fn apply_core_reminder_patch(
    state: &HostState,
    key: &str,
    value: &Value,
) -> Result<Vec<Effect>, AppError> {
    let mut cores = state.lock();
    let next = apply_reminder(cores.notify.settings(), key, value)?;
    if &next == cores.notify.settings() {
        return Ok(Vec::new());
    }
    let now = state.now(&mut cores);
    cores.notify.set_settings(next, &now)
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
    state.set_dnd_schedule_enabled(file.local.dnd.schedule_enabled);
    let reminder = Some(ReminderSettingsDto::from(&state.settings()));
    crate::net_policy::set_use_system_proxy(file.local.network.system_proxy);
    crate::ui_zoom::init(app, file.local.display.zoom);
    app.manage(PrefsModule {
        path,
        inner: Mutex::new(Inner {
            local: file.local,
            reminder,
        }),
        reminder_sync: Mutex::new(()),
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
    let changed = match m
        .sync_reminder_from(|| ReminderSettingsDto::from(&app.state::<HostState>().settings()))
    {
        Ok(changed) => changed,
        Err(e) => {
            log::warn!("{e}");
            false
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

/// Settings-derived DND inputs for the scheduler.
pub fn dnd_prefs(app: &AppHandle) -> Option<DndPrefs> {
    module(app).map(|m| m.data().local.dnd.clone())
}

/// Puts a committed change into effect right away.
fn apply_runtime(app: &AppHandle, old: &LocalPrefs, new: &LocalPrefs) {
    if old.display.zoom != new.display.zoom {
        crate::ui_zoom::apply(app, new.display.zoom);
    }
    if old.network.system_proxy != new.network.system_proxy {
        crate::net_policy::set_use_system_proxy(new.network.system_proxy);
    }
    if old.dnd != new.dnd {
        crate::attention::sync(app, crate::attention::read());
    }
}

/// Key of an account in `notice_banner.accounts`; stable across re-logins.
pub fn notice_banner_key(account: &AccountContext) -> String {
    format!("{}:{}", account.environment.0, account.account_id.0)
}

pub fn notice_banner_accounts(app: &AppHandle) -> BTreeMap<String, Vec<String>> {
    module(app)
        .map(|m| m.data().local.notice_banner.accounts.clone())
        .unwrap_or_default()
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
            if let Err(e) = m.save(&inner) {
                log::warn!("{e}");
            }
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
    ensure_runtime_support(&section, &key)?;
    let m = module(&app).ok_or_else(|| {
        AppError::new(contracts::codes::HOST_UNSUPPORTED, "prefs not initialised")
    })?;
    if section == "reminder" {
        m.set_reminder(&state, &key, &value)?;
        if key == "position_bottom_right" {
            crate::windows::refit_alarm(&app);
        }
        return Ok(announce(&app));
    }
    if section == "dnd" && key == "schedule_enabled" {
        return if m.set_dnd_schedule(&state, value)? {
            crate::attention::sync(&app, crate::attention::read());
            Ok(announce(&app))
        } else {
            Ok(snapshot(&app))
        };
    }
    let previous = m.set_local(&section, &key, value, |next, candidate| {
        if section == "dnd" && key == "follow_system" && next.dnd.follow_system {
            crate::attention::ensure_follow_system_available()?;
        }
        let domain = match (section.as_str(), key.as_str()) {
            ("general", "autostart") => Some(crate::system_integration::Domain::Autostart),
            ("keys", "toggle_main") => Some(crate::system_integration::Domain::ToggleMain),
            _ => None,
        };
        if let Some(domain) = domain {
            crate::system_integration::apply(&app, next, domain, || m.save(candidate))
        } else {
            m.save(candidate)
        }
    })?;
    let Some(previous) = previous else {
        return Ok(snapshot(&app));
    };
    let current = m.data().local.clone();
    apply_runtime(&app, &previous, &current);
    Ok(announce(&app))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn local_reminder_save_failures_never_advance_runtime_or_effects_and_retry_once() {
        use core_store::hooks::{inject, FailPoint, FaultAction};
        for point in [
            FailPoint::BeforeWrite,
            FailPoint::BeforeSyncAll,
            FailPoint::BeforeSyncDir,
        ] {
            let root = std::env::temp_dir()
                .join(format!("vbk-reminder-transaction-{}", uuid::Uuid::new_v4()));
            let host = HostState::new(None, 1);
            let before = host.settings();
            let module = PrefsModule {
                path: Some(root.join("prefs.json")),
                inner: Mutex::new(Inner {
                    local: LocalPrefs::default(),
                    reminder: Some(ReminderSettingsDto::from(&before)),
                }),
                reminder_sync: Mutex::new(()),
                pending: Mutex::new(vec![Effect::UpdateAlarm]),
            };
            module.save(&module.data()).unwrap();
            let fault = inject(
                &root,
                point,
                FaultAction::Io(std::io::ErrorKind::PermissionDenied, "EACCES"),
                0,
                Some(1),
            );
            let error = module
                .set_reminder(&host, "taskbar_badge", &json!(false))
                .unwrap_err();
            assert_eq!(error.code, "prefs.persistence");
            assert_eq!(host.settings(), before, "{point:?}");
            assert_eq!(*module.pending.lock().unwrap(), vec![Effect::UpdateAlarm]);
            assert_eq!(
                module.data().reminder,
                Some(ReminderSettingsDto::from(&before))
            );
            drop(fault);
            module
                .set_reminder(&host, "taskbar_badge", &json!(false))
                .unwrap();
            assert!(!host.settings().taskbar_badge);
            assert_eq!(
                module
                    .pending
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|e| matches!(e, Effect::Unread { .. }))
                    .count(),
                1
            );
            let effects = module.pending.lock().unwrap().clone();
            module
                .set_reminder(&host, "taskbar_badge", &json!(false))
                .unwrap();
            assert_eq!(
                *module.pending.lock().unwrap(),
                effects,
                "same-value retry produces no duplicate effects"
            );
            assert_eq!(
                load(&root.join("prefs.json")).reminder,
                Some(ReminderSettingsDto::from(&host.settings()))
            );
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn durable_reminder_patch_preserves_concurrent_notify_commands_and_queued_sync() {
        use std::sync::{mpsc, Arc};
        let root =
            std::env::temp_dir().join(format!("vbk-reminder-concurrent-{}", uuid::Uuid::new_v4()));
        let host = Arc::new(HostState::new(None, 1));
        let module = Arc::new(PrefsModule {
            path: Some(root.join("prefs.json")),
            inner: Mutex::new(Inner {
                local: LocalPrefs::default(),
                reminder: None,
            }),
            reminder_sync: Mutex::new(()),
            pending: Mutex::new(Vec::new()),
        });
        // Execute the same transaction phases with notify commands interleaved
        // precisely in the fsync-to-runtime gap; no sleeps or timing assumptions.
        let serial = module.reminder_sync.lock().unwrap();
        let next = apply_reminder(&host.settings(), "continuous_l4", &json!(true)).unwrap();
        module
            .persist_reminder(ReminderSettingsDto::from(&next))
            .unwrap();
        for command in [
            contracts::AlarmCommand::SetEnabled(false),
            contracts::AlarmCommand::SetThreshold { t1_seconds: 90 },
            contracts::AlarmCommand::SetSoundEnabled(false),
        ] {
            host.alarm_command(command, core_notify::CommandSource::Setting)
                .unwrap();
        }
        let (entered, waiting) = mpsc::channel();
        let sync_module = module.clone();
        let sync_host = host.clone();
        let worker = std::thread::spawn(move || {
            entered.send(()).unwrap();
            sync_module.sync_reminder_from(|| ReminderSettingsDto::from(&sync_host.settings()))
        });
        waiting.recv().unwrap();
        apply_core_reminder_patch(&host, "continuous_l4", &json!(true)).unwrap();
        let merged = host.settings();
        assert!(merged.continuous_l4);
        assert!(!merged.enabled && !merged.timeout_sound);
        assert_eq!(merged.t1_seconds, 90);
        drop(serial);
        assert!(worker.join().unwrap().unwrap());
        assert_eq!(
            load(&root.join("prefs.json")).reminder,
            Some(ReminderSettingsDto::from(&merged))
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unsupported_runtime_preferences_reject_before_local_transaction_but_legacy_values_load() {
        let root =
            std::env::temp_dir().join(format!("vbk-unsupported-prefs-{}", uuid::Uuid::new_v4()));
        let module = PrefsModule {
            path: Some(root.join("prefs.json")),
            inner: Mutex::new(Inner {
                local: LocalPrefs::default(),
                reminder: None,
            }),
            reminder_sync: Mutex::new(()),
            pending: Mutex::new(Vec::new()),
        };
        module.save(&module.data()).unwrap();
        let bytes = std::fs::read(root.join("prefs.json")).unwrap();
        let before = module.data().local.clone();
        for (section, key, value) in [
            ("display", "gpu", json!(false)),
            ("storage", "cache_days", json!(90)),
            ("storage", "cache_mb", json!(500)),
        ] {
            let error = module
                .set_local(section, key, value, |_, _| {
                    panic!("unsupported preference reached commit")
                })
                .unwrap_err();
            assert_eq!(error.code, contracts::codes::HOST_UNSUPPORTED);
            assert_eq!(error.message, "unsupported preference runtime");
            assert!(!error.retryable);
            assert_eq!(module.data().local, before);
            assert_eq!(std::fs::read(root.join("prefs.json")).unwrap(), bytes);
        }
        for (section, key) in [
            ("dnd", "schedule_enabled"),
            ("dnd", "follow_system"),
            ("display", "zoom"),
            ("keys", "toggle_main"),
            ("general", "autostart"),
        ] {
            ensure_runtime_support(section, key).unwrap();
        }
        assert!(module
            .set_local("display", "zoom", json!(125), |_, candidate| module
                .save(candidate))
            .unwrap()
            .is_some());
        assert_eq!(load(&root.join("prefs.json")).local.display.zoom, 125);
        // Retain old JSON shape and pure merger for migrations/salvage.
        let legacy = apply_local(&before, "dnd", "follow_system", json!(false)).unwrap();
        let legacy = apply_local(&legacy, "display", "gpu", json!(false)).unwrap();
        let legacy = apply_local(&legacy, "storage", "cache_days", json!(180)).unwrap();
        let legacy = apply_local(&legacy, "storage", "cache_mb", json!(500)).unwrap();
        module
            .save(&Inner {
                local: legacy.clone(),
                reminder: None,
            })
            .unwrap();
        assert_eq!(load(&root.join("prefs.json")).local, legacy);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn dnd_schedule_save_failure_retry_and_restart_preserve_runtime_contract() {
        let root = std::env::temp_dir().join(format!("vbk-dnd-prefs-{}", uuid::Uuid::new_v4()));
        std::fs::write(&root, b"blocked parent").unwrap();
        let module = PrefsModule {
            path: Some(root.join("prefs.json")),
            inner: Mutex::new(Inner {
                local: LocalPrefs::default(),
                reminder: None,
            }),
            reminder_sync: Mutex::new(()),
            pending: Mutex::new(Vec::new()),
        };
        let host = HostState::new(None, 1);
        host.set_dnd_hours(1);
        let manual = host.lock().notify.dnd();
        assert!(!module.data().local.dnd.schedule_enabled);
        assert!(module.set_dnd_schedule(&host, json!(true)).is_err());
        assert!(!module.data().local.dnd.schedule_enabled);
        assert_eq!(
            host.lock().notify.dnd(),
            manual,
            "failed save must not advance runtime"
        );
        std::fs::remove_file(&root).unwrap();
        assert!(module.set_dnd_schedule(&host, json!(true)).unwrap());
        let saved = load(&root.join("prefs.json"));
        assert!(saved.local.dnd.schedule_enabled);
        // A duplicate save must not undo the tray's boot-local pause.
        host.clear_dnd();
        assert!(!module.set_dnd_schedule(&host, json!(true)).unwrap());
        assert_eq!(host.lock().notify.dnd(), core_notify::DndMode::Off);
        assert!(module.set_dnd_schedule(&host, json!(false)).unwrap());
        assert!(module.set_dnd_schedule(&host, json!(true)).unwrap());
        let expected = host.lock().notify.dnd();
        let restarted = HostState::new(None, 2);
        restarted
            .set_dnd_schedule_enabled(load(&root.join("prefs.json")).local.dnd.schedule_enabled);
        assert_eq!(restarted.lock().notify.dnd(), expected);
        assert!(restarted.settings().alert_during_dnd);
        assert!(module.set_dnd_schedule(&host, json!("true")).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn persistence_failure_is_returned_to_settings_transaction() {
        let root = std::env::temp_dir().join(format!(
            "vbk-prefs-failure-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&root, b"parent is a file").unwrap();
        let module = PrefsModule {
            path: Some(root.join("prefs.json")),
            inner: Mutex::new(Inner {
                local: LocalPrefs::default(),
                reminder: None,
            }),
            reminder_sync: Mutex::new(()),
            pending: Mutex::new(Vec::new()),
        };
        assert!(module.save(&module.data()).is_err());
        assert_eq!(std::fs::read(&root).unwrap(), b"parent is a file");
        std::fs::remove_file(root).unwrap();
    }

    #[test]
    fn notice_banner_only_takes_well_formed_categories() {
        let p = LocalPrefs::default();
        let good = json!({ "prod:a": ["1:2", "110:0"] });
        let n = apply_local(&p, "notice_banner", "accounts", good).unwrap();
        assert_eq!(n.notice_banner.accounts["prod:a"], ["1:2", "110:0"]);
        for bad in [
            json!({ "prod:a": ["system"] }),
            json!({ "prod:a": ["1:"] }),
            json!({ "": ["1:2"] }),
            json!(["1:2"]),
        ] {
            let e = apply_local(&p, "notice_banner", "accounts", bad).unwrap_err();
            assert_eq!(e.code, codes::INVALID_VALUE);
        }
    }

    #[test]
    fn failed_reminder_save_stays_retryable_and_preserves_local_preferences() {
        let root = std::env::temp_dir().join(format!("vbk-prefs-retry-{}", uuid::Uuid::new_v4()));
        std::fs::write(&root, b"blocked parent").unwrap();
        let mut local = LocalPrefs::default();
        local.display.zoom = 125;
        let module = PrefsModule {
            path: Some(root.join("prefs.json")),
            inner: Mutex::new(Inner {
                local,
                reminder: None,
            }),
            reminder_sync: Mutex::new(()),
            pending: Mutex::new(Vec::new()),
        };
        let reminder = ReminderSettingsDto::from(&ReminderSettings::default());
        assert!(module.persist_reminder(reminder.clone()).is_err());
        assert!(module.data().reminder.is_none());
        assert_eq!(std::fs::read(&root).unwrap(), b"blocked parent");
        std::fs::remove_file(&root).unwrap();
        assert!(module.persist_reminder(reminder.clone()).unwrap());
        let saved: PrefsFile =
            serde_json::from_slice(&std::fs::read(root.join("prefs.json")).unwrap()).unwrap();
        assert_eq!(saved.reminder.as_ref(), Some(&reminder));
        assert_eq!(saved.local.display.zoom, 125);
        assert!(!module.persist_reminder(reminder).unwrap());
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reminder_fsync_failures_preserve_retry_and_never_leave_partial_json() {
        use core_store::hooks::{inject, FailPoint, FaultAction, FsyncKind, FsyncProbe};
        for point in [
            FailPoint::BeforeWrite,
            FailPoint::BeforeSyncAll,
            FailPoint::BeforeSyncDir,
        ] {
            let root =
                std::env::temp_dir().join(format!("vbk-prefs-fsync-{}", uuid::Uuid::new_v4()));
            let module = PrefsModule {
                path: Some(root.join("prefs.json")),
                inner: Mutex::new(Inner {
                    local: LocalPrefs::default(),
                    reminder: None,
                }),
                reminder_sync: Mutex::new(()),
                pending: Mutex::new(Vec::new()),
            };
            module.save(&module.data()).unwrap();
            let probe = FsyncProbe::start(&root);
            let fault = inject(
                &root,
                point,
                FaultAction::Io(std::io::ErrorKind::PermissionDenied, "EACCES"),
                0,
                Some(1),
            );
            let reminder = ReminderSettingsDto::from(&ReminderSettings::default());
            assert!(
                module.persist_reminder(reminder.clone()).is_err(),
                "{point:?}"
            );
            assert!(module.data().reminder.is_none());
            let _: PrefsFile =
                serde_json::from_slice(&std::fs::read(root.join("prefs.json")).unwrap()).unwrap();
            drop(fault);
            assert!(module.persist_reminder(reminder.clone()).unwrap());
            assert_eq!(load(&root.join("prefs.json")).reminder, Some(reminder));
            let events = probe.events();
            assert!(events.iter().any(|event| event.kind == FsyncKind::File));
            assert_eq!(events.last().unwrap().kind, FsyncKind::Directory);
            assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn queued_reminder_sync_samples_after_the_successful_newer_save() {
        use std::sync::{mpsc, Arc};
        let root = std::env::temp_dir().join(format!("vbk-prefs-serial-{}", uuid::Uuid::new_v4()));
        let module = Arc::new(PrefsModule {
            path: Some(root.join("prefs.json")),
            inner: Mutex::new(Inner {
                local: LocalPrefs::default(),
                reminder: None,
            }),
            reminder_sync: Mutex::new(()),
            pending: Mutex::new(Vec::new()),
        });
        let current = Arc::new(Mutex::new(ReminderSettings::default()));
        let serial = module.reminder_sync.lock().unwrap();
        let (entered, waiting) = mpsc::channel();
        let worker_module = module.clone();
        let worker_current = current.clone();
        let worker = std::thread::spawn(move || {
            entered.send(()).unwrap();
            worker_module
                .sync_reminder_from(|| ReminderSettingsDto::from(&*worker_current.lock().unwrap()))
        });
        waiting.recv().unwrap();
        {
            let mut settings = current.lock().unwrap();
            settings.tray_flash = !settings.tray_flash;
        }
        let newest = ReminderSettingsDto::from(&*current.lock().unwrap());
        module.persist_reminder(newest.clone()).unwrap();
        drop(serial);
        assert!(!worker.join().unwrap().unwrap());
        assert_eq!(load(&root.join("prefs.json")).reminder, Some(newest));
        std::fs::remove_dir_all(root).unwrap();
    }

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
    fn invalid_legacy_shortcuts_do_not_block_unrelated_settings() {
        let old: LocalPrefs = serde_json::from_value(json!({
            "keys": { "toggle_main": "" }
        }))
        .unwrap();
        let next = apply_local(&old, "general", "show_msg_time", json!(false)).unwrap();
        assert!(!next.general.show_msg_time);
        assert_eq!(next.keys, old.keys);
        let repaired = apply_local(&old, "keys", "toggle_main", json!("Ctrl+Shift+Y")).unwrap();
        assert_eq!(repaired.keys.toggle_main, "Ctrl+Shift+Y");
        assert!(apply_local(&old, "keys", "toggle_main", json!(" ")).is_err());
        assert!(apply_local(&old, "general", "show_msg_time", json!("false")).is_err());
        assert!(apply_local(&old, "general", "unknown", json!(false)).is_err());
    }

    /// Screenshot was removed on 2026-11-05. A prefs.json written by an older
    /// build still carries `keys.screenshot`; it must parse strictly (no salvage,
    /// no `.unreadable` copy), keep the other keys, and vanish on the next save.
    #[test]
    fn legacy_screenshot_shortcut_in_prefs_file_is_ignored() {
        let root = std::env::temp_dir().join(format!("vbk-legacy-keys-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join(FILE_NAME);
        std::fs::write(
            &path,
            json!({
                "keys": {
                    "send_key": "ctrl_enter",
                    "screenshot": "Ctrl+Shift+X",
                    "toggle_main": "Ctrl+Alt+M"
                }
            })
            .to_string(),
        )
        .unwrap();
        let loaded = load(&path);
        assert_eq!(loaded.local.keys.send_key, SendKey::CtrlEnter);
        assert_eq!(loaded.local.keys.toggle_main, "Ctrl+Alt+M");
        assert_eq!(
            std::fs::read_dir(&root).unwrap().count(),
            1,
            "a tolerated legacy key must not trigger the unreadable-file path"
        );
        assert_eq!(
            apply_local(&loaded.local, "keys", "screenshot", json!("Ctrl+Shift+Y"))
                .unwrap_err()
                .code,
            codes::UNKNOWN_KEY
        );
        let module = PrefsModule {
            path: Some(path.clone()),
            inner: Mutex::new(Inner {
                local: loaded.local.clone(),
                reminder: None,
            }),
            reminder_sync: Mutex::new(()),
            pending: Mutex::new(Vec::new()),
        };
        module
            .save(&Inner {
                local: loaded.local,
                reminder: None,
            })
            .unwrap();
        let saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(saved["keys"].get("screenshot").is_none());
        assert_eq!(saved["keys"]["toggle_main"], "Ctrl+Alt+M");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_legacy_zoom_and_cache_days_can_be_repaired_independently() {
        let old: LocalPrefs = serde_json::from_value(json!({
            "display": { "zoom": 110 }, "storage": { "cache_days": 60 }
        }))
        .unwrap();
        let zoom = apply_local(&old, "display", "zoom", json!(125)).unwrap();
        assert_eq!(zoom.display.zoom, 125);
        assert_eq!(zoom.storage.cache_days, 60);
        let cache = apply_local(&old, "storage", "cache_days", json!(90)).unwrap();
        assert_eq!(cache.storage.cache_days, 90);
        assert_eq!(cache.display.zoom, 110);
        assert!(apply_local(&old, "display", "zoom", json!(110)).is_err());
        assert!(apply_local(&old, "storage", "cache_days", json!(60)).is_err());
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
    fn autostart_defaults_off_and_missing_field_stays_off() {
        // I-20: never enable launch-at-login without an explicit user action.
        assert!(!GeneralPrefs::default().autostart);
        let f: PrefsFile =
            serde_json::from_value(json!({ "general": { "start_hidden": true } })).unwrap();
        assert!(!f.local.general.autostart);
    }

    #[test]
    fn cross_version_file_keeps_every_known_field() {
        // 新版多写了字段、旧版删掉了字段或枚举出现新值：严格解析失败，
        // 但其余设置必须保留，不能整份退回默认值。
        let text = serde_json::to_vec(&json!({
            "general": { "start_hidden": true, "close_action": "minimize_to_moon", "future_flag": 1 },
            "keys": { "send_key": "ctrl_enter" },
            "display": "not-an-object",
            "future_section": { "x": 1 },
        }))
        .unwrap();
        assert!(serde_json::from_slice::<PrefsFile>(&text).is_err());
        let f = salvage(&text).expect("salvaged");
        assert!(f.local.general.start_hidden);
        assert_eq!(f.local.general.close_action, CloseAction::Tray);
        assert_eq!(f.local.keys.send_key, SendKey::CtrlEnter);
        assert_eq!(f.local.display, DisplayPrefs::default());
        assert!(salvage(b"{not json").is_none());
        assert!(salvage(b"[1,2]").is_none());
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

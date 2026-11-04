//! Rust-only OS integration. No plugin IPC permissions or remote webview access.
use std::{collections::HashMap, sync::Mutex};

use contracts::AppError;
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::prefs::LocalPrefs;

pub const SCREENSHOT_REQUEST: &str = "media://screenshot-request";
const ERROR: &str = "prefs.system_integration";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Action {
    Screenshot,
    ToggleMain,
}

#[cfg(test)]
fn shortcuts(prefs: &LocalPrefs) -> Result<[(Shortcut, Action); 2], AppError> {
    let parse = |value: &str| {
        value
            .parse::<Shortcut>()
            .map_err(|_| AppError::new(ERROR, "invalid global shortcut"))
    };
    let screenshot = parse(&prefs.keys.screenshot)?;
    let toggle = parse(&prefs.keys.toggle_main)?;
    if screenshot == toggle {
        return Err(AppError::new(ERROR, "global shortcuts must be different"));
    }
    Ok([
        (screenshot, Action::Screenshot),
        (toggle, Action::ToggleMain),
    ])
}

/// Explicitly supplied even for same-value saves, which retry failed OS sync.
#[derive(Clone, Copy)]
pub(crate) enum Domain {
    Autostart,
    Screenshot,
    ToggleMain,
}

trait Backend {
    fn autostart_enabled(&self) -> Result<bool, String>;
    fn autostart(&self, enabled: bool) -> Result<(), String>;
    fn bindings(&self) -> Vec<(Shortcut, Action)>;
    fn register(&self, shortcut: Shortcut, action: Action) -> Result<(), String>;
    fn unregister(&self, shortcut: Shortcut) -> Result<(), String>;
}

fn desired_shortcuts(
    prefs: &LocalPrefs,
    edited: Action,
    actual: &[(Shortcut, Action)],
) -> Result<Vec<(Shortcut, Action)>, AppError> {
    let (value, other_value, other_action) = match edited {
        Action::Screenshot => (
            &prefs.keys.screenshot,
            &prefs.keys.toggle_main,
            Action::ToggleMain,
        ),
        Action::ToggleMain => (
            &prefs.keys.toggle_main,
            &prefs.keys.screenshot,
            Action::Screenshot,
        ),
    };
    let key = value
        .parse::<Shortcut>()
        .map_err(|_| AppError::new(ERROR, "invalid global shortcut"))?;
    let other_key = other_value.parse::<Shortcut>().ok();
    if other_key == Some(key) {
        return Err(AppError::new(ERROR, "global shortcuts must be different"));
    }
    // Operate only on the edited action. Do not retry a different action's
    // missing registration: its OS conflict must not block this field.
    let mut desired: Vec<_> = actual
        .iter()
        .copied()
        .filter(|(_, action)| *action == other_action)
        .collect();
    // Repairing a legacy duplicate leaves its old physical key assigned to
    // the other action. Rebind an existing handler, but never acquire a
    // missing unrelated key.
    if let Some(other_key) = other_key {
        if actual.iter().any(|(have, _)| *have == other_key) {
            desired.retain(|(have, _)| *have != other_key);
            desired.push((other_key, other_action));
        }
    }
    if desired.iter().any(|(other_key, _)| *other_key == key) {
        return Err(AppError::new(
            ERROR,
            "global shortcut is still used by the other action",
        ));
    }
    desired.insert(0, (key, edited));
    Ok(desired)
}

// The plugin exposes whether this app owns a key, but cannot read its handler.
// Keep the action only after each successful OS operation; preference values
// are not a record of the actual handlers, especially after a failed rollback.
#[derive(Default)]
struct Bindings(Mutex<HashMap<Shortcut, Action>>);

struct Host<'a>(&'a AppHandle);
impl<'a> Host<'a> {
    fn new(app: &'a AppHandle) -> Self {
        app.manage(Bindings::default());
        Self(app)
    }
}
impl Backend for Host<'_> {
    fn autostart_enabled(&self) -> Result<bool, String> {
        self.0.autolaunch().is_enabled().map_err(|e| e.to_string())
    }
    fn autostart(&self, enabled: bool) -> Result<(), String> {
        let manager = self.0.autolaunch();
        if enabled {
            manager.enable()
        } else {
            manager.disable()
        }
        .map_err(|e| e.to_string())
    }
    fn bindings(&self) -> Vec<(Shortcut, Action)> {
        let state = self.0.state::<Bindings>();
        let bindings = state.0.lock().unwrap_or_else(|e| e.into_inner());
        bindings
            .iter()
            .filter(|(key, _)| self.0.global_shortcut().is_registered(**key))
            .map(|(key, action)| (*key, *action))
            .collect()
    }
    fn register(&self, shortcut: Shortcut, action: Action) -> Result<(), String> {
        self.0
            .global_shortcut()
            .on_shortcut(shortcut, move |app, _, event| {
                if event.state != ShortcutState::Pressed {
                    return;
                }
                match action {
                    Action::Screenshot => {
                        // The UI invokes the existing account/gid-guarded capture command.
                        // This event never captures or sends anything itself.
                        crate::windows::show_main(app);
                        crate::events::to_main(app, SCREENSHOT_REQUEST, serde_json::json!({}));
                    }
                    Action::ToggleMain => {
                        if let Some(main) = app.get_webview_window(crate::views::MAIN) {
                            if main.is_visible().unwrap_or(false)
                                && main.is_focused().unwrap_or(false)
                            {
                                let _ = main.hide();
                            } else {
                                crate::windows::show_main(app);
                            }
                        }
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        self.0
            .state::<Bindings>()
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(shortcut, action);
        Ok(())
    }
    fn unregister(&self, shortcut: Shortcut) -> Result<(), String> {
        self.0
            .global_shortcut()
            .unregister(shortcut)
            .map_err(|e| e.to_string())?;
        self.0
            .state::<Bindings>()
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&shortcut);
        Ok(())
    }
}

fn failure(message: String) -> AppError {
    AppError::new(ERROR, message).retryable()
}

/// Reconcile from actual successful registrations, never from persisted prefs.
/// New physical keys are acquired before old keys are released. Retained keys
/// with a different action must be unregistered and rebound explicitly.
fn reconcile<B: Backend>(backend: &B, desired: &[(Shortcut, Action)]) -> Result<(), String> {
    for &(key, action) in desired {
        if !backend.bindings().iter().any(|(have, _)| *have == key) {
            backend.register(key, action)?;
        }
    }
    for &(key, action) in desired {
        if backend.bindings().contains(&(key, action)) {
            continue;
        }
        backend.unregister(key)?;
        backend.register(key, action)?;
    }
    for (key, _) in backend.bindings() {
        if !desired.iter().any(|(want, _)| *want == key) {
            backend.unregister(key)?;
        }
    }
    Ok(())
}

/// Restore the snapshot first. If any previous binding cannot be restored,
/// keep other working replacements instead of deleting the last usable key.
fn restore<B: Backend>(backend: &B, before: &[(Shortcut, Action)]) -> Result<(), String> {
    let mut errors = Vec::new();
    for &(key, action) in before {
        let current = backend
            .bindings()
            .into_iter()
            .find(|(have, _)| *have == key);
        if current == Some((key, action)) {
            continue;
        }
        if current.is_some() {
            if let Err(e) = backend.unregister(key) {
                errors.push(e);
                continue;
            }
        }
        if let Err(e) = backend.register(key, action) {
            errors.push(e);
            // A failed same-key restoration should also preserve its last
            // working handler when possible.
            if let Some((key, fallback)) = current {
                if let Err(e) = backend.register(key, fallback) {
                    errors.push(e);
                }
            }
        }
    }
    if errors.is_empty() {
        for (key, _) in backend.bindings() {
            if !before.iter().any(|(old, _)| *old == key) {
                if let Err(e) = backend.unregister(key) {
                    errors.push(e);
                }
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn update<B: Backend>(
    backend: &B,
    next: &LocalPrefs,
    domain: Domain,
    save: impl FnOnce() -> Result<(), AppError>,
) -> Result<(), AppError> {
    match domain {
        Domain::Autostart => {
            let before = backend.autostart_enabled().map_err(failure)?;
            let changed = before != next.general.autostart;
            let result = (|| {
                if changed {
                    backend.autostart(next.general.autostart).map_err(failure)?;
                }
                save()
            })();
            if let Err(error) = result {
                if changed {
                    if let Err(e) = backend.autostart(before) {
                        return Err(failure(format!(
                            "{error}; OS rollback failed: {e}; retry saving this setting"
                        )));
                    }
                }
                return Err(error);
            }
            Ok(())
        }
        Domain::Screenshot | Domain::ToggleMain => {
            let before = backend.bindings();
            let edited = match domain {
                Domain::Screenshot => Action::Screenshot,
                Domain::ToggleMain => Action::ToggleMain,
                Domain::Autostart => unreachable!(),
            };
            let desired = desired_shortcuts(next, edited, &before)?;
            let result = reconcile(backend, &desired)
                .map_err(failure)
                .and_then(|()| save());
            if let Err(error) = result {
                if let Err(e) = restore(backend, &before) {
                    return Err(failure(format!(
                        "{error}; OS rollback failed: {e}; working replacement shortcuts retained where possible; retry saving this setting"
                    )));
                }
                return Err(error);
            }
            Ok(())
        }
    }
}

pub(crate) fn apply(
    app: &AppHandle,
    next: &LocalPrefs,
    domain: Domain,
    save: impl FnOnce() -> Result<(), AppError>,
) -> Result<(), AppError> {
    update(&Host::new(app), next, domain, save)
}

pub fn init(app: &AppHandle) {
    let prefs = crate::prefs::snapshot(app).local;
    let host = Host::new(app);
    // Default false never enables a login item. Errors remain visible and logged.
    if let Err(e) = update(&host, &prefs, Domain::Autostart, || Ok(())) {
        log::warn!("autostart sync failed: {e}");
        crate::events::toast(app, "开机启动设置应用失败，请在设置中重新保存");
    }
    for (value, action) in [
        (&prefs.keys.screenshot, Action::Screenshot),
        (&prefs.keys.toggle_main, Action::ToggleMain),
    ] {
        let result = value
            .parse::<Shortcut>()
            .map_err(|_| "invalid global shortcut".to_string())
            .and_then(|key| host.register(key, action));
        if let Err(e) = result {
            log::warn!("global shortcut registration failed: {e}");
            crate::events::toast(app, "全局快捷键注册失败，请在设置中更换快捷键");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    #[derive(Debug, PartialEq, Eq)]
    enum Call {
        ReadAutostart,
        Autostart(bool),
        Register(Shortcut, Action),
        Unregister(Shortcut),
    }

    #[derive(Default)]
    struct Fake {
        keys: RefCell<HashMap<Shortcut, Action>>,
        fail_register: RefCell<HashMap<Shortcut, usize>>,
        fail_unregister: Cell<Option<Shortcut>>,
        calls: RefCell<Vec<Call>>,
        enabled: Cell<bool>,
        fail_read_autostart: Cell<bool>,
        fail_enable: Cell<bool>,
    }
    impl Backend for Fake {
        fn autostart_enabled(&self) -> Result<bool, String> {
            self.calls.borrow_mut().push(Call::ReadAutostart);
            if self.fail_read_autostart.get() {
                return Err("login item status unavailable".into());
            }
            Ok(self.enabled.get())
        }
        fn autostart(&self, enabled: bool) -> Result<(), String> {
            self.calls.borrow_mut().push(Call::Autostart(enabled));
            if enabled && self.fail_enable.get() {
                return Err("login item denied".into());
            }
            self.enabled.set(enabled);
            Ok(())
        }
        fn bindings(&self) -> Vec<(Shortcut, Action)> {
            self.keys
                .borrow()
                .iter()
                .map(|(key, action)| (*key, *action))
                .collect()
        }
        fn register(&self, key: Shortcut, action: Action) -> Result<(), String> {
            self.calls.borrow_mut().push(Call::Register(key, action));
            if let Some(remaining) = self.fail_register.borrow_mut().get_mut(&key) {
                if *remaining > 0 {
                    *remaining -= 1;
                    return Err("occupied".into());
                }
            }
            // Like the plugin: an occupied physical key does not replace its handler.
            if self.keys.borrow().contains_key(&key) {
                return Err("already registered".into());
            }
            self.keys.borrow_mut().insert(key, action);
            Ok(())
        }
        fn unregister(&self, key: Shortcut) -> Result<(), String> {
            self.calls.borrow_mut().push(Call::Unregister(key));
            if self.fail_unregister.get() == Some(key) {
                return Err("unregister denied".into());
            }
            self.keys.borrow_mut().remove(&key);
            Ok(())
        }
    }

    fn fixture() -> (Fake, LocalPrefs, LocalPrefs) {
        let old = LocalPrefs::default();
        let fake = Fake::default();
        *fake.keys.borrow_mut() = shortcuts(&old).unwrap().into_iter().collect();
        let mut next = old.clone();
        next.keys.screenshot = "Ctrl+Shift+Y".into();
        (fake, old, next)
    }
    fn save_failure() -> Result<(), AppError> {
        Err(AppError::new("prefs.persistence", "disk full"))
    }
    fn expected(prefs: &LocalPrefs) -> HashMap<Shortcut, Action> {
        shortcuts(prefs).unwrap().into_iter().collect()
    }

    #[test]
    fn occupied_replacement_keeps_old_key_and_does_not_save() {
        let (fake, old, next) = fixture();
        let replacement = shortcuts(&next).unwrap()[0];
        fake.fail_register.borrow_mut().insert(replacement.0, 1);
        assert!(update(&fake, &next, Domain::Screenshot, || panic!("must not save")).is_err());
        assert_eq!(*fake.keys.borrow(), expected(&old));
        assert_eq!(
            *fake.calls.borrow(),
            [Call::Register(replacement.0, replacement.1)]
        );
    }

    #[test]
    fn registers_replacement_before_releasing_old_key() {
        let (fake, old, next) = fixture();
        update(&fake, &next, Domain::Screenshot, || Ok(())).unwrap();
        let replacement = shortcuts(&next).unwrap()[0];
        assert_eq!(
            *fake.calls.borrow(),
            [
                Call::Register(replacement.0, replacement.1),
                Call::Unregister(shortcuts(&old).unwrap()[0].0)
            ]
        );
        assert_eq!(*fake.keys.borrow(), expected(&next));
    }

    #[test]
    fn actual_autostart_snapshot_prevents_enabling_a_previously_disabled_item() {
        let (fake, mut persisted, _) = fixture();
        persisted.general.autostart = true;
        // A user or OS disabled the login item after preferences were saved.
        fake.enabled.set(false);
        let mut next = persisted;
        next.general.autostart = false;
        assert!(update(&fake, &next, Domain::Autostart, save_failure).is_err());
        assert!(!fake.enabled.get());
        assert_eq!(*fake.calls.borrow(), [Call::ReadAutostart]);
    }

    #[test]
    fn failed_save_restores_actual_autostart_after_a_real_transition() {
        let (fake, mut next, _) = fixture();
        next.general.autostart = true;
        assert!(update(&fake, &next, Domain::Autostart, save_failure).is_err());
        assert!(!fake.enabled.get());
        assert_eq!(
            *fake.calls.borrow(),
            [
                Call::ReadAutostart,
                Call::Autostart(true),
                Call::Autostart(false)
            ]
        );
    }

    #[test]
    fn denied_login_item_does_not_save_or_touch_shortcuts() {
        let (fake, old, mut next) = fixture();
        next.general.autostart = true;
        fake.fail_enable.set(true);
        assert!(update(&fake, &next, Domain::Autostart, || panic!("must not save")).is_err());
        assert!(!fake.enabled.get());
        assert_eq!(*fake.keys.borrow(), expected(&old));
        assert!(fake
            .calls
            .borrow()
            .iter()
            .all(|call| !matches!(call, Call::Register(..) | Call::Unregister(..))));
    }

    #[test]
    fn invalid_shortcuts_do_not_block_autostart_and_failed_autostart_does_not_block_keys() {
        let (fake, mut old, next) = fixture();
        old.keys.screenshot = "invalid".into();
        old.general.autostart = true;
        update(&fake, &old, Domain::Autostart, || Ok(())).unwrap();
        assert!(fake.enabled.get());
        fake.calls.borrow_mut().clear();
        fake.fail_read_autostart.set(true);
        fake.fail_enable.set(true);
        update(&fake, &next, Domain::Screenshot, || Ok(())).unwrap();
        assert_eq!(*fake.keys.borrow(), expected(&next));
        assert!(fake.enabled.get());
        assert!(fake
            .calls
            .borrow()
            .iter()
            .all(|call| !matches!(call, Call::ReadAutostart | Call::Autostart(..))));
    }

    #[test]
    fn failed_disk_save_restores_actual_shortcut_actions() {
        let (fake, old, next) = fixture();
        assert!(update(&fake, &next, Domain::Screenshot, save_failure).is_err());
        assert_eq!(*fake.keys.borrow(), expected(&old));
        assert!(!fake.enabled.get());
    }

    #[test]
    fn equivalent_aliases_and_invalid_edited_shortcuts_are_rejected_before_os_changes() {
        let (fake, old, mut prefs) = fixture();
        prefs.keys.toggle_main = "Control+Shift+X".into();
        assert!(update(&fake, &prefs, Domain::ToggleMain, || panic!(
            "must not save"
        ))
        .is_err());
        prefs.keys.toggle_main = "not a shortcut".into();
        assert!(update(&fake, &prefs, Domain::ToggleMain, || panic!(
            "must not save"
        ))
        .is_err());
        assert_eq!(*fake.keys.borrow(), expected(&old));
        assert!(fake.calls.borrow().is_empty());
    }

    #[test]
    fn legacy_duplicate_repair_rebinds_retained_physical_key_to_correct_action() {
        let fake = Fake::default();
        let mut old = LocalPrefs::default();
        old.keys.toggle_main = "Control+Shift+X".into();
        let x = old.keys.screenshot.parse().unwrap();
        fake.keys.borrow_mut().insert(x, Action::Screenshot);
        let mut next = old;
        next.keys.screenshot = "Ctrl+Shift+Y".into();
        update(&fake, &next, Domain::Screenshot, || Ok(())).unwrap();
        assert_eq!(*fake.keys.borrow(), expected(&next));
        assert_eq!(fake.keys.borrow().get(&x), Some(&Action::ToggleMain));
        assert!(fake
            .calls
            .borrow()
            .windows(2)
            .any(|calls| calls == [Call::Unregister(x), Call::Register(x, Action::ToggleMain)]));
    }

    #[test]
    fn failed_rebind_restores_actual_handler_instead_of_ambiguous_prefs_action() {
        let (fake, _, mut next) = fixture();
        let x = next.keys.screenshot.parse().unwrap();
        let original = fake.keys.borrow().clone();
        next.keys.toggle_main = next.keys.screenshot.clone();
        next.keys.screenshot = "Ctrl+Shift+Y".into();
        fake.fail_register.borrow_mut().insert(x, 1);
        assert!(update(&fake, &next, Domain::Screenshot, || panic!("must not save")).is_err());
        assert_eq!(*fake.keys.borrow(), original);
    }

    #[test]
    fn failed_old_key_restore_keeps_replacement_and_can_retry_same_target() {
        let (fake, old, next) = fixture();
        let old_key = shortcuts(&old).unwrap()[0].0;
        fake.fail_register.borrow_mut().insert(old_key, 1);
        let error = update(&fake, &next, Domain::Screenshot, save_failure).unwrap_err();
        assert!(error.retryable);
        assert!(error.message.contains("OS rollback failed"));
        assert!(error.message.contains("replacement shortcuts retained"));
        assert_eq!(*fake.keys.borrow(), expected(&next));
        // A retry uses actual registrations rather than re-registering an occupied key.
        update(&fake, &next, Domain::Screenshot, || Ok(())).unwrap();
        assert_eq!(*fake.keys.borrow(), expected(&next));
    }

    #[test]
    fn retrying_persisted_value_after_degraded_rollback_restores_old_key_and_removes_fallback() {
        let (fake, old, next) = fixture();
        fake.fail_register
            .borrow_mut()
            .insert(shortcuts(&old).unwrap()[0].0, 1);
        assert!(update(&fake, &next, Domain::Screenshot, save_failure).is_err());
        update(&fake, &old, Domain::Screenshot, || Ok(())).unwrap();
        assert_eq!(*fake.keys.borrow(), expected(&old));
    }

    #[test]
    fn unregister_failure_preserves_original_bindings_and_does_not_save() {
        let (fake, old, next) = fixture();
        fake.fail_unregister
            .set(Some(shortcuts(&old).unwrap()[0].0));
        assert!(update(&fake, &next, Domain::Screenshot, || panic!("must not save")).is_err());
        assert_eq!(*fake.keys.borrow(), expected(&old));
    }

    #[test]
    fn same_values_retry_startup_failures_only_in_requested_domain() {
        let (fake, mut prefs, _) = fixture();
        fake.keys.borrow_mut().clear();
        update(&fake, &prefs, Domain::Screenshot, || Ok(())).unwrap();
        assert_eq!(
            *fake.keys.borrow(),
            [(shortcuts(&prefs).unwrap()[0])].into_iter().collect()
        );
        assert!(fake
            .calls
            .borrow()
            .iter()
            .all(|call| matches!(call, Call::Register(..))));
        update(&fake, &prefs, Domain::ToggleMain, || Ok(())).unwrap();
        assert_eq!(*fake.keys.borrow(), expected(&prefs));
        fake.calls.borrow_mut().clear();
        prefs.general.autostart = true;
        update(&fake, &prefs, Domain::Autostart, || Ok(())).unwrap();
        assert!(fake.enabled.get());
        assert_eq!(
            *fake.calls.borrow(),
            [Call::ReadAutostart, Call::Autostart(true)]
        );
    }
    #[test]
    fn both_invalid_legacy_keys_can_be_repaired_one_field_at_a_time() {
        let fake = Fake::default();
        let mut next = LocalPrefs::default();
        next.keys.screenshot = "Ctrl+Shift+Y".into();
        next.keys.toggle_main = "invalid".into();
        update(&fake, &next, Domain::Screenshot, || Ok(())).unwrap();
        assert_eq!(fake.keys.borrow().len(), 1);
        next.keys.toggle_main = "Ctrl+Shift+J".into();
        update(&fake, &next, Domain::ToggleMain, || Ok(())).unwrap();
        assert_eq!(*fake.keys.borrow(), expected(&next));
    }

    #[test]
    fn malformed_other_preference_does_not_remove_its_working_handler() {
        let (fake, old, mut next) = fixture();
        next.keys.toggle_main = "invalid".into();
        let old_toggle = shortcuts(&old).unwrap()[1];
        update(&fake, &next, Domain::Screenshot, || Ok(())).unwrap();
        assert_eq!(fake.keys.borrow().get(&old_toggle.0), Some(&old_toggle.1));
        assert_eq!(
            fake.keys
                .borrow()
                .get(&next.keys.screenshot.parse().unwrap()),
            Some(&Action::Screenshot)
        );
    }
    #[test]
    fn missing_unrelated_shortcut_conflict_does_not_block_edited_action() {
        let (fake, old, next) = fixture();
        let toggle = shortcuts(&old).unwrap()[1].0;
        fake.keys.borrow_mut().remove(&toggle);
        fake.fail_register.borrow_mut().insert(toggle, 10);
        update(&fake, &next, Domain::Screenshot, || Ok(())).unwrap();
        assert!(!fake.keys.borrow().contains_key(&toggle));
        assert_eq!(
            fake.keys.borrow().get(&shortcuts(&next).unwrap()[0].0),
            Some(&Action::Screenshot)
        );
        assert!(!fake
            .calls
            .borrow()
            .iter()
            .any(|call| matches!(call, Call::Register(key, _) if *key == toggle)));
    }
}

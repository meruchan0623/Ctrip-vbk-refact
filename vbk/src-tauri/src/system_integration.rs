//! Rust-only OS integration. No plugin IPC permissions or remote webview access.
use std::{collections::HashSet, sync::Mutex};

use contracts::AppError;
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::prefs::LocalPrefs;

const ERROR: &str = "prefs.system_integration";

/// Explicitly supplied even for same-value saves, which retry failed OS sync.
#[derive(Clone, Copy)]
pub(crate) enum Domain {
    Autostart,
    ToggleMain,
}

trait Backend {
    fn autostart_enabled(&self) -> Result<bool, String>;
    fn autostart(&self, enabled: bool) -> Result<(), String>;
    fn bindings(&self) -> Vec<Shortcut>;
    fn register(&self, shortcut: Shortcut) -> Result<(), String>;
    fn unregister(&self, shortcut: Shortcut) -> Result<(), String>;
}

fn parse_shortcut(value: &str) -> Result<Shortcut, AppError> {
    value
        .parse::<Shortcut>()
        .map_err(|_| AppError::new(ERROR, "invalid global shortcut"))
}

// The plugin exposes whether this app owns a key, but cannot list its keys.
// Record a key only after each successful OS operation; preference values are
// not a record of the actual registrations, especially after a failed rollback.
#[derive(Default)]
struct Bindings(Mutex<HashSet<Shortcut>>);

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
    fn bindings(&self) -> Vec<Shortcut> {
        let state = self.0.state::<Bindings>();
        let bindings = state.0.lock().unwrap_or_else(|e| e.into_inner());
        bindings
            .iter()
            .filter(|key| self.0.global_shortcut().is_registered(**key))
            .copied()
            .collect()
    }
    fn register(&self, shortcut: Shortcut) -> Result<(), String> {
        self.0
            .global_shortcut()
            .on_shortcut(shortcut, move |app, _, event| {
                if event.state != ShortcutState::Pressed {
                    return;
                }
                if let Some(main) = app.get_webview_window(crate::views::MAIN) {
                    if main.is_visible().unwrap_or(false) && main.is_focused().unwrap_or(false) {
                        let _ = main.hide();
                    } else {
                        crate::windows::show_main(app);
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        self.0
            .state::<Bindings>()
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(shortcut);
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
/// The new physical key is acquired before old keys are released.
fn reconcile<B: Backend>(backend: &B, desired: Shortcut) -> Result<(), String> {
    if !backend.bindings().contains(&desired) {
        backend.register(desired)?;
    }
    for key in backend.bindings() {
        if key != desired {
            backend.unregister(key)?;
        }
    }
    Ok(())
}

/// Restore the snapshot first. If any previous binding cannot be restored,
/// keep the working replacement instead of deleting the last usable key.
fn restore<B: Backend>(backend: &B, before: &[Shortcut]) -> Result<(), String> {
    let mut errors = Vec::new();
    for &key in before {
        if backend.bindings().contains(&key) {
            continue;
        }
        if let Err(e) = backend.register(key) {
            errors.push(e);
        }
    }
    if errors.is_empty() {
        for key in backend.bindings() {
            if !before.contains(&key) {
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
        Domain::ToggleMain => {
            let before = backend.bindings();
            let desired = parse_shortcut(&next.keys.toggle_main)?;
            let result = reconcile(backend, desired)
                .map_err(failure)
                .and_then(|()| save());
            if let Err(error) = result {
                if let Err(e) = restore(backend, &before) {
                    return Err(failure(format!(
                        "{error}; OS rollback failed: {e}; working replacement shortcut retained where possible; retry saving this setting"
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
    let result = prefs
        .keys
        .toggle_main
        .parse::<Shortcut>()
        .map_err(|_| "invalid global shortcut".to_string())
        .and_then(|key| host.register(key));
    if let Err(e) = result {
        log::warn!("global shortcut registration failed: {e}");
        crate::events::toast(app, "全局快捷键注册失败，请在设置中更换快捷键");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;

    #[derive(Debug, PartialEq, Eq)]
    enum Call {
        ReadAutostart,
        Autostart(bool),
        Register(Shortcut),
        Unregister(Shortcut),
    }

    #[derive(Default)]
    struct Fake {
        keys: RefCell<HashSet<Shortcut>>,
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
        fn bindings(&self) -> Vec<Shortcut> {
            self.keys.borrow().iter().copied().collect()
        }
        fn register(&self, key: Shortcut) -> Result<(), String> {
            self.calls.borrow_mut().push(Call::Register(key));
            if let Some(remaining) = self.fail_register.borrow_mut().get_mut(&key) {
                if *remaining > 0 {
                    *remaining -= 1;
                    return Err("occupied".into());
                }
            }
            // Like the plugin: an occupied physical key is refused.
            if self.keys.borrow().contains(&key) {
                return Err("already registered".into());
            }
            self.keys.borrow_mut().insert(key);
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

    fn key(prefs: &LocalPrefs) -> Shortcut {
        parse_shortcut(&prefs.keys.toggle_main).unwrap()
    }
    fn fixture() -> (Fake, LocalPrefs, LocalPrefs) {
        let old = LocalPrefs::default();
        let fake = Fake::default();
        fake.keys.borrow_mut().insert(key(&old));
        let mut next = old.clone();
        next.keys.toggle_main = "Ctrl+Shift+Y".into();
        (fake, old, next)
    }
    fn save_failure() -> Result<(), AppError> {
        Err(AppError::new("prefs.persistence", "disk full"))
    }
    fn expected(prefs: &LocalPrefs) -> HashSet<Shortcut> {
        [key(prefs)].into_iter().collect()
    }

    #[test]
    fn occupied_replacement_keeps_old_key_and_does_not_save() {
        let (fake, old, next) = fixture();
        let replacement = key(&next);
        fake.fail_register.borrow_mut().insert(replacement, 1);
        assert!(update(&fake, &next, Domain::ToggleMain, || panic!("must not save")).is_err());
        assert_eq!(*fake.keys.borrow(), expected(&old));
        assert_eq!(*fake.calls.borrow(), [Call::Register(replacement)]);
    }

    #[test]
    fn registers_replacement_before_releasing_old_key() {
        let (fake, old, next) = fixture();
        update(&fake, &next, Domain::ToggleMain, || Ok(())).unwrap();
        assert_eq!(
            *fake.calls.borrow(),
            [Call::Register(key(&next)), Call::Unregister(key(&old))]
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
        old.keys.toggle_main = "invalid".into();
        old.general.autostart = true;
        update(&fake, &old, Domain::Autostart, || Ok(())).unwrap();
        assert!(fake.enabled.get());
        fake.calls.borrow_mut().clear();
        fake.fail_read_autostart.set(true);
        fake.fail_enable.set(true);
        update(&fake, &next, Domain::ToggleMain, || Ok(())).unwrap();
        assert_eq!(*fake.keys.borrow(), expected(&next));
        assert!(fake.enabled.get());
        assert!(fake
            .calls
            .borrow()
            .iter()
            .all(|call| !matches!(call, Call::ReadAutostart | Call::Autostart(..))));
    }

    #[test]
    fn failed_disk_save_restores_actual_shortcut() {
        let (fake, old, next) = fixture();
        assert!(update(&fake, &next, Domain::ToggleMain, save_failure).is_err());
        assert_eq!(*fake.keys.borrow(), expected(&old));
        assert!(!fake.enabled.get());
    }

    #[test]
    fn invalid_edited_shortcuts_are_rejected_before_os_changes() {
        let (fake, old, mut prefs) = fixture();
        prefs.keys.toggle_main = "not a shortcut".into();
        assert!(update(&fake, &prefs, Domain::ToggleMain, || panic!(
            "must not save"
        ))
        .is_err());
        assert_eq!(*fake.keys.borrow(), expected(&old));
        assert!(fake.calls.borrow().is_empty());
    }

    #[test]
    fn equivalent_alias_of_the_registered_key_saves_without_os_changes() {
        let (fake, old, mut prefs) = fixture();
        prefs.keys.toggle_main = "Control+Alt+V".into();
        assert_eq!(key(&prefs), key(&old));
        update(&fake, &prefs, Domain::ToggleMain, || Ok(())).unwrap();
        assert_eq!(*fake.keys.borrow(), expected(&old));
        assert!(fake.calls.borrow().is_empty());
    }

    #[test]
    fn failed_old_key_restore_keeps_replacement_and_can_retry_same_target() {
        let (fake, old, next) = fixture();
        fake.fail_register.borrow_mut().insert(key(&old), 1);
        let error = update(&fake, &next, Domain::ToggleMain, save_failure).unwrap_err();
        assert!(error.retryable);
        assert!(error.message.contains("OS rollback failed"));
        assert!(error.message.contains("replacement shortcut retained"));
        assert_eq!(*fake.keys.borrow(), expected(&next));
        // A retry uses actual registrations rather than re-registering an occupied key.
        update(&fake, &next, Domain::ToggleMain, || Ok(())).unwrap();
        assert_eq!(*fake.keys.borrow(), expected(&next));
    }

    #[test]
    fn retrying_persisted_value_after_degraded_rollback_restores_old_key_and_removes_fallback() {
        let (fake, old, next) = fixture();
        fake.fail_register.borrow_mut().insert(key(&old), 1);
        assert!(update(&fake, &next, Domain::ToggleMain, save_failure).is_err());
        update(&fake, &old, Domain::ToggleMain, || Ok(())).unwrap();
        assert_eq!(*fake.keys.borrow(), expected(&old));
    }

    #[test]
    fn unregister_failure_preserves_original_bindings_and_does_not_save() {
        let (fake, old, next) = fixture();
        fake.fail_unregister.set(Some(key(&old)));
        assert!(update(&fake, &next, Domain::ToggleMain, || panic!("must not save")).is_err());
        assert_eq!(*fake.keys.borrow(), expected(&old));
    }

    #[test]
    fn same_values_retry_startup_failures_only_in_requested_domain() {
        let (fake, mut prefs, _) = fixture();
        fake.keys.borrow_mut().clear();
        update(&fake, &prefs, Domain::ToggleMain, || Ok(())).unwrap();
        assert_eq!(*fake.keys.borrow(), expected(&prefs));
        assert!(fake
            .calls
            .borrow()
            .iter()
            .all(|call| matches!(call, Call::Register(..))));
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
    fn invalid_legacy_key_can_be_repaired_after_startup_registered_nothing() {
        let fake = Fake::default();
        let mut next = LocalPrefs::default();
        next.keys.toggle_main = "invalid".into();
        assert!(update(&fake, &next, Domain::ToggleMain, || panic!("must not save")).is_err());
        assert!(fake.keys.borrow().is_empty());
        next.keys.toggle_main = "Ctrl+Shift+J".into();
        update(&fake, &next, Domain::ToggleMain, || Ok(())).unwrap();
        assert_eq!(*fake.keys.borrow(), expected(&next));
    }

    #[test]
    fn persisted_key_held_by_another_app_does_not_block_choosing_a_new_one() {
        let (fake, old, next) = fixture();
        // Startup could not register the persisted key: another app holds it.
        fake.keys.borrow_mut().remove(&key(&old));
        fake.fail_register.borrow_mut().insert(key(&old), 10);
        update(&fake, &next, Domain::ToggleMain, || Ok(())).unwrap();
        assert_eq!(*fake.keys.borrow(), expected(&next));
        assert!(!fake
            .calls
            .borrow()
            .iter()
            .any(|call| matches!(call, Call::Register(k) if *k == key(&old))));
    }
}

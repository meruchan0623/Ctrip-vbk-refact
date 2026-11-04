//! Rust-only OS integration. No plugin IPC permissions or remote webview access.
use contracts::AppError;
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::prefs::LocalPrefs;

const ERROR: &str = "prefs.system_integration";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Action {
    ToggleMain,
}

fn shortcuts(prefs: &LocalPrefs) -> Result<[(Shortcut, Action); 1], AppError> {
    let toggle = prefs
        .keys
        .toggle_main
        .parse::<Shortcut>()
        .map_err(|_| AppError::new(ERROR, "invalid global shortcut"))?;
    Ok([(toggle, Action::ToggleMain)])
}

trait Backend {
    fn autostart(&self, enabled: bool) -> Result<(), String>;
    fn registered(&self, shortcut: Shortcut) -> bool;
    fn register(&self, shortcut: Shortcut, action: Action) -> Result<(), String>;
    fn unregister(&self, shortcut: Shortcut) -> Result<(), String>;
}

struct Host<'a>(&'a AppHandle);
impl Backend for Host<'_> {
    fn autostart(&self, enabled: bool) -> Result<(), String> {
        let manager = self.0.autolaunch();
        let have = manager.is_enabled().map_err(|e| e.to_string())?;
        if have == enabled {
            return Ok(());
        }
        if enabled {
            manager.enable()
        } else {
            manager.disable()
        }
        .map_err(|e| e.to_string())
    }
    fn registered(&self, shortcut: Shortcut) -> bool {
        self.0.global_shortcut().is_registered(shortcut)
    }
    fn register(&self, shortcut: Shortcut, action: Action) -> Result<(), String> {
        self.0
            .global_shortcut()
            .on_shortcut(shortcut, move |app, _, event| {
                if event.state != ShortcutState::Pressed {
                    return;
                }
                match action {
                    Action::ToggleMain => {
                        if let Some(main) = app.get_window(crate::views::MAIN) {
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
            .map_err(|e| e.to_string())
    }
    fn unregister(&self, shortcut: Shortcut) -> Result<(), String> {
        self.0
            .global_shortcut()
            .unregister(shortcut)
            .map_err(|e| e.to_string())
    }
}

// One prefs_set changes one field. Register the replacement before releasing the
// previous key. Roll back on registration, unregister, or persistence failures.
fn update<B: Backend>(
    backend: &B,
    old: &LocalPrefs,
    next: &LocalPrefs,
    save: impl FnOnce() -> Result<(), AppError>,
) -> Result<(), AppError> {
    // Invalid legacy strings must not prevent the user from repairing settings.
    let old_keys: Vec<_> = [(&old.keys.toggle_main, Action::ToggleMain)]
        .into_iter()
        .filter_map(|(key, action)| key.parse::<Shortcut>().ok().map(|key| (key, action)))
        .collect();
    let new_keys = shortcuts(next)?;
    let mut added = Vec::new();
    let mut removed = Vec::new();
    let autostart_changed = old.general.autostart != next.general.autostart;
    let result = (|| {
        for (shortcut, action) in new_keys {
            if !old_keys.contains(&(shortcut, action)) || !backend.registered(shortcut) {
                backend
                    .register(shortcut, action)
                    .map_err(|e| AppError::new(ERROR, e))?;
                added.push(shortcut);
            }
        }
        for &(shortcut, action) in &old_keys {
            if !new_keys.iter().any(|(key, _)| *key == shortcut) && backend.registered(shortcut) {
                backend
                    .unregister(shortcut)
                    .map_err(|e| AppError::new(ERROR, e))?;
                removed.push((shortcut, action));
            }
        }
        backend
            .autostart(next.general.autostart)
            .map_err(|e| AppError::new(ERROR, e))?;
        save()
    })();
    if let Err(error) = result {
        let mut rollback_errors = Vec::new();
        for (shortcut, action) in removed {
            if let Err(e) = backend.register(shortcut, action) {
                rollback_errors.push(e);
            }
        }
        for shortcut in added {
            if let Err(e) = backend.unregister(shortcut) {
                rollback_errors.push(e);
            }
        }
        if autostart_changed {
            if let Err(e) = backend.autostart(old.general.autostart) {
                rollback_errors.push(e);
            }
        }
        if !rollback_errors.is_empty() {
            return Err(AppError::new(
                ERROR,
                format!(
                    "{error}; OS rollback failed: {}",
                    rollback_errors.join("; ")
                ),
            ));
        }
        return Err(error);
    }
    Ok(())
}

pub fn apply(
    app: &AppHandle,
    old: &LocalPrefs,
    next: &LocalPrefs,
    save: impl FnOnce() -> Result<(), AppError>,
) -> Result<(), AppError> {
    update(&Host(app), old, next, save)
}

pub fn init(app: &AppHandle) {
    let prefs = crate::prefs::snapshot(app).local;
    let host = Host(app);
    // Default false never enables a login item. Errors remain visible and logged.
    if let Err(e) = host.autostart(prefs.general.autostart) {
        log::warn!("autostart sync failed: {e}");
        crate::events::toast(app, "开机启动设置应用失败，请在设置中重新保存");
    }
    match shortcuts(&prefs) {
        Ok(keys) => {
            for (shortcut, action) in keys {
                if let Err(e) = host.register(shortcut, action) {
                    log::warn!("global shortcut registration failed: {e}");
                    crate::events::toast(app, "全局快捷键注册失败，请在设置中更换快捷键");
                }
            }
        }
        Err(e) => {
            log::warn!("system integration startup failed: {e}");
            crate::events::toast(app, "系统设置应用失败，请在设置中重新保存");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    #[derive(Default)]
    struct Fake {
        keys: RefCell<Vec<(Shortcut, Action)>>,
        fail_register: RefCell<Option<Shortcut>>,
        calls: RefCell<Vec<&'static str>>,
        enabled: RefCell<bool>,
        fail_enable: RefCell<bool>,
    }
    impl Backend for Fake {
        fn autostart(&self, enabled: bool) -> Result<(), String> {
            if enabled && *self.fail_enable.borrow() {
                return Err("login item denied".into());
            }
            *self.enabled.borrow_mut() = enabled;
            Ok(())
        }
        fn registered(&self, key: Shortcut) -> bool {
            self.keys.borrow().iter().any(|(k, _)| *k == key)
        }
        fn register(&self, key: Shortcut, action: Action) -> Result<(), String> {
            self.calls.borrow_mut().push("register");
            if *self.fail_register.borrow() == Some(key) {
                return Err("occupied".into());
            }
            self.keys.borrow_mut().push((key, action));
            Ok(())
        }
        fn unregister(&self, key: Shortcut) -> Result<(), String> {
            self.calls.borrow_mut().push("unregister");
            self.keys.borrow_mut().retain(|(k, _)| *k != key);
            Ok(())
        }
    }
    fn fixture() -> (Fake, LocalPrefs, LocalPrefs) {
        let old = LocalPrefs::default();
        let fake = Fake::default();
        *fake.keys.borrow_mut() = shortcuts(&old).unwrap().to_vec();
        let mut next = old.clone();
        next.keys.toggle_main = "Ctrl+Shift+Y".into();
        (fake, old, next)
    }
    #[test]
    fn occupied_replacement_keeps_old_key_and_does_not_save() {
        let (fake, old, next) = fixture();
        *fake.fail_register.borrow_mut() = Some(shortcuts(&next).unwrap()[0].0);
        assert!(update(&fake, &old, &next, || panic!("must not save")).is_err());
        assert_eq!(*fake.keys.borrow(), shortcuts(&old).unwrap().to_vec());
        assert_eq!(*fake.calls.borrow(), vec!["register"]);
    }
    #[test]
    fn registers_replacement_before_releasing_old_key() {
        let (fake, old, next) = fixture();
        update(&fake, &old, &next, || Ok(())).unwrap();
        assert_eq!(*fake.calls.borrow(), vec!["register", "unregister"]);
        assert!(fake.registered(shortcuts(&next).unwrap()[0].0));
        assert!(!fake.registered(shortcuts(&old).unwrap()[0].0));
    }
    #[test]
    fn denied_login_item_does_not_save_and_restores_shortcuts() {
        let (fake, old, mut next) = fixture();
        next.general.autostart = true;
        *fake.fail_enable.borrow_mut() = true;
        assert!(update(&fake, &old, &next, || panic!("must not save")).is_err());
        assert!(!*fake.enabled.borrow());
        assert!(fake.registered(shortcuts(&old).unwrap()[0].0));
        assert!(!fake.registered(shortcuts(&next).unwrap()[0].0));
    }
    #[test]
    fn failed_disk_save_restores_old_shortcuts_and_autostart() {
        let (fake, old, mut next) = fixture();
        next.general.autostart = true;
        assert!(update(&fake, &old, &next, || Err(AppError::new(
            "prefs.persistence",
            "disk full"
        )))
        .is_err());
        assert!(!*fake.enabled.borrow());
        let mut actual = fake.keys.borrow().clone();
        actual.sort_by_key(|(key, _)| key.id());
        let mut expected = shortcuts(&old).unwrap().to_vec();
        expected.sort_by_key(|(key, _)| key.id());
        assert_eq!(actual, expected);
    }
    #[test]
    fn unparseable_shortcut_is_rejected() {
        let mut prefs = LocalPrefs::default();
        prefs.keys.toggle_main = "not a shortcut".into();
        assert!(shortcuts(&prefs).is_err());
    }
    #[test]
    fn saving_same_shortcut_retries_a_failed_startup_registration() {
        let (fake, old, _) = fixture();
        fake.keys.borrow_mut().clear();
        update(&fake, &old, &old, || Ok(())).unwrap();
        assert_eq!(*fake.keys.borrow(), shortcuts(&old).unwrap().to_vec());
        assert!(!*fake.enabled.borrow());
    }
    #[test]
    fn invalid_legacy_shortcut_can_be_repaired() {
        let (fake, mut old, next) = fixture();
        old.keys.toggle_main = "invalid".into();
        update(&fake, &old, &next, || Ok(())).unwrap();
        assert!(fake.registered(shortcuts(&next).unwrap()[0].0));
    }
}

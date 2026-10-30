//! View registry: the host-side source of truth for which webview label may
//! issue which command and under which `view_generation` (archive §4.0,
//! §5). Capability files are the static ACL; this is the runtime
//! defense-in-depth that also rejects a reused label after a rebuild.

use std::collections::HashMap;

use contracts::{codes, AppError, ViewContext};

/// Local window labels. Remote webviews (official login page, order detail,
/// the "IM 联系" tab) are never registered here and therefore never pass
/// `authorize`.
pub const MAIN: &str = "main";
pub const ALARM: &str = "alarm";
pub const SETTING: &str = "setting";
pub const UPDATE: &str = "update";
pub const LOGIN: &str = "login";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Role {
    MainShell,
    AlarmPopup,
    Setting,
    Update,
    LoginShell,
}

impl Role {
    pub fn for_label(label: &str) -> Option<Role> {
        match label {
            MAIN => Some(Role::MainShell),
            ALARM => Some(Role::AlarmPopup),
            SETTING => Some(Role::Setting),
            UPDATE => Some(Role::Update),
            LOGIN => Some(Role::LoginShell),
            _ => None,
        }
    }

    /// Commands a role may invoke. Mirrors `capabilities/*.json`.
    pub fn allows(&self, command: &str) -> bool {
        const MAIN_CMDS: &[&str] = &[
            "account_snapshot",
            "account_start_login",
            "account_switch",
            "account_suspend",
            "account_logout",
            "account_forget",
            "im_push_fact",
            "im_conversation_snapshot",
            "im_locate_conversation",
            "order_validate_im_url",
            "prefs_snapshot",
            "notify_set_enabled",
            "notify_set_threshold",
            "notify_set_sound_enabled",
        ];
        const ALARM_CMDS: &[&str] = &[
            "notify_snapshot",
            "notify_open_conversation",
            "notify_hide_round",
            "notify_hide_all",
            "notify_snooze",
            "prefs_snapshot",
        ];
        const SETTING_CMDS: &[&str] = &[
            "prefs_snapshot",
            "account_snapshot",
            "notify_set_enabled",
            "notify_set_threshold",
            "notify_set_sound_enabled",
        ];
        const UPDATE_CMDS: &[&str] = &["prefs_snapshot"];
        const LOGIN_CMDS: &[&str] = &["account_snapshot", "account_start_login", "prefs_snapshot"];
        let list = match self {
            Role::MainShell => MAIN_CMDS,
            Role::AlarmPopup => ALARM_CMDS,
            Role::Setting => SETTING_CMDS,
            Role::Update => UPDATE_CMDS,
            Role::LoginShell => LOGIN_CMDS,
        };
        list.contains(&command)
    }
}

#[derive(Debug, Default)]
pub struct ViewRegistry {
    generations: HashMap<String, u64>,
}

impl ViewRegistry {
    /// Registers (or re-registers) a label; every call bumps the generation,
    /// so a webview rebuilt under the same label gets a new context.
    pub fn register(&mut self, label: &str) -> ViewContext {
        let g = self.generations.entry(label.to_string()).or_insert(0);
        *g += 1;
        ViewContext::new(label, *g)
    }

    pub fn current(&self, label: &str) -> Option<ViewContext> {
        self.generations
            .get(label)
            .map(|g| ViewContext::new(label, *g))
    }

    /// Checks that `label` is a registered local view whose role may invoke
    /// `command`. Returns the current view context for binding results.
    pub fn authorize(&self, label: &str, command: &str) -> Result<ViewContext, AppError> {
        let role = Role::for_label(label).ok_or_else(|| {
            AppError::new(
                codes::HOST_VIEW_UNAUTHORIZED,
                format!("label {label:?} is not a local view"),
            )
        })?;
        if !role.allows(command) {
            return Err(AppError::new(
                codes::HOST_VIEW_UNAUTHORIZED,
                format!("view {label:?} may not invoke {command}"),
            ));
        }
        self.current(label).ok_or_else(|| {
            AppError::new(
                codes::HOST_VIEW_UNAUTHORIZED,
                format!("view {label:?} is not registered"),
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alarm_cannot_push_facts_or_send() {
        let mut r = ViewRegistry::default();
        r.register(ALARM);
        assert!(r.authorize(ALARM, "notify_snapshot").is_ok());
        assert!(r.authorize(ALARM, "im_push_fact").is_err());
        assert!(r.authorize(ALARM, "account_logout").is_err());
        assert!(r.authorize("web-remote-1", "prefs_snapshot").is_err());
        assert!(
            r.authorize(MAIN, "prefs_snapshot").is_err(),
            "unregistered main"
        );
    }

    #[test]
    fn re_register_bumps_generation() {
        let mut r = ViewRegistry::default();
        let a = r.register(MAIN);
        let b = r.register(MAIN);
        assert_eq!(a.view_generation + 1, b.view_generation);
    }
}

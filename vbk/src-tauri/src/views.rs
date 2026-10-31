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
/// Prefix of per-account official-page webviews running the web-adapter
/// boot script. Each one is registered under its full label when created.
pub const ACCOUNT_WEBVIEW_PREFIX: &str = "acct-";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Role {
    MainShell,
    AlarmPopup,
    Setting,
    Update,
    LoginShell,
    /// Remote official IM page of one account (`acct-*`). Only the narrow
    /// `adapter_*` commands; never account, prefs or shell commands.
    Adapter,
}

impl Role {
    pub fn for_label(label: &str) -> Option<Role> {
        match label {
            MAIN => Some(Role::MainShell),
            ALARM => Some(Role::AlarmPopup),
            SETTING => Some(Role::Setting),
            UPDATE => Some(Role::Update),
            LOGIN => Some(Role::LoginShell),
            l if l.starts_with(ACCOUNT_WEBVIEW_PREFIX) => Some(Role::Adapter),
            _ => None,
        }
    }

    /// Commands a role may invoke. Mirrors `capabilities/*.json`.
    pub fn allows(&self, command: &str) -> bool {
        const MAIN_CMDS: &[&str] = &[
            "account_snapshot",
            "account_start_login",
            "account_cancel_login",
            "account_switch",
            "account_suspend",
            "account_logout",
            "account_forget",
            "account_set_remark",
            "account_agent_status",
            "account_set_agent_status",
            "im_conversation_snapshot",
            "im_locate_conversation",
            "im_conversations",
            "im_messages",
            "im_unknown_outbound",
            "im_outbound_lookup",
            "im_message_page",
            "im_send_text",
            "im_mark_read",
            "im_set_top",
            "im_set_mark",
            "im_customer_scripts",
            "im_members",
            "im_invite_candidates",
            "im_invite",
            "im_transfer",
            "im_finish",
            "notice_categories",
            "notice_list",
            "notice_mark_read",
            "order_validate_im_url",
            "order_search",
            "order_create_im_chat",
            "shell_window",
            "shell_open_window",
            "shell_open_external",
            "shell_open_webview",
            "media_screenshot",
            "media_pick",
            "net_status",
            "prefs_snapshot",
            "prefs_set",
            "notify_snapshot",
            "notify_set_enabled",
            "notify_set_threshold",
            "notify_set_sound_enabled",
            "assistant_tsim_status",
            "assistant_translate",
            "assistant_package_quick_view",
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
            "prefs_set",
            "account_snapshot",
            "notify_set_enabled",
            "notify_set_threshold",
            "notify_set_sound_enabled",
            "net_status",
            "shell_window",
            "shell_open_window",
            "shell_open_external",
            "assistant_tsim_status",
            "assistant_tsim_login",
            "assistant_tsim_logout",
        ];
        const UPDATE_CMDS: &[&str] = &["prefs_snapshot", "shell_window"];
        const LOGIN_CMDS: &[&str] = &[
            "account_snapshot",
            "account_start_login",
            "account_cancel_login",
            "prefs_snapshot",
            "shell_window",
        ];
        const ADAPTER_CMDS: &[&str] = &[
            "adapter_ready",
            "adapter_identity",
            "adapter_push_fact",
            "adapter_push_display",
            "adapter_reply",
        ];
        let list = match self {
            Role::MainShell => MAIN_CMDS,
            Role::AlarmPopup => ALARM_CMDS,
            Role::Setting => SETTING_CMDS,
            Role::Update => UPDATE_CMDS,
            Role::LoginShell => LOGIN_CMDS,
            Role::Adapter => ADAPTER_CMDS,
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
        r.register("acct-p1");
        assert!(r.authorize("acct-p1", "adapter_push_fact").is_ok());
        assert!(r.authorize("acct-p1", "account_logout").is_err());
        assert!(r.authorize("acct-unregistered", "adapter_ready").is_err());
        assert!(
            r.authorize(MAIN, "prefs_snapshot").is_err(),
            "unregistered main"
        );
    }

    #[test]
    fn unknown_outbound_metadata_is_available_only_to_registered_main() {
        for command in ["im_unknown_outbound", "im_outbound_lookup"] {
            let mut registry = ViewRegistry::default();
            assert!(registry.authorize(MAIN, command).is_err());
            registry.register(MAIN);
            assert!(registry.authorize(MAIN, command).is_ok());
            for label in [ALARM, SETTING, UPDATE, LOGIN, "acct-synthetic", "webview-1"] {
                registry.register(label);
                assert!(registry.authorize(label, command).is_err());
            }
        }
    }

    #[test]
    fn re_register_bumps_generation() {
        let mut r = ViewRegistry::default();
        let a = r.register(MAIN);
        let b = r.register(MAIN);
        assert_eq!(a.view_generation + 1, b.view_generation);
    }
}

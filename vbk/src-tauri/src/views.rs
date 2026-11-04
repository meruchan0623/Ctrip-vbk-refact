//! View registry: the host-side source of truth for which webview label may
//! issue which command and under which `view_generation` (archive §4.0,
//! §5). Capability files are the static ACL; this is the runtime
//! defense-in-depth that also rejects a reused label after a rebuild.

use std::collections::{HashMap, HashSet};

use contracts::{codes, AppError, ViewContext};

/// Local window labels. Remote webviews (official login page, order detail,
/// the "IM 联系" tab) are never registered here and therefore never pass
/// `authorize`.
pub const MAIN: &str = "main";
pub const ALARM: &str = "alarm";
pub const NOTICE: &str = "notice";
pub const SETTING: &str = "setting";
pub const UPDATE: &str = "update";
pub const LOGIN: &str = "login";
pub const PACKAGE_DETAIL_PREFIX: &str = "package-detail-";
pub const MEDIA_VIEWER: &str = "media-viewer";
/// Prefix of per-account official-page webviews running the web-adapter
/// boot script. Each one is registered under its full label when created.
pub const ACCOUNT_WEBVIEW_PREFIX: &str = "acct-";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Role {
    MainShell,
    AlarmPopup,
    /// New-message notice stack: opens the noticed conversation, sizes itself.
    NoticePopup,
    Setting,
    Update,
    LoginShell,
    PackageDetail,
    /// Attachment viewer: reads and externally opens only its host-bound attachment.
    MediaViewer,
    /// Remote official IM page of one account (`acct-*`). Only the narrow
    /// `adapter_*` commands; never account, prefs or shell commands.
    Adapter,
}

impl Role {
    pub fn for_label(label: &str) -> Option<Role> {
        match label {
            MAIN => Some(Role::MainShell),
            ALARM => Some(Role::AlarmPopup),
            NOTICE => Some(Role::NoticePopup),
            SETTING => Some(Role::Setting),
            UPDATE => Some(Role::Update),
            LOGIN => Some(Role::LoginShell),
            MEDIA_VIEWER => Some(Role::MediaViewer),
            l if l
                .strip_prefix(PACKAGE_DETAIL_PREFIX)
                .is_some_and(|suffix| uuid::Uuid::parse_str(suffix).is_ok()) =>
            {
                Some(Role::PackageDetail)
            }
            l if l.starts_with(ACCOUNT_WEBVIEW_PREFIX) => Some(Role::Adapter),
            _ => None,
        }
    }

    /// Commands a role may invoke. Mirrors `capabilities/*.json`.
    pub fn allows(&self, command: &str) -> bool {
        const MAIN_CMDS: &[&str] = &[
            "shell_read_clipboard_text",
            "shell_write_clipboard_text",
            "webview_recovery_status",
            "webview_recovery_retry",
            "contract_hello",
            "im_send_input_state",
            "im_recall_message",
            "im_queue_status",
            "im_queue_drop_out",
            "im_draft_load",
            "im_draft_save",
            "im_draft_attachment_save",
            "im_draft_attachment_restore",
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
            "deep_link_take",
            "im_conversations",
            "im_messages",
            "im_unknown_outbound",
            "im_outbound_lookup",
            "im_message_page",
            "im_translate_messages",
            "im_server_search",
            "im_search_history",
            "im_send_text",
            "im_copy_message_image",
            "im_save_message_image",
            "im_forward_message",
            "im_saved_emojis",
            "im_add_saved_emoji",
            "im_update_saved_emoji",
            "im_send_saved_emoji",
            "im_send_media",
            "im_mark_read",
            "im_set_top",
            "im_set_mark",
            "im_customer_scripts",
            "im_quick_reply_categories",
            "im_recommend_products",
            "im_recommend_cities",
            "im_send_product_card",
            "im_members",
            "im_invite_candidates",
            "im_invite",
            "im_transfer",
            "im_finish",
            "im_remove",
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
            "browser_show",
            "browser_nav",
            "browser_close",
            "media_screenshot",
            "media_save_attachment",
            "media_annotation_source",
            "media_annotation_apply",
            "media_pick",
            "media_accept_drop",
            "media_release",
            "net_status",
            "prefs_snapshot",
            "prefs_set",
            "notify_snapshot",
            "notify_set_enabled",
            "notify_set_viewing",
            "notify_set_threshold",
            "notify_set_sound_enabled",
            "assistant_tsim_status",
            "assistant_translate",
            "assistant_package_quick_view",
            "assistant_order_summary",
            "assistant_package_detail_open",
            "assistant_tsim_order_open",
            "media_viewer_open_message",
            "media_viewer_open_emoji",
        ];
        const ALARM_CMDS: &[&str] = &[
            "contract_hello",
            "notify_snapshot",
            "notify_open_conversation",
            "notify_hide_round",
            "notify_hide_all",
            "notify_alarm_resize",
            "prefs_snapshot",
        ];
        const NOTICE_CMDS: &[&str] = &[
            "contract_hello",
            "notice_open",
            "notice_open_category",
            "notice_resize",
        ];
        const SETTING_CMDS: &[&str] = &[
            "shell_read_clipboard_text",
            "shell_write_clipboard_text",
            "webview_recovery_status",
            "webview_recovery_retry",
            "contract_hello",
            "deep_link_setting_take",
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
            "shell_open_webview",
            "shell_export_diagnostics",
            "shell_open_data_directory",
            "assistant_tsim_status",
            "assistant_tsim_login",
            "assistant_tsim_logout",
            "assistant_tsim_import_session",
            "assistant_tsim_browser_profiles",
            "assistant_tsim_browser_connect",
        ];
        const DETAIL_CMDS: &[&str] = &[
            "shell_read_clipboard_text",
            "shell_write_clipboard_text",
            "contract_hello",
            "assistant_package_detail",
            "assistant_tsim_status",
            "shell_window",
        ];
        const MEDIA_VIEWER_CMDS: &[&str] = &[
            "shell_write_clipboard_text",
            "contract_hello",
            "shell_window",
            "media_viewer_current",
            "media_viewer_open_external",
            "media_save_image",
        ];
        const UPDATE_CMDS: &[&str] = &["contract_hello", "prefs_snapshot", "shell_window"];
        const LOGIN_CMDS: &[&str] = &[
            "shell_read_clipboard_text",
            "shell_write_clipboard_text",
            "contract_hello",
            "account_snapshot",
            "account_start_login",
            "account_browser_profiles",
            "account_browser_connect",
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
            Role::NoticePopup => NOTICE_CMDS,
            Role::Setting => SETTING_CMDS,
            Role::Update => UPDATE_CMDS,
            Role::LoginShell => LOGIN_CMDS,
            Role::PackageDetail => DETAIL_CMDS,
            Role::MediaViewer => MEDIA_VIEWER_CMDS,
            Role::Adapter => ADAPTER_CMDS,
        };
        list.contains(&command)
    }
}

#[derive(Debug, Default)]
pub struct ViewRegistry {
    generations: HashMap<String, u64>,
    revoked: HashSet<String>,
}

impl ViewRegistry {
    /// Registers (or re-registers) a label; every call bumps the generation,
    /// so a webview rebuilt under the same label gets a new context.
    pub fn register(&mut self, label: &str) -> ViewContext {
        self.revoked.remove(label);
        let g = self.generations.entry(label.to_string()).or_insert(0);
        *g += 1;
        ViewContext::new(label, *g)
    }

    pub fn unregister(&mut self, label: &str) {
        self.revoked.insert(label.to_string());
    }

    pub fn unregister_if_current(&mut self, view: &ViewContext) -> bool {
        if self.current(&view.webview_label).as_ref() != Some(view) {
            return false;
        }
        self.unregister(&view.webview_label);
        true
    }

    pub fn current(&self, label: &str) -> Option<ViewContext> {
        if self.revoked.contains(label) {
            return None;
        }
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
    fn server_search_and_history_are_main_only_read_capabilities() {
        for command in ["im_server_search", "im_search_history"] {
            let mut registry = ViewRegistry::default();
            registry.register(MAIN);
            assert!(registry.authorize(MAIN, command).is_ok());
            for label in [ALARM, SETTING, UPDATE, LOGIN, "acct-synthetic", "webview-1"] {
                registry.register(label);
                assert!(registry.authorize(label, command).is_err());
            }
            registry.unregister(MAIN);
            assert!(registry.authorize(MAIN, command).is_err());
        }
    }

    #[test]
    fn quick_reply_and_product_card_commands_are_registered_main_only() {
        let commands = [
            "im_quick_reply_categories",
            "im_recommend_products",
            "im_recommend_cities",
            "im_send_product_card",
        ];
        let main_acl: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/main.json")).unwrap();
        let detail = format!("{PACKAGE_DETAIL_PREFIX}{}", uuid::Uuid::new_v4());
        for command in commands {
            let mut registry = ViewRegistry::default();
            assert!(registry.authorize(MAIN, command).is_err());
            registry.register(MAIN);
            assert!(registry.authorize(MAIN, command).is_ok());
            assert!(include_str!("../commands.txt")
                .lines()
                .any(|line| line == command));
            let permission = format!("allow-{}", command.replace('_', "-"));
            assert!(main_acl["permissions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|p| p.as_str() == Some(&permission)));
            for label in [
                ALARM,
                SETTING,
                UPDATE,
                LOGIN,
                "acct-synthetic",
                detail.as_str(),
                "webview-1",
            ] {
                registry.register(label);
                assert!(
                    registry.authorize(label, command).is_err(),
                    "{label}: {command}"
                );
            }
            registry.unregister(MAIN);
            assert!(registry.authorize(MAIN, command).is_err());
        }
    }

    #[test]
    fn existing_tsim_session_import_is_granted_only_to_registered_settings() {
        let mut registry = ViewRegistry::default();
        registry.register(SETTING);
        assert!(registry
            .authorize(SETTING, "assistant_tsim_import_session")
            .is_ok());
        let detail = format!("{PACKAGE_DETAIL_PREFIX}{}", uuid::Uuid::new_v4());
        for label in [
            MAIN,
            ALARM,
            UPDATE,
            LOGIN,
            "acct-synthetic",
            detail.as_str(),
        ] {
            registry.register(label);
            assert!(
                registry
                    .authorize(label, "assistant_tsim_import_session")
                    .is_err(),
                "{label}"
            );
        }
        registry.unregister(SETTING);
        assert!(registry
            .authorize(SETTING, "assistant_tsim_import_session")
            .is_err());
    }

    #[test]
    fn webview_tabs_open_only_from_main_and_settings() {
        let mut registry = ViewRegistry::default();
        for label in [MAIN, SETTING, ALARM, UPDATE] {
            registry.register(label);
        }
        assert!(registry.authorize(MAIN, "shell_open_webview").is_ok());
        assert!(registry.authorize(SETTING, "shell_open_webview").is_ok());
        assert!(registry.authorize(ALARM, "shell_open_webview").is_err());
        assert!(registry.authorize(UPDATE, "shell_open_webview").is_err());
    }

    #[test]
    fn recovery_commands_are_local_control_views_only() {
        let mut registry = ViewRegistry::default();
        for label in [
            MAIN,
            SETTING,
            ALARM,
            UPDATE,
            LOGIN,
            "acct-synthetic",
            "webview-1",
        ] {
            registry.register(label);
            for command in ["webview_recovery_status", "webview_recovery_retry"] {
                assert_eq!(
                    registry.authorize(label, command).is_ok(),
                    matches!(label, MAIN | SETTING),
                    "{label}: {command}"
                );
            }
        }
        registry.unregister(MAIN);
        assert!(registry.authorize(MAIN, "webview_recovery_retry").is_err());
    }

    #[test]
    fn diagnostic_commands_are_settings_only() {
        for command in ["shell_export_diagnostics", "shell_open_data_directory"] {
            let mut registry = ViewRegistry::default();
            registry.register(SETTING);
            assert!(registry.authorize(SETTING, command).is_ok());
            let detail = format!("{PACKAGE_DETAIL_PREFIX}{}", uuid::Uuid::new_v4());
            for label in [
                MAIN,
                ALARM,
                UPDATE,
                LOGIN,
                "acct-synthetic",
                detail.as_str(),
                "webview-1",
            ] {
                registry.register(label);
                assert!(
                    registry.authorize(label, command).is_err(),
                    "{label}: {command}"
                );
            }
            registry.unregister(SETTING);
            assert!(registry.authorize(SETTING, command).is_err());
        }
    }

    #[test]
    fn browser_session_commands_are_settings_only() {
        for command in [
            "assistant_tsim_browser_profiles",
            "assistant_tsim_browser_connect",
        ] {
            let mut registry = ViewRegistry::default();
            registry.register(SETTING);
            assert!(registry.authorize(SETTING, command).is_ok());
            for label in [MAIN, ALARM, UPDATE, LOGIN, "acct-synthetic"] {
                registry.register(label);
                assert!(registry.authorize(label, command).is_err());
            }
            registry.unregister(SETTING);
            assert!(registry.authorize(SETTING, command).is_err());
        }
    }

    #[test]
    fn package_detail_role_is_read_only_and_destroyed_labels_cannot_reuse_old_generation() {
        let label = format!("{PACKAGE_DETAIL_PREFIX}{}", uuid::Uuid::new_v4());
        let mut registry = ViewRegistry::default();
        let first = registry.register(&label);
        assert!(registry
            .authorize(&label, "assistant_package_detail")
            .is_ok());
        assert!(registry.authorize(&label, "shell_window").is_ok());
        for command in [
            "assistant_order_summary",
            "assistant_tsim_login",
            "assistant_tsim_logout",
            "assistant_translate",
            "im_send_text",
            "prefs_set",
            "shell_open_external",
        ] {
            assert!(registry.authorize(&label, command).is_err(), "{command}");
        }
        registry.unregister(&label);
        assert!(registry.current(&label).is_none());
        assert!(registry
            .authorize(&label, "assistant_package_detail")
            .is_err());
        let replacement = registry.register(&label);
        assert_ne!(first, replacement);
        assert!(replacement.view_generation > first.view_generation);
        assert!(
            !registry.unregister_if_current(&first),
            "an old Destroyed callback cannot revoke its replacement"
        );
        assert_eq!(registry.current(&label).as_ref(), Some(&replacement));
        assert!(registry.unregister_if_current(&replacement));
        registry.register("acct-synthetic");
        assert!(registry
            .authorize("acct-synthetic", "assistant_package_detail")
            .is_err());
    }

    #[test]
    fn media_viewer_only_reads_its_bound_attachment() {
        let mut registry = ViewRegistry::default();
        registry.register(MEDIA_VIEWER);
        registry.register(MAIN);
        for command in [
            "media_viewer_current",
            "media_viewer_open_external",
            "media_save_image",
            "shell_window",
        ] {
            assert!(
                registry.authorize(MEDIA_VIEWER, command).is_ok(),
                "{command}"
            );
        }
        for command in [
            "media_viewer_open_message",
            "media_viewer_open_emoji",
            "media_save_attachment",
            "shell_open_external",
            "shell_open_webview",
            "im_send_text",
            "im_messages",
            "prefs_set",
        ] {
            assert!(
                registry.authorize(MEDIA_VIEWER, command).is_err(),
                "{command}"
            );
        }
        assert!(registry
            .authorize(MAIN, "media_viewer_open_message")
            .is_ok());
        assert!(registry.authorize(MAIN, "media_viewer_current").is_err());
        assert!(registry.authorize(MAIN, "media_save_image").is_err());
        assert!(registry.authorize(MAIN, "media_save_attachment").is_ok());
        assert!(registry
            .authorize(MAIN, "media_viewer_open_external")
            .is_err());
    }

    #[test]
    fn notice_can_only_open_and_size_itself() {
        let mut r = ViewRegistry::default();
        r.register(NOTICE);
        assert!(r.authorize(NOTICE, "notice_open").is_ok());
        assert!(r.authorize(NOTICE, "notice_resize").is_ok());
        for command in [
            "im_push_fact",
            "account_logout",
            "notify_snapshot",
            "prefs_set",
        ] {
            assert!(r.authorize(NOTICE, command).is_err());
        }
        r.register(MAIN);
        assert!(r.authorize(MAIN, "notice_open").is_err());
    }

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

    #[test]
    fn ctrip_browser_import_is_only_available_in_registered_login_header() {
        for command in ["account_browser_profiles", "account_browser_connect"] {
            let mut registry = ViewRegistry::default();
            assert!(registry.authorize(LOGIN, command).is_err());
            registry.register(LOGIN);
            assert!(registry.authorize(LOGIN, command).is_ok());
            for label in [
                MAIN,
                ALARM,
                SETTING,
                UPDATE,
                "acct-synthetic",
                "login-remote-synthetic",
                "webview-1",
            ] {
                registry.register(label);
                assert!(registry.authorize(label, command).is_err());
            }
        }
    }
}

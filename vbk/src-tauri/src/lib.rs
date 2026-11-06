//! Tauri 2 host for the VBooking web-IM client.
//!
//! Startup order (archive §4.5): single-instance → logging → store → cores
//! (net → account → shell → notify) → windows → tray → scheduler. The IM
//! transport itself runs inside the official page's webview and reaches the
//! cores only through `im_push_fact`.
//!
//! This package is compiled on the Windows or macOS target machine; it is
//! excluded from the std-only workspace that the cloud checks build.
//! Platform differences live behind `cfg(target_os = "macos")` in `tray.rs`
//! and `scheduler.rs`, plus the Dock reopen handler below; macOS bundling
//! settings are in `tauri.macos.conf.json`.

pub mod adapter;
pub mod assistant;
mod attachment_leases;
mod attention;
mod browser_bridge;
pub mod browser_tabs;
mod chrome_cookie_store;
pub mod clock_anchor;
pub mod commands;
mod crash_recovery;
pub mod data_guard;
pub mod deep_link_runtime;
pub mod diag_bridge;
mod diagnostics;
pub mod dto;
mod durable_store;
pub mod events;
pub mod features;
pub mod local_tz;
pub mod login;
mod media_copy;
pub mod media_outbound;
mod media_save;
pub mod media_viewer;
pub mod message_media;
mod net_policy;
mod notice_watch;
pub mod notifications;
pub mod peripheral_journal;
pub mod prefs;
pub mod scheduler;
pub mod shell;
pub mod startup_args;
pub mod state;
pub mod system_integration;
pub mod tray;
mod ui_zoom;
pub mod views;
mod webview_recovery;
#[cfg(target_os = "windows")]
mod win_chrome;
pub mod windows;

use std::time::{SystemTime, UNIX_EPOCH};

use tauri::Manager;

use state::HostState;

struct StorageStartupFailed;

/// Keep the event loop alive only long enough to show an actionable failure.
/// No account/adapter/scheduler state is installed on this early setup path.
fn storage_startup_failed(app: &tauri::AppHandle) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
    app.manage(StorageStartupFailed);
    let exit = app.clone();
    app.dialog()
        .message("无法安全打开本地数据存储，客户端未启动。请检查磁盘空间和应用数据目录的访问权限，然后重新打开。已有数据不会被自动清除。")
        .title("旅游商家IM 启动失败")
        .kind(MessageDialogKind::Error)
        .show(move |_| exit.exit(1));
}

/// Builds and runs the application.
pub fn run() {
    if !startup_args::allows(
        std::env::args_os()
            .skip(1)
            .map(|arg| arg.to_string_lossy().into_owned()),
    ) {
        return;
    }
    let boot_epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(1);

    // Upstream Apple termination hook (label-resolved; see webview_recovery).
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.on_web_content_process_terminate(webview_recovery::on_terminated);

    builder
        // Reject secondary ordinary hosts before initializing other plugins.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if app.try_state::<StorageStartupFailed>().is_none() {
                deep_link_runtime::on_second_instance(app, args);
            }
        }))
        .on_menu_event(media_copy::on_menu_event)
        .plugin(webview_recovery::plugin())
        .plugin(deep_link_runtime::plugin())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // Contract handshake lifetime (I-03): a destroyed window's label may
        // be reused, and a reloaded/navigated local window is a new page;
        // both must announce their contract version afresh.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                commands::contract_forget(window.label());
                media_viewer::on_window_destroyed(window.label());
            }
        })
        .on_page_load(|webview, payload| {
            ui_zoom::on_page_load(webview);
            if payload.event() != tauri::webview::PageLoadEvent::Started {
                return;
            }
            // Only a local window's own document: a remote `acct-*` adapter
            // webview takes no handshake, and a child webview navigating must
            // not reset its host window's verdict.
            let label = webview.label();
            if label.starts_with(views::ACCOUNT_WEBVIEW_PREFIX) {
                login::adapter_page_started(webview.app_handle(), label);
            }
            let local = !matches!(
                views::Role::for_label(label),
                None | Some(views::Role::Adapter)
            );
            if local && webview.window().label() == label {
                commands::contract_forget(label);
            }
        })
        .setup(move |app| {
            let data_dir = app.path().app_data_dir()?;
            diag_bridge::install(data_dir.join("logs"));
            let previous_panic = match crash_recovery::install(&data_dir) {
                Ok(status) => status.previous_panic,
                Err(_) => {
                    log::warn!("crash marker unavailable");
                    false
                }
            };
            let store = match durable_store::open(data_dir.join("state")) {
                Ok(bound) => bound.store,
                Err(e) => {
                    log::error!("store unavailable: {e}; startup blocked");
                    storage_startup_failed(app.handle());
                    return Ok(());
                }
            };
            let state = HostState::new(Some(store), boot_epoch);
            if !state.persistence_available() {
                log::error!("persistence worker unavailable; startup blocked");
                storage_startup_failed(app.handle());
                return Ok(());
            }
            {
                let mut cores = state.lock();
                for label in [
                    views::MAIN,
                    views::ALARM,
                    views::NOTICE,
                    views::SETTING,
                    views::UPDATE,
                    views::LOGIN,
                    views::MEDIA_VIEWER,
                ] {
                    cores.views.register(label);
                }
            }
            app.manage(state);
            app.manage(clock_anchor::ClockAnchors::default());
            app.manage(notifications::RecentNotices::default());

            let handle = app.handle().clone();
            // Main window: close → hide to tray (docs/dev/01-shell.md).
            if let Some(main) = app.get_webview_window(views::MAIN) {
                windows::disable_browser_accelerators(&main);
                let h = main.clone();
                main.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = h.hide();
                    }
                    if let tauri::WindowEvent::DragDrop(drop) = event {
                        shell::on_main_drag_drop(h.app_handle(), drop);
                    }
                    if let tauri::WindowEvent::Focused(focused) = event {
                        let state = h.app_handle().state::<HostState>();
                        state.update_system_state(|sys| sys.main_window_focused = *focused);
                    }
                });
                let _ = main.show();
            }
            app.manage(browser_tabs::BrowserTabs::default());
            shell::init(&handle)?;
            prefs::init(&handle)?;
            system_integration::init(&handle);
            login::init(&handle)?;
            adapter::init(&handle)?;
            webview_recovery::ready(&handle);
            assistant::init(&handle)?;
            notice_watch::init(&handle);
            windows::ensure_alarm(&handle)?;
            windows::ensure_notice(&handle)?;
            tray::install(&handle)?;
            scheduler::start(handle);
            if previous_panic {
                use tauri_plugin_dialog::DialogExt;
                app.dialog()
                    .message("检测到上次运行出现异常。可在设置中导出诊断信息。未保存的编辑内容可能无法恢复。")
                    .title("运行异常提示")
                    .show(|_| {});
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::contract_hello,
            webview_recovery::webview_recovery_status,
            webview_recovery::webview_recovery_retry,
            deep_link_runtime::deep_link_take,
            deep_link_runtime::deep_link_setting_take,
            features::typing::im_send_input_state,
            features::recall::im_recall_message,
            features::queue::im_queue_status,
            features::queue::im_queue_drop_out,
            features::draft::im_draft_load,
            features::draft::im_draft_save,
            features::draft::im_draft_attachment_save,
            features::draft::im_draft_attachment_restore,
            commands::notify_snapshot,
            commands::notify_open_conversation,
            commands::notify_hide_round,
            commands::notify_hide_all,
            commands::notify_alarm_resize,
            commands::notify_set_enabled,
            commands::notify_set_viewing,
            commands::notice_open,
            commands::notice_open_category,
            commands::notice_resize,
            commands::notify_set_threshold,
            commands::notify_set_sound_enabled,
            commands::im_push_fact,
            commands::im_conversation_snapshot,
            commands::im_locate_conversation,
            commands::order_validate_im_url,
            login::account_snapshot,
            login::account_start_login,
            login::account_browser_profiles,
            login::account_browser_connect,
            login::account_cancel_login,
            login::account_switch,
            login::account_suspend,
            login::account_logout,
            login::account_forget,
            login::account_set_remark,
            login::shell_open_webview,
            adapter::adapter_ready,
            adapter::adapter_identity,
            adapter::adapter_push_fact,
            adapter::adapter_push_display,
            adapter::adapter_reply,
            adapter::account_agent_status,
            adapter::account_set_agent_status,
            adapter::im_conversations,
            adapter::im_messages,
            adapter::im_unknown_outbound,
            adapter::im_outbound_lookup,
            adapter::im_message_page,
            adapter::im_translate_messages,
            adapter::im_send_text,
            message_media::shell_read_clipboard_text,
            message_media::shell_write_clipboard_text,
            message_media::im_copy_message_image,
            message_media::im_save_message_image,
            adapter::message_actions::im_forward_message,
            adapter::message_actions::im_saved_emojis,
            adapter::message_actions::im_add_saved_emoji,
            adapter::message_actions::im_update_saved_emoji,
            adapter::message_actions::im_send_saved_emoji,
            adapter::im_send_media,
            adapter::im_mark_read,
            adapter::im_set_top,
            adapter::im_set_mark,
            adapter::im_customer_scripts,
            adapter::im_quick_reply_categories,
            adapter::im_quick_reply_manage_info,
            adapter::im_quick_reply_edit,
            adapter::im_recommend_products,
            adapter::im_recommend_cities,
            adapter::im_send_product_card,
            adapter::im_members,
            adapter::im_invite_candidates,
            adapter::im_invite,
            adapter::im_transfer,
            adapter::im_finish,
            adapter::im_remove,
            adapter::notice_categories,
            adapter::notice_list,
            adapter::notice_mark_read,
            adapter::merchant_event_types,
            adapter::merchant_event_list,
            adapter::order_search,
            adapter::order_create_im_chat,
            adapter::net_status,
            shell::shell_window,
            shell::shell_open_window,
            shell::shell_open_external,
            shell::shell_export_diagnostics,
            shell::shell_open_data_directory,
            browser_tabs::browser_show,
            browser_tabs::browser_nav,
            browser_tabs::browser_close,
            media_copy::media_viewer_context_menu,
            media_save::media_save_image,
            shell::media_pick,
            shell::media_accept_drop,
            shell::media_release,
            prefs::prefs_snapshot,
            prefs::prefs_set,
            assistant::assistant_tsim_status,
            assistant::assistant_tsim_login,
            assistant::assistant_tsim_logout,
            assistant::assistant_translate,
            assistant::assistant_package_quick_view,
            assistant::order_commands::assistant_order_summary,
            assistant::order_commands::assistant_package_detail_open,
            assistant::order_commands::assistant_package_detail,
            assistant::tsim_order::assistant_tsim_order_open,
            assistant::tsim_order::assistant_tsim_iccid_open,
            media_viewer::media_viewer_open_message,
            media_viewer::media_viewer_open_emoji,
            media_viewer::media_viewer_current,
            media_viewer::media_viewer_open_external,
        ])
        .build(tauri::generate_context!())
        .expect("error while building the VBooking host")
        .run(|app, event| {
            // Every exit path (tray quit, close-quits, OS shutdown, app.exit
            // from anywhere) drains the persist queue; after `request_quit`
            // this second flush finds nothing outstanding.
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<HostState>() {
                    if !state.flush_persist(std::time::Duration::from_secs(5)) {
                        log::warn!("exit: persistence did not fully flush within 5 s");
                    }
                }
                log::logger().flush();
            }
            // macOS: closing main only hides it (tray behaviour), so a click
            // on the Dock icon must bring it back.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                if app.try_state::<HostState>().is_some() {
                    windows::show_main(app);
                }
            }
        });
}

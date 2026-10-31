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
pub mod peripheral_journal;
pub mod assistant;
pub mod commands;
pub mod dto;
pub mod events;
pub mod login;
pub mod prefs;
pub mod scheduler;
pub mod shell;
pub mod state;
pub mod tray;
pub mod views;
pub mod windows;

use std::time::{SystemTime, UNIX_EPOCH};

use core_store::FileStore;
use tauri::Manager;

use state::HostState;

/// Builds and runs the application.
pub fn run() {
    let boot_epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(1);

    tauri::Builder::default()
        // Second instance: forward args (deep links are a later SHL-04
        // task) and bring the main window up.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            windows::show_main(app);
        }))
        .setup(move |app| {
            let data_dir = app.path().app_data_dir()?;
            let store = match FileStore::open(data_dir.join("state")) {
                Ok(s) => Some(s),
                Err(e) => {
                    log::error!("store unavailable: {e}; running without persistence");
                    None
                }
            };
            let state = HostState::new(store, boot_epoch);
            {
                let mut cores = state.lock();
                for label in [
                    views::MAIN,
                    views::ALARM,
                    views::SETTING,
                    views::UPDATE,
                    views::LOGIN,
                ] {
                    cores.views.register(label);
                }
            }
            app.manage(state);

            let handle = app.handle().clone();
            // Main window: close → hide to tray (docs/dev/01-shell.md).
            if let Some(main) = app.get_webview_window(views::MAIN) {
                let h = main.clone();
                main.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = h.hide();
                    }
                    if let tauri::WindowEvent::Focused(focused) = event {
                        let app = h.app_handle();
                        let state = app.state::<HostState>();
                        let mut sys = state.lock().notify.system_state().clone();
                        sys.main_window_focused = *focused;
                        state.set_system_state(sys);
                    }
                });
                let _ = main.show();
            }
            shell::init(&handle)?;
            prefs::init(&handle)?;
            login::init(&handle)?;
            adapter::init(&handle)?;
            assistant::init(&handle)?;
            windows::ensure_alarm(&handle)?;
            tray::install(&handle)?;
            scheduler::start(handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::notify_snapshot,
            commands::notify_open_conversation,
            commands::notify_hide_round,
            commands::notify_hide_all,
            commands::notify_snooze,
            commands::notify_set_enabled,
            commands::notify_set_threshold,
            commands::notify_set_sound_enabled,
            commands::im_push_fact,
            commands::im_conversation_snapshot,
            commands::im_locate_conversation,
            commands::order_validate_im_url,
            login::account_snapshot,
            login::account_start_login,
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
            adapter::im_send_text,
            adapter::im_mark_read,
            adapter::im_set_top,
            adapter::im_set_mark,
            adapter::im_customer_scripts,
            adapter::im_members,
            adapter::im_invite_candidates,
            adapter::im_invite,
            adapter::im_transfer,
            adapter::im_finish,
            adapter::notice_categories,
            adapter::notice_list,
            adapter::notice_mark_read,
            adapter::order_search,
            adapter::order_create_im_chat,
            adapter::net_status,
            shell::shell_window,
            shell::shell_open_window,
            shell::shell_open_external,
            shell::media_screenshot,
            shell::media_pick,
            prefs::prefs_snapshot,
            prefs::prefs_set,
            assistant::assistant_tsim_status,
            assistant::assistant_tsim_login,
            assistant::assistant_tsim_logout,
            assistant::assistant_translate,
            assistant::assistant_package_quick_view,
        ])
        .build(tauri::generate_context!())
        .expect("error while building the VBooking host")
        .run(|app, event| {
            // macOS: closing main only hides it (tray behaviour), so a click
            // on the Dock icon must bring it back.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                windows::show_main(app);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}

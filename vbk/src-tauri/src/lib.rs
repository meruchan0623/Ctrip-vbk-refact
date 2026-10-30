//! Tauri 2 host for the VBooking web-IM client.
//!
//! Startup order (archive §4.5): single-instance → logging → store → cores
//! (net → account → shell → notify) → windows → tray → scheduler. The IM
//! transport itself runs inside the official page's webview and reaches the
//! cores only through `im_push_fact`.
//!
//! This package is compiled on the Windows target machine; it is excluded
//! from the std-only workspace that the cloud checks build.

pub mod commands;
pub mod dto;
pub mod scheduler;
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
            commands::account_snapshot,
            commands::account_start_login,
            commands::account_switch,
            commands::account_suspend,
            commands::account_logout,
            commands::account_forget,
            commands::im_push_fact,
            commands::im_conversation_snapshot,
            commands::im_locate_conversation,
            commands::order_validate_im_url,
            commands::prefs_snapshot,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the VBooking host");
}

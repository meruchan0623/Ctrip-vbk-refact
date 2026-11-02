//! System-integration glue: second-instance hand-over and deep links.
//!
//! STATUS: NOT COMPILED. The Tauri host cannot be built in the cloud check
//! environment (no crate registry / WebView2). All decisions live in the
//! std-only, tested `core_update::deeplink`; this file only forwards the
//! result. It is deliberately NOT declared in `lib.rs` yet; the integrator
//! wires it (see the manifest below) on a machine that can build the host.
//!
//! # Wiring manifest (for the integrator)
//!
//! `Cargo.toml` (host):
//! * `core-update = { path = "../crates/core-update" }`
//! * `tauri-plugin-deep-link = "2"`, `tauri-plugin-updater = "2"`
//!   (`tauri-plugin-autostart` and `-global-shortcut` are already listed)
//!
//! `lib.rs`:
//! * `pub mod integration;`
//! * replace the single-instance closure body with
//!   `|app, args, _cwd| integration::on_second_instance(app, args)`
//! * `.plugin(tauri_plugin_deep_link::init())`; in `setup`, call
//!   `integration::register_deep_link(app.handle())`
//! * `.plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))`;
//!   in `setup`, call `integration::sync_autostart(app.handle())` once and
//!   again from `prefs_set` after `general.autostart` changes
//!
//! `tauri.conf.json`: `plugins.deep-link.desktop.schemes = ["vbkdesk"]` only.
//! Never add `vbookingChat` (the official client's scheme).
//!
//! `capabilities/`: no capability is granted to remote webviews for any of
//! these plugins; the only entry points are Rust-side (this file).
//!
//! Rules kept here: deep links are navigation requests only; nothing is
//! written to `prefs.json` or any other persistent configuration.

use core_update::deeplink::{self, DeepLinkAction};
use serde_json::json;
use tauri::AppHandle;

use crate::{events, windows};

/// Event consumed by the main window (UI listener is a follow-up).
pub const DEEPLINK_EVENT: &str = "deeplink://action";

/// Second launch: always bring the main window up, then act on at most one
/// valid deep link found in the arguments.
pub fn on_second_instance(app: &AppHandle, args: Vec<String>) {
    let plan = deeplink::plan_second_instance(&args);
    if plan.focus_main {
        windows::show_main(app);
    }
    if let Some(action) = plan.action {
        dispatch(app, &action);
    }
}

/// Deep link delivered while the app is running (macOS `open-url`, or the
/// deep-link plugin's `on_open_url`).
pub fn on_open_url(app: &AppHandle, url: &str) {
    match deeplink::parse(url) {
        Ok(action) => {
            windows::show_main(app);
            dispatch(app, &action);
        }
        // Never log the URL itself: it is untrusted input.
        Err(e) => log::warn!("deep link rejected: {e:?}"),
    }
}

fn dispatch(app: &AppHandle, action: &DeepLinkAction) {
    match action {
        DeepLinkAction::FocusMain => {}
        DeepLinkAction::OpenConversation { session_id } => {
            events::to_main(
                app,
                DEEPLINK_EVENT,
                json!({ "action": "conversation", "session_id": session_id }),
            );
        }
        DeepLinkAction::OpenSettings { section } => {
            events::to_main(
                app,
                DEEPLINK_EVENT,
                json!({ "action": "settings", "section": section }),
            );
        }
    }
}

/// Register the own scheme at runtime where the platform allows it (dev /
/// Linux / Windows portable); installed builds get it from the bundle config.
///
/// `tauri-plugin-deep-link` API (v2): `app.deep_link().on_open_url(..)`.
pub fn register_deep_link(app: &AppHandle) {
    use tauri_plugin_deep_link::DeepLinkExt;
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            on_open_url(&handle, url.as_str());
        }
    });
}

/// Make the OS login-item state equal `prefs.general.autostart` (default
/// false). Called at startup and after the preference changes, so the stored
/// value is never "stored only".
pub fn sync_autostart(app: &AppHandle) {
    use tauri_plugin_autostart::ManagerExt;
    let want = crate::prefs::snapshot(app).local.general.autostart;
    let manager = app.autolaunch();
    let have = manager.is_enabled().unwrap_or(false);
    if want == have {
        return;
    }
    let res = if want {
        manager.enable()
    } else {
        manager.disable()
    };
    if let Err(e) = res {
        log::warn!("autostart sync failed: {e}");
    }
}

//! 1 Hz scheduler thread (strong-alert §5: Rust keeps the deadline queue
//! and refreshes numbers at 1 Hz only while something is shown). Executes
//! `core-notify` effects against the host: alarm window show/hide, sounds,
//! tray flashing, taskbar badge and the alarm snapshot event.
//!
//! Sleep is not assumed to keep ticking: on wake the wall/monotonic drift
//! is seen by `ClockService`, which turns the reading `Stale`, which the
//! cores treat as "reconcile first".

use std::thread;
use std::time::Duration;

use core_notify::{Effect, Sound};
use tauri::{AppHandle, Emitter, Manager};

use crate::dto::AlarmSnapshotDto;
use crate::state::HostState;
use crate::tray;
use crate::views;
use crate::windows::{self, Corner};

pub const TICK: Duration = Duration::from_millis(1000);
pub const FLASH_PHASE: Duration = Duration::from_millis(500);
pub const ALARM_SNAPSHOT_EVENT: &str = "notify://alarm-snapshot";

pub fn start(app: AppHandle) {
    thread::Builder::new()
        .name("vbk-scheduler".into())
        .spawn(move || run(app))
        .expect("spawn scheduler thread");
}

fn run(app: AppHandle) {
    let mut flashing = false;
    let mut phase = false;
    loop {
        let state = app.state::<HostState>();
        if state.quit_requested() {
            return;
        }
        let effects = state.tick();
        let mut snapshot_changed = false;
        for effect in effects {
            match effect {
                Effect::ShowAlarm { raise } => {
                    let bottom_right = state.settings().position_bottom_right;
                    let corner = if bottom_right { Corner::BottomRight } else { Corner::BottomLeft };
                    if let Err(e) = windows::show_alarm(&app, corner, 320.0, raise) {
                        log::warn!("show alarm failed: {e}");
                    }
                    snapshot_changed = true;
                }
                Effect::UpdateAlarm => snapshot_changed = true,
                Effect::HideAlarm => {
                    windows::hide_alarm(&app);
                    snapshot_changed = true;
                }
                Effect::PlaySound(sound) => play_sound(&app, sound),
                Effect::StopSound => stop_sound(&app),
                Effect::TrayFlash(on) => {
                    flashing = on;
                    if !on {
                        tray::set_flash_phase(&app, true);
                    }
                }
                Effect::Unread { total, badge } => {
                    tray::set_unread_tooltip(&app, badge.text());
                    set_taskbar_badge(&app, badge.text(), total);
                }
                Effect::Banner { account, gid, count, stay_ms } => {
                    let _ = app.emit_to(
                        views::MAIN,
                        "notify://banner",
                        serde_json::json!({
                            "account": crate::dto::AccountContextDto::from(&account),
                            "gid": gid, "count": count, "stay_ms": stay_ms
                        }),
                    );
                }
                Effect::SystemToast { account, gid, count } => {
                    // System toast integration is REL/NTF-05; until then the
                    // main window shows a plain banner.
                    let _ = app.emit_to(
                        views::MAIN,
                        "notify://banner",
                        serde_json::json!({
                            "account": crate::dto::AccountContextDto::from(&account),
                            "gid": gid, "count": count, "stay_ms": 6000, "system": true
                        }),
                    );
                }
            }
        }
        if snapshot_changed {
            let snap = AlarmSnapshotDto::from(&state.alarm_snapshot());
            // Directed emit: only the alarm window (and never a remote
            // webview) receives customer-adjacent data.
            let _ = app.emit_to(views::ALARM, ALARM_SNAPSHOT_EVENT, snap);
        }
        if flashing {
            phase = !phase;
            tray::set_flash_phase(&app, phase);
            thread::sleep(FLASH_PHASE);
            phase = !phase;
            tray::set_flash_phase(&app, phase);
            thread::sleep(FLASH_PHASE);
        } else {
            thread::sleep(TICK);
        }
    }
}

fn play_sound(app: &AppHandle, sound: Sound) {
    // Audio output is a platform concern (MED/NTF-04). The main window
    // plays bundled clips on this event; nothing else is required for the
    // escalation semantics to be verifiable.
    let name = match sound {
        Sound::NewMessage => "new_message",
        Sound::Timeout => "timeout",
        Sound::Loop => "loop",
    };
    let _ = app.emit_to(views::MAIN, "notify://play-sound", name);
}

fn stop_sound(app: &AppHandle) {
    let _ = app.emit_to(views::MAIN, "notify://stop-sound", ());
}

fn set_taskbar_badge(app: &AppHandle, text: Option<&str>, total: u32) {
    if let Some(win) = app.get_webview_window(views::MAIN) {
        // Tauri 2 exposes overlay badges on Windows via `set_badge_count`
        // (2.3+); fall back to the title when unavailable.
        #[allow(unused_variables)]
        let count = if total == 0 { None } else { Some(i64::from(total.min(99))) };
        #[cfg(windows)]
        {
            let _ = win.set_badge_count(count);
        }
        let title = match text {
            Some(t) => format!("({t}) VBooking 商家客户端"),
            None => "VBooking 商家客户端".to_string(),
        };
        let _ = win.set_title(&title);
    }
}

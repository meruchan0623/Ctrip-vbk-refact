//! 1 Hz scheduler thread (strong-alert §5: Rust keeps the deadline queue
//! and refreshes numbers at 1 Hz only while something is shown). Executes
//! `core-notify` effects against the host: alarm window show/hide, sounds,
//! tray flashing, taskbar badge and the alarm snapshot event (to alarm and
//! main). Also emits `net://clock` to main every tick and mirrors reminder
//! settings changes into prefs.
//!
//! Sleep is not assumed to keep ticking: on wake the wall/monotonic drift
//! is seen by `ClockService`, which turns the reading `Stale`, which the
//! cores treat as "reconcile first".

use std::thread;
use std::time::{Duration, Instant};

use contracts::{ClockQuality, ClockReading};
use core_notify::{Effect, Pacer, Sound, BANNER_STAY_MS};
use tauri::{AppHandle, Emitter, Manager, UserAttentionType};

use crate::attention;
use crate::events;
use crate::prefs;
use crate::state::HostState;
use crate::tray;
use crate::views;
use crate::windows::{self, Corner};

pub const TICK: Duration = Duration::from_millis(1000);
pub const FLASH_PHASE: Duration = Duration::from_millis(500);
pub const ALARM_SNAPSHOT_EVENT: &str = events::ALARM_SNAPSHOT;
/// Ticks between OS environment reads (full-screen windows, focus state).
const OS_READ_EVERY_TICKS: u32 = 3;

pub fn start(app: AppHandle) {
    thread::Builder::new()
        .name("vbk-scheduler".into())
        .spawn(move || run(app))
        .expect("spawn scheduler thread");
}

fn run(app: AppHandle) {
    let mut flashing = false;
    let mut phase = false;
    // Edge detector for `persist_failed` (I-04a): the tick already drains
    // the persistence receipts; when the state flips the account snapshot
    // (which carries the flag) is re-emitted, so the main window shows and
    // clears "本地保存失败，发送已暂停" without any extra polling.
    let mut persist_failed = false;
    // Deadline pacer: tick stays 1 Hz and the tray phase flips every 500 ms
    // while flashing, without the old fixed-sleep drift (`Pacer` docs).
    let origin = Instant::now();
    let now_ms = move || i64::try_from(origin.elapsed().as_millis()).unwrap_or(i64::MAX);
    let mut pacer = Pacer::new(now_ms());
    let mut os_attention = attention::OsAttention::default();
    let mut ticks_since_os_read = OS_READ_EVERY_TICKS;
    loop {
        let state = app.state::<HostState>();
        if state.quit_requested() {
            return;
        }
        // The 500 ms tray phase is a Windows notification-area effect; macOS
        // keeps the plain 1 Hz tick (its L1 signal is the Dock attention).
        let fast = flashing && cfg!(not(target_os = "macos"));
        if !pacer.tick_due(fast) {
            // Half-step wake: only flip the tray icon, no core tick.
            phase = !phase;
            tray::set_flash_phase(&app, phase);
            thread::sleep(Duration::from_millis(pacer.sleep_ms(now_ms(), fast)));
            continue;
        }
        crate::adapter::expire_agent_statuses(&app);
        if ticks_since_os_read >= OS_READ_EVERY_TICKS {
            ticks_since_os_read = 0;
            os_attention = attention::read();
        }
        ticks_since_os_read += 1;
        // Also the quiet-hours edge, hence every tick.
        attention::sync(&app, os_attention);
        let mut effects = state.tick();
        let failed_now = state.persist_failed();
        if failed_now != persist_failed {
            persist_failed = failed_now;
            if failed_now {
                log::error!("persistence failed; sending is paused until a retry succeeds");
            } else {
                log::info!("persistence recovered; sending resumed");
            }
            crate::login::emit_changed(&app);
        }
        // Effects from settings changed through `prefs_set`.
        effects.extend(prefs::take_pending_effects(&app));
        let mut snapshot_changed = false;
        for effect in effects {
            if !state.notification_effect_is_current(&effect) {
                continue;
            }
            match effect {
                Effect::ShowAlarm { raise } => {
                    let corner = Corner::from_bottom_right(state.settings().position_bottom_right);
                    if let Err(e) = windows::show_alarm(&app, corner, raise) {
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
                    if on != flashing {
                        request_attention(&app, on);
                    }
                    flashing = on;
                    if !on {
                        tray::set_flash_phase(&app, true);
                    }
                }
                Effect::Unread { total, badge } => {
                    let text = badge.text();
                    tray::set_unread_tooltip(&app, text.as_deref());
                    set_taskbar_badge(&app, text.as_deref(), total);
                }
                Effect::Banner {
                    account,
                    gid,
                    count,
                    stay_ms,
                } => crate::notifications::show(&app, &account, &gid, count, stay_ms),
                Effect::SystemToast {
                    account,
                    gid,
                    count,
                } => crate::notifications::show(&app, &account, &gid, count, BANNER_STAY_MS),
            }
        }
        let alarm_shown = windows::alarm_is_visible(&app);
        if snapshot_changed || alarm_shown {
            let snap = crate::adapter::alarm_snapshot(&app);
            if must_hide_alarm(alarm_shown, snap.entries.len()) {
                windows::hide_alarm(&app);
            }
            // Directed emit: only local windows (alarm, and main for its
            // alert counters) receive customer-adjacent data, never a
            // remote webview.
            let _ = app.emit_to(views::ALARM, ALARM_SNAPSHOT_EVENT, snap.clone());
            events::to_main(&app, ALARM_SNAPSHOT_EVENT, snap);
        }
        // Reminder settings changed via notify_set_* → persist + prefs://changed.
        prefs::sync_reminder(&app);
        emit_clock(&app, &state);
        let fast = flashing && cfg!(not(target_os = "macos"));
        if fast {
            phase = !phase;
            tray::set_flash_phase(&app, phase);
        }
        thread::sleep(Duration::from_millis(pacer.sleep_ms(now_ms(), fast)));
    }
}

/// Whatever opened the alarm window, it never stays up with nothing to list.
fn must_hide_alarm(shown: bool, listed: usize) -> bool {
    shown && listed == 0
}

/// Wire shape of `ClockReading` (contracts.ts).
fn clock_json(r: &ClockReading) -> serde_json::Value {
    let quality = match r.quality {
        ClockQuality::Anchored {
            offset_ms,
            error_ms,
        } => {
            serde_json::json!({ "kind": "anchored", "offset_ms": offset_ms, "error_ms": error_ms })
        }
        ClockQuality::Stale => serde_json::json!({ "kind": "stale" }),
        ClockQuality::Unanchored => serde_json::json!({ "kind": "unanchored" }),
    };
    serde_json::json!({
        "server_now_ms": r.server_now_ms,
        "monotonic_ms": r.monotonic_ms,
        "quality": quality,
    })
}

/// 1 Hz `net://clock` to main (title-bar clock / countdown base).
fn emit_clock(app: &AppHandle, state: &HostState) {
    let reading = {
        let mut cores = state.lock();
        state.reading(&mut cores)
    };
    events::to_main(app, events::NET_CLOCK, clock_json(&reading));
}

fn play_sound(app: &AppHandle, sound: Sound) {
    // Audio output is a platform concern (MED/NTF-04). The main window
    // plays bundled clips on this event; nothing else is required for the
    // escalation semantics to be verifiable.
    // The new-message chime plays in the notice window, in step with its card
    // and independent of whether main is hidden. Effect order: card, then chime.
    let (window, name) = match sound {
        Sound::NewMessage => (views::NOTICE, "new_message"),
        Sound::Timeout => (views::MAIN, "timeout"),
        Sound::Loop => (views::MAIN, "loop"),
    };
    let _ = app.emit_to(window, events::NOTIFY_PLAY_SOUND, name);
}

fn stop_sound(app: &AppHandle) {
    let _ = app.emit_to(views::MAIN, events::NOTIFY_STOP_SOUND, ());
}

/// L1 taskbar/Dock signal. Windows flashes the taskbar button; macOS
/// bounces the Dock icon once (`Informational`, not the repeating
/// `Critical`). `false` cancels the request. Never focuses a window.
fn request_attention(app: &AppHandle, on: bool) {
    if let Some(win) = app.get_window(views::MAIN) {
        let kind = on.then_some(UserAttentionType::Informational);
        let _ = win.request_user_attention(kind);
    }
}

fn set_taskbar_badge(app: &AppHandle, text: Option<&str>, total: u32) {
    if let Some(win) = app.get_window(views::MAIN) {
        // macOS: Dock badge. `set_badge_count` is unsupported on Windows
        // (Tauri documents `set_overlay_icon` instead, which needs a badge
        // asset — a later NTF-04 task), so Windows keeps the title fallback.
        #[cfg(target_os = "macos")]
        {
            let count = if total == 0 {
                None
            } else {
                Some(i64::from(total))
            };
            let _ = win.set_badge_count(count);
        }
        #[cfg(not(target_os = "macos"))]
        let _ = total;
        let title = match text {
            Some(t) => format!("({t}) 旅游商家IM"),
            None => "旅游商家IM".to_string(),
        };
        let _ = win.set_title(&title);
    }
}

#[cfg(test)]
mod tests {
    use super::must_hide_alarm;

    #[test]
    fn alarm_window_hides_only_when_shown_with_an_empty_list() {
        assert!(must_hide_alarm(true, 0));
        assert!(!must_hide_alarm(true, 1));
        assert!(!must_hide_alarm(false, 0));
    }
}

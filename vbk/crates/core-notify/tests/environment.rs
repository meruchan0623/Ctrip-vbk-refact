//! DND, full-screen, presentation, lock-screen and focus-assist matrix.

mod common;

use common::*;
use contracts::{ReconcileState, ReminderSettings};
use core_notify::{
    DndMode, Effect, LocalOptions, NotifyCore, Sound, SystemState, DND_ONE_HOUR_MS, LOCKED_LABEL,
};

fn unfocused() -> SystemState {
    SystemState::default()
}

#[test]
fn dnd_suppresses_l1_l2_but_not_l3_by_default() {
    let mut core = NotifyCore::new();
    let a = acc("a", 1);
    let base = t0();
    let fx = core.set_dnd(
        DndMode::OneHour {
            until_ms: base.server_now_ms + DND_ONE_HOUR_MS,
        },
        &base,
    );
    assert!(fx.is_empty());
    assert!(core.dnd_active(&base));

    let fx = core.on_new_message(&a, "g1", true, &base);
    assert!(fx.is_empty(), "no flash, banner or sound under DND: {fx:?}");

    open_round(&mut core, &a, "g1", &base);
    let fx = drive(&mut core, &base, 0, 40);
    assert_eq!(raises(&fx), 1, "alert_during_dnd defaults to on");
    assert_eq!(sounds(&fx, Sound::Timeout), 1);
}

#[test]
fn dnd_without_timeout_exception_holds_l3_until_dnd_ends() {
    let mut core = NotifyCore::new();
    let a = acc("a", 1);
    let base = t0();
    core.set_settings(
        ReminderSettings {
            alert_during_dnd: false,
            ..ReminderSettings::default()
        },
        &base,
    )
    .expect("valid");
    let until = base.server_now_ms + 120_000;
    let _ = core.set_dnd(DndMode::UntilTomorrow { until_ms: until }, &base);
    open_round(&mut core, &a, "g1", &base);
    let fx = drive(&mut core, &base, 0, 119);
    assert!(fx.is_empty(), "L0 only while DND: {fx:?}");
    let fx = core.tick(&base.plus_ms(120_000));
    assert_eq!(raises(&fx), 1, "raised once when DND expires");
    assert_eq!(sounds(&fx, Sound::Timeout), 1);

    // Turning DND on while the window is visible hides it; off re-raises.
    let fx = core.set_dnd(
        DndMode::OneHour {
            until_ms: base.server_now_ms + 10_000_000,
        },
        &base.plus_ms(121_000),
    );
    assert_eq!(
        fx,
        vec![Effect::TrayFlash(false), Effect::HideAlarm, Effect::StopSound],
        "DND cancels L1 flashing, hides the window and cuts the clip"
    );
    let fx = core.set_dnd(DndMode::Off, &base.plus_ms(122_000));
    assert_eq!(raises(&fx), 1);
    assert_eq!(sounds(&fx, Sound::Timeout), 0);
}

#[test]
fn fullscreen_turns_banner_into_system_toast_and_respects_alert_setting() {
    let mut core = NotifyCore::new();
    let a = acc("a", 1);
    let base = t0();
    let _ = core.set_system_state(
        SystemState {
            fullscreen_app: true,
            ..unfocused()
        },
        &base,
    );
    let fx = core.on_new_message(&a, "g1", true, &base);
    assert!(has(
        &fx,
        &Effect::SystemToast {
            account: a.clone(),
            gid: "g1".into(),
            count: 1
        }
    ));
    assert!(!fx.iter().any(|e| matches!(e, Effect::Banner { .. })));

    open_round(&mut core, &a, "g1", &base);
    let fx = drive(&mut core, &base, 0, 40);
    assert_eq!(raises(&fx), 1, "alert_during_fullscreen defaults to on");

    // Setting off: flash + one sound, no window; window raises after exit.
    let mut core = NotifyCore::new();
    core.set_settings(
        ReminderSettings {
            alert_during_fullscreen: false,
            ..ReminderSettings::default()
        },
        &base,
    )
    .expect("valid");
    let _ = core.set_system_state(
        SystemState {
            fullscreen_app: true,
            ..unfocused()
        },
        &base,
    );
    open_round(&mut core, &a, "g1", &base);
    let fx = drive(&mut core, &base, 0, 60);
    assert_eq!(shows(&fx), 0);
    assert_eq!(sounds(&fx, Sound::Timeout), 1);
    assert!(has(&fx, &Effect::TrayFlash(true)));
    assert!(core.snapshot(&base.plus_ms(60_000)).entries.len() == 1);
    let fx = core.set_system_state(unfocused(), &base.plus_ms(61_000));
    assert_eq!(raises(&fx), 1);
    assert_eq!(sounds(&fx, Sound::Timeout), 0, "already sounded once");
}

#[test]
fn presentation_mode_flashes_only_and_mutes() {
    let mut core = NotifyCore::new();
    let a = acc("a", 1);
    let base = t0();
    let _ = core.set_system_state(
        SystemState {
            presentation: true,
            ..unfocused()
        },
        &base,
    );
    let fx = core.on_new_message(&a, "g1", true, &base);
    assert_eq!(fx, vec![Effect::TrayFlash(true)], "L2 hidden, L1 flash only");

    open_round(&mut core, &a, "g1", &base);
    let fx = drive(&mut core, &base, 0, 60);
    assert_eq!(shows(&fx), 0);
    assert_eq!(sounds(&fx, Sound::Timeout), 0);
    assert!(fx.is_empty(), "tray already flashing: {fx:?}");
    let fx = core.set_system_state(unfocused(), &base.plus_ms(61_000));
    assert_eq!(raises(&fx), 1);
    assert_eq!(sounds(&fx, Sound::Timeout), 1, "sound was withheld, plays on recovery");
}

#[test]
fn focus_assist_hides_l2_and_delays_l3() {
    let mut core = NotifyCore::new();
    let a = acc("a", 1);
    let base = t0();
    // A round already visible stays visible across focus assist.
    open_round(&mut core, &a, "g0", &base);
    let _ = drive(&mut core, &base, 0, 40);
    let fx = core.set_system_state(
        SystemState {
            focus_assist: true,
            ..unfocused()
        },
        &base.plus_ms(41_000),
    );
    assert_eq!(fx, vec![Effect::UpdateAlarm]);
    assert!(core.on_new_message(&a, "g1", true, &base.plus_ms(41_000)).is_empty());
    open_round(&mut core, &a, "g1", &base.plus_ms(41_000));
    let fx = drive(&mut core, &base, 41, 100);
    assert_eq!(raises(&fx), 0);
    assert!(fx.iter().all(|e| *e == Effect::UpdateAlarm));
    let fx = core.set_system_state(unfocused(), &base.plus_ms(101_000));
    assert_eq!(raises(&fx), 1);
}

#[test]
fn locked_masks_labels_stops_sound_and_waits_for_reconcile_after_unlock() {
    let mut core = NotifyCore::new();
    let a = acc("a", 1);
    let base = t0();
    open_round(&mut core, &a, "g1", &base);
    let _ = drive(&mut core, &base, 0, 40);
    assert!(core.alarm_visible());

    let fx = core.set_system_state(
        SystemState {
            locked: true,
            ..unfocused()
        },
        &base.plus_ms(41_000),
    );
    assert_eq!(fx, vec![Effect::HideAlarm, Effect::StopSound]);
    let snap = core.snapshot(&base.plus_ms(41_000));
    assert_eq!(snap.entries.len(), 1);
    assert_eq!(snap.entries[0].label, LOCKED_LABEL);
    assert!(drive(&mut core, &base, 41, 80).is_empty());

    // A customer message while locked: held, no banner, no sound.
    assert!(core
        .on_new_message(&a, "g2", true, &base.plus_ms(50_000))
        .is_empty());
    assert!(core
        .on_new_message(&a, "g2", true, &base.plus_ms(51_000))
        .is_empty());

    let fx = core.set_system_state(unfocused(), &base.plus_ms(81_000));
    assert_eq!(shows(&fx), 0, "nothing pops before reconcile");
    assert!(has(
        &fx,
        &Effect::Banner {
            account: a.clone(),
            gid: "g2".into(),
            count: 2,
            stay_ms: 6_000
        }
    ));
    assert_eq!(sounds(&fx, Sound::NewMessage), 1);
    assert!(core.snapshot(&base.plus_ms(81_000)).reconciling);
    assert!(drive(&mut core, &base, 81, 90).is_empty());
    assert_eq!(core.snapshot(&base.plus_ms(90_000)).entries[0].label, "c***r");

    let fx = core.apply_reconcile_state(ReconcileState::Normal, &base.plus_ms(91_000));
    assert_eq!(raises(&fx), 1);
    assert_eq!(sounds(&fx, Sound::Timeout), 0);
}

#[test]
fn ring_while_locked_keeps_only_the_l4_loop() {
    let mut core = NotifyCore::new();
    let a = acc("a", 1);
    let base = t0();
    core.set_settings(
        ReminderSettings {
            continuous_l4: true,
            ..ReminderSettings::default()
        },
        &base,
    )
    .expect("valid");
    core.set_options(LocalOptions {
        ring_while_locked: true,
    });
    open_round(&mut core, &a, "g1", &base);
    let _ = drive(&mut core, &base, 0, 100);
    let fx = core.set_system_state(
        SystemState {
            locked: true,
            ..unfocused()
        },
        &base.plus_ms(101_000),
    );
    assert_eq!(fx, vec![Effect::HideAlarm]);
    let fx = drive(&mut core, &base, 101, 160);
    assert!(sounds(&fx, Sound::Loop) >= 3);
    assert_eq!(shows(&fx), 0);

    // Default (off): the loop is silent while locked.
    core.set_options(LocalOptions::default());
    let fx = drive(&mut core, &base, 160, 220);
    assert_eq!(sounds(&fx, Sound::Loop), 0);
}

#[test]
fn sound_setting_off_mutes_timeout_and_loop() {
    let mut core = NotifyCore::new();
    let base = t0();
    core.set_settings(
        ReminderSettings {
            continuous_l4: true,
            timeout_sound: false,
            ..ReminderSettings::default()
        },
        &base,
    )
    .expect("valid");
    open_round(&mut core, &acc("a", 1), "g1", &base);
    let fx = drive(&mut core, &base, 0, 200);
    assert_eq!(raises(&fx), 2);
    assert_eq!(sounds(&fx, Sound::Timeout), 0);
    assert_eq!(sounds(&fx, Sound::Loop), 0);
}

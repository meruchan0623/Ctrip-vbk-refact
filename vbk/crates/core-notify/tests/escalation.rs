//! strong-alert §7 rows "资源与声音", "升级与稍后提醒", "断网、睡眠与重启".

mod common;

use common::*;
use contracts::{
    AlarmCommand, AlarmLevel, ClockQuality, ClockReading, ReconcileState, ReminderSettings,
    RoundEndReason, RoundEvent, SnoozeMinutes,
};
use core_notify::{
    is_red, CommandAck, CommandSource, Effect, NotifyCore, Now, RestoredRound, Sound,
};

#[test]
fn l3_raises_once_and_sounds_once_per_round_across_many_ticks() {
    let mut core = NotifyCore::new();
    let a = acc("a", 1);
    let base = t0();
    assert!(open_round(&mut core, &a, "g1", &base).is_empty());

    let early = drive(&mut core, &base, 0, 29);
    assert!(early.is_empty(), "nothing before T1: {early:?}");

    let at_t1 = core.tick(&base.plus_ms(30_000));
    assert_eq!(
        at_t1,
        vec![
            Effect::ShowAlarm { raise: true },
            Effect::PlaySound(Sound::Timeout),
            Effect::TrayFlash(true),
        ]
    );

    let later = drive(&mut core, &base, 30, 300);
    assert_eq!(raises(&later), 0);
    assert_eq!(sounds(&later, Sound::Timeout), 0);
    assert_eq!(sounds(&later, Sound::Loop), 0, "L4 is off by default");
    assert!(later.iter().all(|e| *e == Effect::UpdateAlarm), "1 Hz refresh only");

    let snap = core.snapshot(&base.plus_ms(100_000));
    assert_eq!(snap.entries.len(), 1);
    let e = &snap.entries[0];
    assert_eq!(e.level, AlarmLevel::L3);
    assert_eq!(e.waited_seconds, 100);
    assert!(is_red(e));
    assert!(e.start_confirmed);
    assert!(snap.clock_trusted);
    assert!(!snap.reconciling);

    // A version bump on the same round does not re-sound.
    let bumped = core.apply_round_event(
        RoundEvent::StartConfirmed {
            round: rref(&a, "g1", "r-g1", 2),
            start_message_id: "m0".into(),
            start_time_ms: base.server_now_ms - 5_000,
        },
        &base.plus_ms(301_000),
    );
    assert_eq!(sounds(&bumped, Sound::Timeout), 0);
    assert_eq!(raises(&bumped), 0);
}

#[test]
fn l3_to_l4_raises_once_loops_every_15s_capped_at_10_min_then_flash_only() {
    let mut core = NotifyCore::new();
    let base = t0();
    core.set_settings(
        ReminderSettings {
            continuous_l4: true,
            ..ReminderSettings::default()
        },
        &base,
    )
    .expect("valid settings");
    open_round(&mut core, &acc("a", 1), "g1", &base);

    let all = drive(&mut core, &base, 0, 800);
    assert_eq!(raises(&all), 2, "L3 and L3→L4 raise once each");
    assert_eq!(sounds(&all, Sound::Timeout), 1);
    // Loop at 90, 105, …, 690 s (elapsed-in-L4 0..=600 s) → 41 iterations.
    assert_eq!(sounds(&all, Sound::Loop), 41);
    assert!(has(&all, &Effect::TrayFlash(true)));

    let r = &core.rounds()[0];
    assert_eq!(r.level, AlarmLevel::L4);
    assert_eq!(r.l4_sound_count, 41);
    assert!(r.l4_cap_flashed);

    // Exact loop timing.
    let mut core = NotifyCore::new();
    core.set_settings(
        ReminderSettings {
            continuous_l4: true,
            ..ReminderSettings::default()
        },
        &base,
    )
    .expect("valid settings");
    open_round(&mut core, &acc("a", 1), "g1", &base);
    let _ = drive(&mut core, &base, 0, 89);
    let at_l4 = core.tick(&base.plus_ms(90_000));
    assert_eq!(raises(&at_l4), 1);
    assert_eq!(sounds(&at_l4, Sound::Loop), 1);
    assert_eq!(sounds(&drive(&mut core, &base, 90, 104), Sound::Loop), 0);
    assert_eq!(sounds(&core.tick(&base.plus_ms(105_000)), Sound::Loop), 1);
    // Past the cap: silence, window still refreshed.
    let past = drive(&mut core, &base, 700, 760);
    assert_eq!(sounds(&past, Sound::Loop), 0);
    assert!(past.iter().all(|e| *e == Effect::UpdateAlarm));
}

#[test]
fn switching_l4_off_does_not_re_raise() {
    let mut core = NotifyCore::new();
    let base = t0();
    core.set_settings(
        ReminderSettings {
            continuous_l4: true,
            ..ReminderSettings::default()
        },
        &base,
    )
    .expect("valid settings");
    open_round(&mut core, &acc("a", 1), "g1", &base);
    assert_eq!(raises(&drive(&mut core, &base, 0, 120)), 2);
    let off = core
        .set_settings(ReminderSettings::default(), &base.plus_ms(121_000))
        .expect("valid settings");
    assert_eq!(raises(&off), 0);
    assert_eq!(core.rounds()[0].level, AlarmLevel::L3);
    assert_eq!(raises(&drive(&mut core, &base, 121, 200)), 0);
}

#[test]
fn snooze_hides_and_silences_timing_continues_reshows_only_if_still_open() {
    for (minutes, ms) in [
        (SnoozeMinutes::Five, 300_000u64),
        (SnoozeMinutes::Ten, 600_000),
        (SnoozeMinutes::Thirty, 1_800_000),
    ] {
        let mut core = NotifyCore::new();
        let a = acc("a", 1);
        let base = t0();
        open_round(&mut core, &a, "g1", &base);
        let _ = drive(&mut core, &base, 0, 40);

        let at = base.plus_ms(40_000);
        let (ack, effects) = core
            .handle_command(
                AlarmCommand::Snooze {
                    account: a.clone(),
                    gid: "g1".into(),
                    round_id: "r-g1".into(),
                    version: 1,
                    minutes,
                },
                CommandSource::Alarm,
                &at,
            )
            .expect("snooze ok");
        let expected_until = at.server_now_ms + ms as i64;
        assert_eq!(
            ack,
            CommandAck::Snoozed {
                until_ms: expected_until
            }
        );
        assert_eq!(effects, vec![Effect::StopSound, Effect::HideAlarm]);
        assert!(core.snapshot(&at).entries.is_empty(), "snoozed entry hidden");

        let quiet = drive(&mut core, &base, 40, 40 + ms / 1000 - 1);
        assert!(quiet.is_empty(), "no popups or sounds during snooze");

        let expiry = base.plus_ms(40_000 + ms);
        let back = core.tick(&expiry);
        assert_eq!(raises(&back), 1, "re-shown once on expiry");
        assert_eq!(sounds(&back, Sound::Timeout), 0, "timeout sound stays once per round");
        let snap = core.snapshot(&expiry);
        assert_eq!(snap.entries.len(), 1);
        assert_eq!(snap.entries[0].waited_seconds, 40 + ms / 1000, "timing never stopped");
    }

    // Round ended during snooze → nothing on expiry.
    let mut core = NotifyCore::new();
    let a = acc("a", 1);
    let base = t0();
    open_round(&mut core, &a, "g1", &base);
    let _ = drive(&mut core, &base, 0, 40);
    let _ = core
        .handle_command(
            AlarmCommand::Snooze {
                account: a.clone(),
                gid: "g1".into(),
                round_id: "r-g1".into(),
                version: 1,
                minutes: SnoozeMinutes::Five,
            },
            CommandSource::Alarm,
            &base.plus_ms(40_000),
        )
        .expect("snooze ok");
    let ended = core.apply_round_event(
        RoundEvent::Ended {
            round: rref(&a, "g1", "r-g1", 1),
            reason: RoundEndReason::MerchantReplyConfirmed,
        },
        &base.plus_ms(100_000),
    );
    assert!(ended.is_empty(), "already hidden: nothing to hide again");
    assert!(drive(&mut core, &base, 100, 400).is_empty());
    assert!(core.rounds().is_empty());
}

#[test]
fn new_round_is_unaffected_by_another_rounds_snooze() {
    let mut core = NotifyCore::new();
    let a = acc("a", 1);
    let base = t0();
    open_round(&mut core, &a, "g1", &base);
    let _ = drive(&mut core, &base, 0, 40);
    let _ = core
        .handle_command(
            AlarmCommand::Snooze {
                account: a.clone(),
                gid: "g1".into(),
                round_id: "r-g1".into(),
                version: 1,
                minutes: SnoozeMinutes::Thirty,
            },
            CommandSource::Alarm,
            &base.plus_ms(40_000),
        )
        .expect("snooze ok");
    open_round(&mut core, &a, "g2", &base.plus_ms(50_000));
    let until_g2 = drive(&mut core, &base, 50, 79);
    assert_eq!(raises(&until_g2), 0);
    let at = core.tick(&base.plus_ms(80_000));
    assert_eq!(raises(&at), 1);
    assert_eq!(sounds(&at, Sound::Timeout), 1);
    let snap = core.snapshot(&base.plus_ms(80_000));
    assert_eq!(snap.entries.len(), 1);
    assert_eq!(snap.entries[0].gid, "g2");
}

#[test]
fn ended_removes_entry_and_hides_window_when_empty() {
    let mut core = NotifyCore::new();
    let a = acc("a", 1);
    let base = t0();
    open_round(&mut core, &a, "g1", &base);
    open_round(&mut core, &a, "g2", &base);
    let _ = drive(&mut core, &base, 0, 60);
    assert!(core.alarm_visible());

    for reason in [
        RoundEndReason::MerchantReplyConfirmed,
        RoundEndReason::ConversationFinished,
        RoundEndReason::TransferredOut,
        RoundEndReason::NotEligible,
    ] {
        let mut c = NotifyCore::new();
        open_round(&mut c, &a, "g1", &base);
        let _ = drive(&mut c, &base, 0, 60);
        let fx = c.apply_round_event(
            RoundEvent::Ended {
                round: rref(&a, "g1", "r-g1", 1),
                reason,
            },
            &base.plus_ms(61_000),
        );
        assert_eq!(fx, vec![Effect::StopSound, Effect::HideAlarm], "{reason:?}");
        assert!(c.rounds().is_empty());
    }

    let first = core.apply_round_event(
        RoundEvent::Ended {
            round: rref(&a, "g1", "r-g1", 1),
            reason: RoundEndReason::MerchantReplyConfirmed,
        },
        &base.plus_ms(61_000),
    );
    assert!(!has(&first, &Effect::HideAlarm));
    assert!(has(&first, &Effect::UpdateAlarm));
    assert_eq!(core.snapshot(&base.plus_ms(61_000)).entries.len(), 1);
    let second = core.apply_round_event(
        RoundEvent::Ended {
            round: rref(&a, "g2", "r-g2", 1),
            reason: RoundEndReason::ConversationFinished,
        },
        &base.plus_ms(62_000),
    );
    assert!(has(&second, &Effect::HideAlarm));
    assert!(!core.alarm_visible());
    assert!(core.snapshot(&base.plus_ms(62_000)).entries.is_empty());
}

#[test]
fn reconcile_barrier_keeps_entries_blocks_popups_and_resumes_with_one_raise() {
    let mut core = NotifyCore::new();
    let a = acc("a", 1);
    let base = t0();
    assert!(core
        .apply_reconcile_state(ReconcileState::Reconciling { generation: 1 }, &base)
        .is_empty());
    open_round(&mut core, &a, "g1", &base);
    open_round(&mut core, &a, "g2", &base.plus_ms(5_000));

    let during = drive(&mut core, &base, 0, 90);
    assert!(during.is_empty(), "no popups or sounds while reconciling: {during:?}");
    let snap = core.snapshot(&base.plus_ms(90_000));
    assert!(snap.reconciling);
    assert_eq!(snap.entries.len(), 2, "entries are kept");
    assert_eq!(snap.entries[0].level, AlarmLevel::L3);

    let resumed = core.apply_reconcile_state(ReconcileState::Normal, &base.plus_ms(91_000));
    assert_eq!(raises(&resumed), 1, "both overdue rounds merge into one raise");
    assert_eq!(sounds(&resumed, Sound::Timeout), 1, "one sound for the batch");
    assert!(!core.snapshot(&base.plus_ms(91_000)).reconciling);
    let after = drive(&mut core, &base, 91, 150);
    assert_eq!(raises(&after), 0);
    assert_eq!(sounds(&after, Sound::Timeout), 0);

    // Entering reconciling with a visible window keeps it (UpdateAlarm only),
    // and a round crossing T1 meanwhile waits for Normal.
    let fx = core.apply_reconcile_state(
        ReconcileState::Reconciling { generation: 2 },
        &base.plus_ms(151_000),
    );
    assert_eq!(fx, vec![Effect::UpdateAlarm]);
    open_round(&mut core, &a, "g3", &base.plus_ms(151_000));
    let held = drive(&mut core, &base, 151, 200);
    assert_eq!(raises(&held), 0);
    assert!(held.iter().all(|e| *e == Effect::UpdateAlarm));
    let fx = core.apply_reconcile_state(ReconcileState::Normal, &base.plus_ms(201_000));
    assert_eq!(raises(&fx), 1);
}

#[test]
fn restore_reminds_at_most_once_after_normal_and_reconfirmation() {
    let a = acc("a", 1);
    let base = t0();
    let restored = RestoredRound {
        round: rref(&a, "g1", "r-g1", 3),
        label: "c***r".into(),
        start_time_ms: Some(base.server_now_ms - 600_000),
        start_confirmed: true,
        hidden_version: None,
        snoozed_until_ms: None,
    };

    // Normal first, then re-confirmation.
    let mut core = NotifyCore::new();
    core.restore(vec![restored.clone()], &base);
    assert!(core.snapshot(&base).entries.is_empty(), "pending until verified");
    assert!(drive(&mut core, &base, 0, 10).is_empty());
    let fx = core.apply_reconcile_state(ReconcileState::Normal, &base.plus_ms(11_000));
    assert_eq!(raises(&fx), 0, "still needs the round to be re-confirmed");
    let fx = core.apply_round_event(
        started(rref(&a, "g1", "r-g1", 3), restored.start_time_ms, true),
        &base.plus_ms(12_000),
    );
    assert_eq!(raises(&fx), 1);
    assert_eq!(sounds(&fx, Sound::Timeout), 1);
    assert_eq!(core.snapshot(&base.plus_ms(12_000)).entries[0].waited_seconds, 612);
    // Later level change (L4 opt-in) refreshes but never raises again.
    let fx = core
        .set_settings(
            ReminderSettings {
                continuous_l4: true,
                ..ReminderSettings::default()
            },
            &base.plus_ms(13_000),
        )
        .expect("valid");
    assert_eq!(raises(&fx), 0);
    assert!(core.rounds()[0].reminded_once_after_restore);
    // L4 follows T2 after the round entered L3 in this client (not after
    // the real wait); it refreshes but never raises again.
    assert_eq!(raises(&drive(&mut core, &base, 13, 200)), 0);
    assert_eq!(core.rounds()[0].level, AlarmLevel::L4);

    // Re-confirmation first, then Normal → exactly one raise at Normal.
    let mut core = NotifyCore::new();
    core.restore(vec![restored.clone()], &base);
    let fx = core.apply_round_event(
        RoundEvent::StartConfirmed {
            round: rref(&a, "g1", "r-g1", 3),
            start_message_id: "m".into(),
            start_time_ms: base.server_now_ms - 600_000,
        },
        &base.plus_ms(1_000),
    );
    assert_eq!(raises(&fx), 0);
    assert!(drive(&mut core, &base, 1, 5).is_empty());
    let fx = core.apply_reconcile_state(ReconcileState::Normal, &base.plus_ms(6_000));
    assert_eq!(raises(&fx), 1);

    // Restored hidden rounds stay hidden; persistable round-trips.
    let mut core = NotifyCore::new();
    core.restore(
        vec![RestoredRound {
            hidden_version: Some(3),
            ..restored.clone()
        }],
        &base,
    );
    let _ = core.apply_reconcile_state(ReconcileState::Normal, &base);
    let fx = core.apply_round_event(
        started(rref(&a, "g1", "r-g1", 3), restored.start_time_ms, true),
        &base.plus_ms(1_000),
    );
    assert_eq!(raises(&fx), 0);
    assert_eq!(core.persistable()[0].hidden_version, Some(3));
}

#[test]
fn untrusted_clock_flags_estimates_until_a_trusted_reading_arrives() {
    let mut core = NotifyCore::new();
    let a = acc("a", 1);
    let untrusted = Now::new(100_000, T0_SERVER, false);
    open_round(&mut core, &a, "g1", &untrusted);
    assert!(core.rounds()[0].estimated);
    let _ = drive(&mut core, &untrusted, 0, 40);
    let snap = core.snapshot(&untrusted.plus_ms(40_000));
    assert!(!snap.clock_trusted);
    assert_eq!(snap.entries.len(), 1);

    // Trusted anchor arrives, server time turns out 10 s ahead.
    core.apply_clock(ClockReading {
        server_now_ms: T0_SERVER + 50_000,
        monotonic_ms: 140_000,
        quality: ClockQuality::Anchored {
            offset_ms: 0,
            error_ms: 50,
        },
    });
    assert!(!core.rounds()[0].estimated);
    let trusted = Now::new(141_000, T0_SERVER + 51_000, true);
    assert!(core.snapshot(&trusted).clock_trusted);

    // A trusted Now with an estimated entry still reports untrusted.
    let mut core = NotifyCore::new();
    open_round(&mut core, &a, "g1", &untrusted);
    let _ = drive(&mut core, &untrusted, 0, 40);
    assert!(!core.snapshot(&Now::new(141_000, T0_SERVER + 41_000, true)).clock_trusted);
}

#[test]
fn unconfirmed_start_is_listed_as_pending_but_never_pops() {
    let mut core = NotifyCore::new();
    let a = acc("a", 1);
    let base = t0();
    core.apply_round_event(started(rref(&a, "g1", "r-g1", 1), None, false), &base);
    assert!(drive(&mut core, &base, 0, 120).is_empty());
    let snap = core.snapshot(&base.plus_ms(120_000));
    assert_eq!(snap.entries.len(), 1);
    let e = &snap.entries[0];
    assert!(!e.start_confirmed);
    assert_eq!(e.waiting_since_ms, None);
    assert_eq!(e.level, AlarmLevel::L0);
    assert!(!is_red(e));
    assert!(core.snapshot(&base.plus_ms(29_000)).entries.is_empty());

    // A provisional start time with start_confirmed=false behaves the same.
    let mut c2 = NotifyCore::new();
    c2.apply_round_event(
        started(rref(&a, "g2", "r-g2", 1), Some(base.server_now_ms), false),
        &base,
    );
    assert!(drive(&mut c2, &base, 0, 120).is_empty());

    // Confirmation escalates immediately when already past T1.
    let fx = core.apply_round_event(
        RoundEvent::StartConfirmed {
            round: rref(&a, "g1", "r-g1", 2),
            start_message_id: "m".into(),
            start_time_ms: base.server_now_ms,
        },
        &base.plus_ms(121_000),
    );
    assert_eq!(raises(&fx), 1);
    assert_eq!(sounds(&fx, Sound::Timeout), 1);
    let snap = core.snapshot(&base.plus_ms(121_000));
    assert!(snap.entries[0].start_confirmed);
    assert_eq!(snap.entries[0].waiting_since_ms, Some(base.server_now_ms));
    assert_eq!(snap.entries[0].version, 2);
}

#[test]
fn snapshot_sorted_by_waited_desc_and_masked_only() {
    let mut core = NotifyCore::new();
    let a = acc("a", 1);
    let base = t0();
    core.apply_round_event(
        started(rref(&a, "g-new", "r1", 1), Some(base.server_now_ms - 40_000), true),
        &base,
    );
    core.apply_round_event(
        started(rref(&a, "g-old", "r2", 1), Some(base.server_now_ms - 200_000), true),
        &base,
    );
    let _ = core.tick(&base);
    let snap = core.snapshot(&base);
    assert_eq!(snap.entries.len(), 2);
    assert_eq!(snap.entries[0].gid, "g-old");
    assert_eq!(snap.entries[0].waited_seconds, 200);
    assert_eq!(snap.entries[1].waited_seconds, 40);
    assert_eq!(snap.entries[0].label, "c***r");
    assert_eq!(snap.generated_at_ms, base.server_now_ms);
}

#[test]
fn settings_disable_hides_and_enable_raises_again() {
    let mut core = NotifyCore::new();
    let base = t0();
    open_round(&mut core, &acc("a", 1), "g1", &base);
    let _ = drive(&mut core, &base, 0, 40);
    let (ack, fx) = core
        .handle_command(AlarmCommand::SetEnabled(false), CommandSource::Tray, &base.plus_ms(41_000))
        .expect("ok");
    assert!(matches!(ack, CommandAck::Settings(s) if !s.enabled));
    assert_eq!(fx, vec![Effect::StopSound, Effect::HideAlarm]);
    assert!(core.snapshot(&base.plus_ms(41_000)).entries.is_empty());
    assert!(drive(&mut core, &base, 41, 60).is_empty());
    let (_, fx) = core
        .handle_command(AlarmCommand::SetEnabled(true), CommandSource::Setting, &base.plus_ms(61_000))
        .expect("ok");
    assert_eq!(raises(&fx), 1);
    assert_eq!(sounds(&fx, Sound::Timeout), 0, "sound already played for this round");
}

// ------------------------------------------------------- QA regressions

#[test]
fn round_that_becomes_unpresentable_and_presentable_again_is_shown_again() {
    // A shown L3 round is demoted to 待核对 by core-im (window hidden) and
    // later confirmed again: the window must come back, without a second
    // timeout sound.
    let mut core = NotifyCore::new();
    let a = acc("a", 1);
    let base = t0();
    open_round(&mut core, &a, "g1", &base);
    let fx = drive(&mut core, &base, 0, 31);
    assert_eq!(raises(&fx), 1);
    assert_eq!(sounds(&fx, Sound::Timeout), 1);
    let fx = core.apply_round_event(
        RoundEvent::Started {
            round: rref(&a, "g1", "r-g1", 2),
            start_message_id: Some("m1".into()),
            start_time_ms: Some(base.server_now_ms),
            start_confirmed: false,
            label: "c***r".into(),
        },
        &base.plus_ms(40_000),
    );
    assert!(has(&fx, &Effect::HideAlarm));
    assert!(!core.alarm_visible());
    let mut fx = core.apply_round_event(
        RoundEvent::StartConfirmed {
            round: rref(&a, "g1", "r-g1", 3),
            start_message_id: "m1".into(),
            start_time_ms: base.server_now_ms,
        },
        &base.plus_ms(41_000),
    );
    fx.extend(drive(&mut core, &base.plus_ms(41_000), 0, 2));
    assert_eq!(shows(&fx), 1, "{fx:?}");
    assert!(core.alarm_visible());
    assert_eq!(sounds(&fx, Sound::Timeout), 0);
    // Same through a clock re-anchor that moves the deadline later.
    let mut core = NotifyCore::new();
    let stale = Now::new(0, 1_000_000, false);
    let mut fx = core.apply_round_event(started(rref(&a, "g2", "r-g2", 1), Some(1_000_000 - 40_000), true), &stale);
    fx.extend(core.tick(&stale));
    assert_eq!(raises(&fx), 1, "estimate is overdue");
    // Trusted anchor says the server is 50 s *behind* the estimate.
    core.apply_clock(ClockReading {
        server_now_ms: 1_000_000 - 50_000,
        monotonic_ms: 1_000,
        quality: ClockQuality::Anchored { offset_ms: 0, error_ms: 10 },
    });
    let fx = core.tick(&Now::new(1_000, 1_000_000 - 50_000, true));
    assert!(has(&fx, &Effect::HideAlarm), "not due any more on the trusted axis");
    let fx = drive(&mut core, &Now::new(1_000, 1_000_000 - 50_000, true), 0, 41);
    assert_eq!(raises(&fx), 1, "due again → shown again");
}

#[test]
fn invalidated_at_max_generation_does_not_overflow() {
    let mut core = NotifyCore::new();
    let a = acc("a", u64::MAX);
    let base = t0();
    open_round(&mut core, &a, "g1", &base);
    let fx = core.apply_round_event(RoundEvent::Invalidated { round: rref(&a, "g1", "r-g1", 1) }, &base);
    assert!(core.rounds().is_empty());
    assert!(!has(&fx, &Effect::ShowAlarm { raise: true }));
    // u64::MAX has no successor: the identity simply cannot be re-published
    // under a newer generation; the point is that nothing panicked.
    assert!(core.rounds().is_empty());
}

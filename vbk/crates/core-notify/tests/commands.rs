//! strong-alert §6 commands and §7 rows "关闭与隐藏", "旧身份回调".

mod common;

use common::*;
use contracts::{codes, AlarmCommand, ReminderSettings, RoundEvent, SnoozeMinutes};
use core_notify::{codes as notify_codes, CommandAck, CommandSource, Effect, NotifyCore, Sound};

fn hide(
    account: &contracts::AccountContext,
    gid: &str,
    round_id: &str,
    version: u64,
) -> AlarmCommand {
    AlarmCommand::HideRound {
        account: account.clone(),
        gid: gid.into(),
        round_id: round_id.into(),
        version,
    }
}

#[test]
fn hide_round_rejects_version_mismatch_and_keeps_entry_visible() {
    let mut core = NotifyCore::new();
    let a = acc("a", 1);
    let base = t0();
    open_round(&mut core, &a, "g1", &base);
    let _ = drive(&mut core, &base, 0, 40);
    let at = base.plus_ms(41_000);

    let err = core
        .handle_command(hide(&a, "g1", "r-g1", 2), CommandSource::Alarm, &at)
        .expect_err("stale version");
    assert!(err.is(codes::NOTIFY_ROUND_VERSION_MISMATCH));
    assert_eq!(core.snapshot(&at).entries.len(), 1);
    assert!(core.alarm_visible());

    let err = core
        .handle_command(hide(&a, "g1", "nope", 1), CommandSource::Alarm, &at)
        .expect_err("unknown round");
    assert!(err.is(notify_codes::NOTIFY_ROUND_NOT_FOUND));

    let (ack, fx) = core
        .handle_command(hide(&a, "g1", "r-g1", 1), CommandSource::Alarm, &at)
        .expect("hide ok");
    assert_eq!(ack, CommandAck::Hidden { count: 1 });
    assert_eq!(fx, vec![Effect::StopSound, Effect::HideAlarm]);
    assert!(core.snapshot(&at).entries.is_empty());
    assert_eq!(core.rounds().len(), 1, "hidden, not ended");
}

#[test]
fn hide_binds_to_round_id_not_to_version() {
    let mut core = NotifyCore::new();
    let a = acc("a", 1);
    let base = t0();
    open_round(&mut core, &a, "g1", &base);
    let _ = drive(&mut core, &base, 0, 40);
    let _ = core
        .handle_command(
            hide(&a, "g1", "r-g1", 1),
            CommandSource::Alarm,
            &base.plus_ms(41_000),
        )
        .expect("hide ok");

    // StartConfirmed on the same round (version 2) stays hidden.
    let fx = core.apply_round_event(
        RoundEvent::StartConfirmed {
            round: rref(&a, "g1", "r-g1", 2),
            start_message_id: "m0".into(),
            start_time_ms: base.server_now_ms - 10_000,
        },
        &base.plus_ms(42_000),
    );
    assert_eq!(raises(&fx), 0);
    assert!(drive(&mut core, &base, 42, 100).is_empty());
    assert!(core.snapshot(&base.plus_ms(100_000)).entries.is_empty());

    // A new round id for the same conversation shows again.
    let fx = core.apply_round_event(
        started(
            rref(&a, "g1", "r-g1-next", 1),
            Some(base.server_now_ms + 100_000),
            true,
        ),
        &base.plus_ms(100_000),
    );
    assert_eq!(raises(&fx), 0);
    assert_eq!(
        core.rounds().len(),
        1,
        "new round supersedes the hidden one"
    );
    let fx = drive(&mut core, &base, 100, 130);
    assert_eq!(raises(&fx), 1);
    assert_eq!(sounds(&fx, Sound::Timeout), 1);
    assert_eq!(
        core.snapshot(&base.plus_ms(130_000)).entries[0].round_id,
        "r-g1-next"
    );
}

#[test]
fn hide_all_hides_exactly_the_listed_versions() {
    let mut core = NotifyCore::new();
    let a = acc("a", 1);
    let base = t0();
    open_round(&mut core, &a, "ga", &base);
    open_round(&mut core, &a, "gb", &base);
    open_round(&mut core, &a, "gc", &base);
    let _ = drive(&mut core, &base, 0, 40);
    // gb moved to version 2 after the user saw the list.
    let _ = core.apply_round_event(
        RoundEvent::StartConfirmed {
            round: rref(&a, "gb", "r-gb", 2),
            start_message_id: "m".into(),
            start_time_ms: base.server_now_ms - 1,
        },
        &base.plus_ms(41_000),
    );
    let at = base.plus_ms(42_000);
    let (ack, fx) = core
        .handle_command(
            AlarmCommand::HideAll {
                seen: vec![
                    ("ga".into(), "r-ga".into(), 1),
                    ("gb".into(), "r-gb".into(), 1),
                ],
            },
            CommandSource::Alarm,
            &at,
        )
        .expect("hide all ok");
    assert_eq!(ack, CommandAck::Hidden { count: 1 });
    assert!(has(&fx, &Effect::UpdateAlarm));
    assert!(!has(&fx, &Effect::HideAlarm));
    let gids: Vec<String> = core
        .snapshot(&at)
        .entries
        .iter()
        .map(|e| e.gid.clone())
        .collect();
    assert_eq!(gids, vec!["gb".to_string(), "gc".to_string()]);

    let (ack, fx) = core
        .handle_command(
            AlarmCommand::HideAll {
                seen: vec![
                    ("gb".into(), "r-gb".into(), 2),
                    ("gc".into(), "r-gc".into(), 1),
                ],
            },
            CommandSource::Alarm,
            &at,
        )
        .expect("hide all ok");
    assert_eq!(ack, CommandAck::Hidden { count: 2 });
    assert!(has(&fx, &Effect::HideAlarm));
    assert!(core.snapshot(&at).entries.is_empty());
}

#[test]
fn open_conversation_validates_version_and_only_navigates() {
    let mut core = NotifyCore::new();
    let a = acc("a", 1);
    let base = t0();
    open_round(&mut core, &a, "g1", &base);
    let _ = drive(&mut core, &base, 0, 40);
    let at = base.plus_ms(41_000);

    let (ack, fx) = core
        .handle_command(
            AlarmCommand::OpenConversation {
                account: a.clone(),
                gid: "g1".into(),
                round_id: "r-g1".into(),
                version: 1,
            },
            CommandSource::Alarm,
            &at,
        )
        .expect("ok");
    assert_eq!(
        ack,
        CommandAck::Navigate {
            account: a.clone(),
            gid: "g1".into()
        }
    );
    assert!(fx.is_empty());
    assert_eq!(
        core.snapshot(&at).entries.len(),
        1,
        "navigation never acks the round"
    );

    let err = core
        .handle_command(
            AlarmCommand::OpenConversation {
                account: a.clone(),
                gid: "g1".into(),
                round_id: "r-g1".into(),
                version: 7,
            },
            CommandSource::Alarm,
            &at,
        )
        .expect_err("version mismatch");
    assert!(err.is(codes::NOTIFY_ROUND_VERSION_MISMATCH));
    assert_eq!(core.snapshot(&at).entries.len(), 1);
}

#[test]
fn snapshot_command_matches_snapshot_method() {
    let mut core = NotifyCore::new();
    let base = t0();
    open_round(&mut core, &acc("a", 1), "g1", &base);
    let _ = drive(&mut core, &base, 0, 40);
    let at = base.plus_ms(41_000);
    let (ack, fx) = core
        .handle_command(AlarmCommand::Snapshot, CommandSource::Setting, &at)
        .expect("ok");
    assert!(fx.is_empty());
    assert_eq!(ack, CommandAck::Snapshot(core.snapshot(&at)));
}

#[test]
fn invalid_threshold_is_rejected_and_valid_one_moves_the_deadline() {
    let mut core = NotifyCore::new();
    let base = t0();
    let err = core
        .set_settings(
            ReminderSettings {
                t1_seconds: 45,
                ..ReminderSettings::default()
            },
            &base,
        )
        .expect_err("45 s is not allowed");
    assert!(err.is(notify_codes::NOTIFY_INVALID_THRESHOLD));
    assert_eq!(core.settings().t1_seconds, 30);
    assert!(NotifyCore::with_settings(ReminderSettings {
        t1_seconds: 0,
        ..ReminderSettings::default()
    })
    .is_err());

    let err = core
        .handle_command(
            AlarmCommand::SetThreshold { t1_seconds: 45 },
            CommandSource::Setting,
            &base,
        )
        .expect_err("rejected");
    assert!(err.is(notify_codes::NOTIFY_INVALID_THRESHOLD));

    open_round(&mut core, &acc("a", 1), "g1", &base);
    let (ack, _) = core
        .handle_command(
            AlarmCommand::SetThreshold { t1_seconds: 60 },
            CommandSource::Alarm,
            &base.plus_ms(1_000),
        )
        .expect("60 s allowed");
    assert!(matches!(ack, CommandAck::Settings(s) if s.t1_seconds == 60));
    assert_eq!(raises(&drive(&mut core, &base, 1, 59)), 0);
    assert_eq!(raises(&core.tick(&base.plus_ms(60_000))), 1);
}

#[test]
fn sources_are_restricted() {
    let mut core = NotifyCore::new();
    let a = acc("a", 1);
    let base = t0();
    let open = AlarmCommand::OpenConversation {
        account: a.clone(),
        gid: "g".into(),
        round_id: "r".into(),
        version: 1,
    };
    let err = core
        .handle_command(open.clone(), CommandSource::Tray, &base)
        .expect_err("tray cannot navigate");
    assert!(err.is(notify_codes::NOTIFY_COMMAND_NOT_ALLOWED));
    let err = core
        .handle_command(hide(&a, "g", "r", 1), CommandSource::Setting, &base)
        .expect_err("settings page cannot hide");
    assert!(err.is(notify_codes::NOTIFY_COMMAND_NOT_ALLOWED));
    let err = core
        .handle_command(
            AlarmCommand::SetThreshold { t1_seconds: 60 },
            CommandSource::Tray,
            &base,
        )
        .expect_err("tray cannot change threshold");
    assert!(err.is(notify_codes::NOTIFY_COMMAND_NOT_ALLOWED));
    assert!(core
        .handle_command(
            AlarmCommand::SetSoundEnabled(false),
            CommandSource::Tray,
            &base
        )
        .is_ok());
    assert!(core
        .handle_command(AlarmCommand::Snapshot, CommandSource::Tray, &base)
        .is_ok());
}

#[test]
fn stale_generation_is_rejected_and_invalidated_clears_the_account() {
    let mut core = NotifyCore::new();
    let base = t0();
    let a2 = acc("a", 2);
    let a1 = acc("a", 1);
    open_round(&mut core, &a2, "g1", &base);
    assert!(core
        .apply_round_event(
            started(rref(&a1, "g9", "r9", 1), Some(base.server_now_ms), true),
            &base
        )
        .is_empty());
    assert_eq!(core.rounds().len(), 1, "older generation ignored");
    assert!(core.on_new_message(&a1, "g9", true, &base).is_empty());
    assert!(core.on_unread_changed(&a1, "g9", 5).is_empty());
    let _ = drive(&mut core, &base, 0, 40);

    let err = core
        .handle_command(
            hide(&a1, "g1", "r-g1", 1),
            CommandSource::Alarm,
            &base.plus_ms(41_000),
        )
        .expect_err("stale generation command");
    assert!(err.is(codes::ACCOUNT_STALE_GENERATION));

    let _ = core.on_unread_changed(&a2, "g1", 3);
    let fx = core.apply_round_event(
        RoundEvent::Invalidated {
            round: rref(&a2, "g1", "r-g1", 1),
        },
        &base.plus_ms(42_000),
    );
    assert!(core.rounds().is_empty());
    assert!(has(&fx, &Effect::HideAlarm));
    assert!(has(&fx, &Effect::StopSound));
    assert!(fx
        .iter()
        .any(|e| matches!(e, Effect::Unread { total: 0, .. })));
    assert_eq!(core.unread_total(), 0);
    // The invalidated generation is now stale too.
    assert!(core
        .apply_round_event(
            started(rref(&a2, "g1", "r-new", 1), Some(base.server_now_ms), true),
            &base
        )
        .is_empty());
    assert!(core.rounds().is_empty());
    let a3 = acc("a", 3);
    core.apply_round_event(
        started(rref(&a3, "g1", "r-new", 1), Some(base.server_now_ms), true),
        &base,
    );
    assert_eq!(core.rounds().len(), 1);

    // A newer generation arriving without Invalidated purges the older one.
    let b2 = acc("b", 2);
    let b3 = acc("b", 3);
    open_round(&mut core, &b2, "gb", &base);
    open_round(&mut core, &b3, "gb2", &base);
    assert!(core
        .rounds()
        .iter()
        .all(|r| r.round.account.session_generation >= 3));
}

#[test]
fn snooze_rejects_stale_version() {
    let mut core = NotifyCore::new();
    let a = acc("a", 1);
    let base = t0();
    open_round(&mut core, &a, "g1", &base);
    let _ = drive(&mut core, &base, 0, 40);
    let err = core
        .handle_command(
            AlarmCommand::Snooze {
                account: a,
                gid: "g1".into(),
                round_id: "r-g1".into(),
                version: 0,
                minutes: SnoozeMinutes::Five,
            },
            CommandSource::Alarm,
            &base.plus_ms(41_000),
        )
        .expect_err("stale");
    assert!(err.is(codes::NOTIFY_ROUND_VERSION_MISMATCH));
    assert!(core.alarm_visible());
}

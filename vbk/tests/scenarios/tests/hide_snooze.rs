//! Q8 — hide / snooze version binding: hide v1 then `StartConfirmed` bumps
//! to v2 on the same round id → stays hidden; a new round id → shows.
//! Snooze expiry re-shows only if still open; `Ended` during snooze removes
//! it (strong-alert §2 "稍后提醒" / "清除", §4 "用户隐藏记录只绑定该
//! round/version", §7 "关闭与隐藏" / "升级与稍后提醒").
#![allow(clippy::unwrap_used)]

mod common;

use common::*;
use contracts::{
    codes, AlarmCommand, AlarmLevel, MessageSource, RoundEndReason, RoundEvent, SenderRole,
    SnoozeMinutes, WaitingRoundRef,
};
use core_notify::{CommandAck, CommandSource, Effect, NotifyCore, Sound};

fn shown_round() -> (ImHarness, NotifyCore) {
    let mut h = ImHarness::new();
    let mut n = NotifyCore::new();
    h.message(customer("c1", T0_SERVER + 10_000));
    feed(&mut n, h.events(), &clock(10_000));
    let fx = drive(&mut n, &clock(10_000), 0, 31);
    assert_eq!(raises(&fx), 1);
    (h, n)
}

fn hide(
    n: &mut NotifyCore,
    round_id: &str,
    version: u64,
    now: &core_notify::Now,
) -> Result<(CommandAck, Vec<Effect>), contracts::AppError> {
    n.handle_command(
        AlarmCommand::HideRound {
            account: acc(1),
            gid: GID.into(),
            round_id: round_id.into(),
            version,
        },
        CommandSource::Alarm,
        now,
    )
}

#[test]
fn hide_binds_to_the_round_id_across_version_bumps_but_not_to_a_new_round() {
    let (mut h, mut n) = shown_round();
    let rid = format!("{GID}:c1");
    let t = clock(45_000);
    // Stale version: refused, nothing hidden.
    assert!(hide(&mut n, &rid, 7, &t)
        .unwrap_err()
        .is(codes::NOTIFY_ROUND_VERSION_MISMATCH));
    assert_eq!(n.snapshot(&t).entries.len(), 1);
    let (ack, fx) = hide(&mut n, &rid, 1, &t).unwrap();
    assert_eq!(ack, CommandAck::Hidden { count: 1 });
    assert!(has(&fx, &Effect::HideAlarm));
    assert!(has(&fx, &Effect::StopSound));
    assert!(n.snapshot(&t).entries.is_empty());

    // An earlier customer message surfaces out of order: core-im keeps the
    // round id and bumps the version with StartConfirmed.
    h.message(msg_in(
        GID,
        "c0",
        T0_SERVER + 5_000,
        SenderRole::Customer,
        MessageSource::Compensation,
    ));
    let ev = h.events();
    assert!(
        matches!(&ev[0], RoundEvent::StartConfirmed { round, start_message_id, .. } if round.round_id == rid && round.version == 2 && start_message_id == "c0")
    );
    let fx = feed(&mut n, ev, &t.plus_ms(1_000));
    assert_eq!(
        shows(&fx),
        0,
        "same round id stays hidden after a version bump"
    );
    assert!(n.snapshot(&t.plus_ms(1_000)).entries.is_empty());
    let fx = drive(&mut n, &t.plus_ms(1_000), 0, 60);
    assert_eq!(shows(&fx), 0);
    assert_eq!(sounds(&fx, Sound::Timeout), 0);
    // A hidden round is not "answered": the agent's reply still ends it.
    h.message(msg_in(
        GID,
        "s1",
        T0_SERVER + 120_000,
        SenderRole::MerchantSelf,
        MessageSource::Realtime,
    ));
    let ev = h.events();
    assert_eq!(
        ended_reason(&ev),
        Some(RoundEndReason::MerchantReplyConfirmed)
    );
    feed(&mut n, ev, &clock(120_000));
    assert!(n.rounds().is_empty());
    // Next valid customer message → new round id → shows again.
    h.message(customer("c2", T0_SERVER + 130_000));
    let ev = h.events();
    assert!(
        matches!(&ev[0], RoundEvent::Started { round, .. } if round.round_id == format!("{GID}:c2") && round.version == 1)
    );
    feed(&mut n, ev, &clock(130_000));
    let fx = drive(&mut n, &clock(130_000), 0, 31);
    assert_eq!(raises(&fx), 1);
    assert_eq!(sounds(&fx, Sound::Timeout), 1);
}

#[test]
fn hide_all_only_hides_the_versions_the_user_saw() {
    let mut n = NotifyCore::new();
    let t0 = clock(0);
    let r = |gid: &str, v: u64| WaitingRoundRef {
        account: acc(1),
        gid: gid.into(),
        round_id: format!("{gid}:c1"),
        version: v,
    };
    for gid in [GID, GID2] {
        n.apply_round_event(
            RoundEvent::Started {
                round: r(gid, 1),
                start_message_id: Some("c1".into()),
                start_time_ms: Some(T0_SERVER),
                start_confirmed: true,
                label: "g***1".into(),
            },
            &t0,
        );
    }
    drive(&mut n, &t0, 0, 31);
    let seen: Vec<(String, String, u64)> = n
        .snapshot(&t0.plus_ms(31_000))
        .entries
        .iter()
        .map(|e| (e.gid.clone(), e.round_id.clone(), e.version))
        .collect();
    assert_eq!(seen.len(), 2);
    // GID2 changed version after the snapshot the user is looking at.
    n.apply_round_event(
        RoundEvent::StartConfirmed {
            round: r(GID2, 2),
            start_message_id: "c0".into(),
            start_time_ms: T0_SERVER - 1_000,
        },
        &t0.plus_ms(32_000),
    );
    let (ack, _) = n
        .handle_command(
            AlarmCommand::HideAll { seen },
            CommandSource::Alarm,
            &t0.plus_ms(33_000),
        )
        .unwrap();
    assert_eq!(ack, CommandAck::Hidden { count: 1 });
    let snap = n.snapshot(&t0.plus_ms(33_000));
    assert_eq!(snap.entries.len(), 1);
    assert_eq!(snap.entries[0].gid, GID2);
}

#[test]
fn snooze_pauses_then_reshows_only_if_still_open() {
    let (mut h, mut n) = shown_round();
    let rid = format!("{GID}:c1");
    let t = clock(45_000);
    let (ack, fx) = n
        .handle_command(
            AlarmCommand::Snooze {
                account: acc(1),
                gid: GID.into(),
                round_id: rid.clone(),
                version: 1,
                minutes: SnoozeMinutes::Five,
            },
            CommandSource::Alarm,
            &t,
        )
        .unwrap();
    assert_eq!(
        ack,
        CommandAck::Snoozed {
            until_ms: t.server_now_ms + 300_000
        }
    );
    assert!(has(&fx, &Effect::HideAlarm));
    assert!(has(&fx, &Effect::StopSound));
    // During the snooze: no window, no sound, but the clock keeps running.
    let fx = drive(&mut n, &t, 0, 299);
    assert_eq!(shows(&fx), 0);
    assert_eq!(sounds(&fx, Sound::Timeout), 0);
    assert_eq!(sounds(&fx, Sound::Loop), 0);
    assert!(n.snapshot(&t.plus_ms(299_000)).entries.is_empty());
    assert_eq!(n.rounds()[0].level, AlarmLevel::L3);
    // Expiry: still open → re-shown once (raise), no second timeout sound.
    let fx = n.tick(&t.plus_ms(300_000));
    assert_eq!(raises(&fx), 1);
    assert_eq!(sounds(&fx, Sound::Timeout), 0, "L3 sound is once per round");
    let snap = n.snapshot(&t.plus_ms(300_000));
    assert_eq!(snap.entries.len(), 1);
    assert!(snap.entries[0].snoozed_until_ms.is_none());
    assert_eq!(
        snap.entries[0].waited_seconds, 335,
        "waiting time never paused"
    );

    // Snooze again, then the round ends during the snooze → removed, never
    // re-shown at expiry.
    n.handle_command(
        AlarmCommand::Snooze {
            account: acc(1),
            gid: GID.into(),
            round_id: rid.clone(),
            version: 1,
            minutes: SnoozeMinutes::Ten,
        },
        CommandSource::Alarm,
        &t.plus_ms(301_000),
    )
    .unwrap();
    h.message(msg_in(
        GID,
        "s1",
        T0_SERVER + 400_000,
        SenderRole::MerchantSelf,
        MessageSource::Realtime,
    ));
    let ev = h.events();
    assert_eq!(
        ended_reason(&ev),
        Some(RoundEndReason::MerchantReplyConfirmed)
    );
    feed(&mut n, ev, &clock(400_000));
    assert!(n.rounds().is_empty());
    let fx = drive(&mut n, &clock(400_000), 0, 700);
    assert_eq!(shows(&fx), 0);
    assert_eq!(sounds(&fx, Sound::Timeout), 0);
    // A new timeout in another conversation is not affected by the snooze.
    h.conversation(conv_for(
        GID2,
        contracts::ConversationStatus::Active,
        true,
        false,
    ));
    h.message(customer_in(GID2, "d1", T0_SERVER + 1_100_000));
    feed(&mut n, h.events(), &clock(1_100_000));
    let fx = drive(&mut n, &clock(1_100_000), 0, 31);
    assert_eq!(raises(&fx), 1);
    assert_eq!(sounds(&fx, Sound::Timeout), 1);
}

#[test]
fn snoozed_round_that_was_hidden_meanwhile_does_not_reshow() {
    let (_h, mut n) = shown_round();
    let rid = format!("{GID}:c1");
    let t = clock(45_000);
    n.handle_command(
        AlarmCommand::Snooze {
            account: acc(1),
            gid: GID.into(),
            round_id: rid.clone(),
            version: 1,
            minutes: SnoozeMinutes::Five,
        },
        CommandSource::Alarm,
        &t,
    )
    .unwrap();
    hide(&mut n, &rid, 1, &t.plus_ms(1_000)).unwrap();
    let fx = drive(&mut n, &t, 0, 400);
    assert_eq!(shows(&fx), 0);
    assert!(n.snapshot(&t.plus_ms(400_000)).entries.is_empty());
}

#[test]
fn round_that_turns_pending_then_confirmed_again_is_shown_again() {
    // A business message with an unresolved role arrives after the shown
    // round: core-im demotes the round to 待核对 (window hidden). When the
    // role is resolved as a robot, the round is confirmed again and is
    // still unanswered → the window must come back.
    let (mut h, mut n) = shown_round();
    let rid = format!("{GID}:c1");
    let mut unknown = msg_in(
        GID,
        "x1",
        T0_SERVER + 45_000,
        SenderRole::Unknown,
        MessageSource::Realtime,
    );
    unknown.sender_id = String::new();
    h.message(unknown);
    let ev = h.events();
    assert!(
        matches!(&ev[0], RoundEvent::Started { round, start_confirmed: false, .. } if round.round_id == rid && round.version == 2)
    );
    let fx = feed(&mut n, ev, &clock(45_000));
    assert!(
        has(&fx, &Effect::HideAlarm),
        "待核对 never drives the window"
    );
    assert!(!n.alarm_visible());
    // Resolved: it was a robot message, the customer is still waiting.
    h.message(msg_in(
        GID,
        "x1",
        T0_SERVER + 45_000,
        SenderRole::Robot,
        MessageSource::Compensation,
    ));
    let ev = h.events();
    assert!(
        matches!(&ev[0], RoundEvent::StartConfirmed { round, .. } if round.round_id == rid && round.version == 3)
    );
    let mut fx = feed(&mut n, ev, &clock(46_000));
    fx.extend(drive(&mut n, &clock(46_000), 0, 3));
    let snap = n.snapshot(&clock(49_000));
    assert_eq!(snap.entries.len(), 1);
    assert_eq!(snap.entries[0].level, AlarmLevel::L3);
    assert!(snap.entries[0].start_confirmed);
    assert_eq!(
        shows(&fx),
        1,
        "the window must be shown again for a presentable entry: {fx:?}"
    );
    assert!(n.alarm_visible());
    assert_eq!(
        sounds(&fx, Sound::Timeout),
        0,
        "but the one-shot sound is not repeated"
    );
}

#[test]
fn open_conversation_is_navigation_only_and_version_checked() {
    let (_h, mut n) = shown_round();
    let rid = format!("{GID}:c1");
    let t = clock(45_000);
    let (ack, fx) = n
        .handle_command(
            AlarmCommand::OpenConversation {
                account: acc(1),
                gid: GID.into(),
                round_id: rid.clone(),
                version: 1,
            },
            CommandSource::Alarm,
            &t,
        )
        .unwrap();
    assert_eq!(
        ack,
        CommandAck::Navigate {
            account: acc(1),
            gid: GID.into()
        }
    );
    assert!(
        fx.is_empty(),
        "opening never hides, acks or silences the round"
    );
    assert_eq!(n.snapshot(&t).entries.len(), 1);
    assert!(n
        .handle_command(
            AlarmCommand::OpenConversation {
                account: acc(1),
                gid: GID.into(),
                round_id: rid,
                version: 2
            },
            CommandSource::Alarm,
            &t,
        )
        .unwrap_err()
        .is(codes::NOTIFY_ROUND_VERSION_MISMATCH));
}

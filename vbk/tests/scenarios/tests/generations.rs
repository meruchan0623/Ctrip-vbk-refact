//! Q1 — wrong account / stale generation: a `FactEnvelope`, `RoundEvent`,
//! `AlarmCommand` or translation result from an older generation or another
//! account must never act on current state (README 不变量 1, 00-architecture
//! §4, F01/F03/F06).
#![allow(clippy::unwrap_used)]

mod common;

use common::*;
use contracts::{
    codes, AlarmCommand, AlarmLevel, ConversationStatus, ReconcileState, RoundEvent, SnoozeMinutes,
    WaitingRoundRef,
};
use core_account::{AccountRegistry, Buid, LogoutMode, UpstreamIdentity};
use core_assistant::{accept_result, TranslationBinding};
use core_im::{codes as im_codes, Fact, ImCores, StreamId};
use core_notify::{CommandSource, NotifyCore};

#[test]
fn im_rejects_older_generation_other_account_and_newer_generation_envelopes() {
    let mut h = ImHarness::new();
    h.message(customer("c1", 10_000));
    h.events();
    assert!(h.core.reconcile_state() == ReconcileState::Normal);

    // Older generation (a callback from before logout).
    let mut stale = h.envelope(
        StreamId::Message,
        Fact::Message(customer("c-stale", 11_000)),
    );
    stale.account = acc(0);
    let e = h.core.ingest(stale).unwrap_err();
    assert!(e.is(codes::ACCOUNT_STALE_GENERATION));
    // Another identity with the same gid.
    let mut other = h.envelope(
        StreamId::Message,
        Fact::Message(customer("c-other", 12_000)),
    );
    other.account = ctx("acc-other", "test", 1);
    assert!(h
        .core
        .ingest(other)
        .unwrap_err()
        .is(im_codes::IM_GENERATION_MISMATCH));
    // Same identity in another environment.
    let mut env = h.envelope(StreamId::Message, Fact::Message(customer("c-env", 12_500)));
    env.account = ctx("acc-test", "production", 1);
    assert!(h
        .core
        .ingest(env)
        .unwrap_err()
        .is(im_codes::IM_GENERATION_MISMATCH));
    // A generation the core has not been told about yet.
    let mut newer = h.envelope(StreamId::Message, Fact::Message(customer("c-new", 13_000)));
    newer.account = acc(2);
    assert!(h
        .core
        .ingest(newer)
        .unwrap_err()
        .is(im_codes::IM_GENERATION_MISMATCH));

    // Nothing was applied: the index still holds only c1 and the round is
    // unchanged; the stream cursor did not advance for any rejected envelope.
    assert_eq!(h.core.index().len(), 1);
    assert_eq!(h.waiting().start_message_id.as_deref(), Some("c1"));
    let cur = h.core.cursor(StreamId::Message).unwrap();
    assert_eq!(cur.seq, 1);
    assert!(h.events().is_empty());
}

#[test]
fn im_cores_route_by_persistent_identity_not_gid() {
    let mut cores = ImCores::new();
    let a = acc(1);
    let b = ctx("acc-b", "test", 1);
    cores.insert(core_im::ImCore::new(a.clone()));
    cores.insert(core_im::ImCore::new(b.clone()));
    let mut ha = ImHarness::bare(a.clone());
    let conv_a = ha.envelope(
        StreamId::Conversation,
        Fact::Conversation(conv(ConversationStatus::Active, true, false)),
    );
    cores.ingest(conv_a).unwrap();
    let m = ha.envelope(StreamId::Message, Fact::Message(customer("c1", 10_000)));
    cores.ingest(m).unwrap();
    // The same gid under account b has no conversation fact and no round.
    assert!(cores.get(&b).unwrap().round_state(GID).is_idle());
    assert!(cores.get(&a).unwrap().round_state(GID).round().is_some());
    // Unknown identity: refused, never applied anywhere.
    let mut unknown = ha.envelope(StreamId::Message, Fact::Message(customer("c2", 11_000)));
    unknown.account = ctx("acc-c", "test", 1);
    assert!(cores
        .ingest(unknown)
        .unwrap_err()
        .is(codes::ACCOUNT_UNKNOWN));
    let events = cores.drain_round_events();
    assert!(events.iter().all(|e| e.round().account == a));
}

#[test]
fn notify_ignores_round_events_from_an_invalidated_generation() {
    let mut n = NotifyCore::new();
    let t0 = clock(0);
    let old = acc(1);
    let r_old = WaitingRoundRef {
        account: old.clone(),
        gid: GID.into(),
        round_id: format!("{GID}:c1"),
        version: 1,
    };
    n.apply_round_event(
        RoundEvent::Started {
            round: r_old.clone(),
            start_message_id: Some("c1".into()),
            start_time_ms: Some(T0_SERVER),
            start_confirmed: true,
            label: "gr***01".into(),
        },
        &t0,
    );
    let fx = drive(&mut n, &t0, 0, 31);
    assert_eq!(raises(&fx), 1);
    assert_eq!(n.snapshot(&t0.plus_ms(31_000)).entries.len(), 1);

    // Logout: core-im invalidates every round of the old generation.
    let fx = n.apply_round_event(
        RoundEvent::Invalidated {
            round: r_old.clone(),
        },
        &t0.plus_ms(32_000),
    );
    assert!(has(&fx, &core_notify::Effect::HideAlarm));
    assert!(n.snapshot(&t0.plus_ms(32_000)).entries.is_empty());

    // Late events of the old generation: Started, StartConfirmed, Ended.
    for ev in [
        RoundEvent::Started {
            round: r_old.clone(),
            start_message_id: Some("c1".into()),
            start_time_ms: Some(T0_SERVER),
            start_confirmed: true,
            label: "gr***01".into(),
        },
        RoundEvent::StartConfirmed {
            round: r_old.clone(),
            start_message_id: "c1".into(),
            start_time_ms: T0_SERVER,
        },
    ] {
        let fx = n.apply_round_event(ev, &t0.plus_ms(33_000));
        assert_eq!(shows(&fx), 0, "stale generation must not show anything");
        assert!(n.rounds().is_empty());
    }

    // The new generation starts cleanly; an old-generation Ended cannot
    // remove the new round and an old-generation command cannot hide it.
    let new = acc(2);
    let r_new = WaitingRoundRef {
        account: new.clone(),
        gid: GID.into(),
        round_id: format!("{GID}:c1"),
        version: 1,
    };
    n.apply_round_event(
        RoundEvent::Started {
            round: r_new.clone(),
            start_message_id: Some("c1".into()),
            start_time_ms: Some(T0_SERVER),
            start_confirmed: true,
            label: "gr***01".into(),
        },
        &t0.plus_ms(34_000),
    );
    assert_eq!(n.rounds().len(), 1);
    n.apply_round_event(
        RoundEvent::Ended {
            round: r_old.clone(),
            reason: contracts::RoundEndReason::MerchantReplyConfirmed,
        },
        &t0.plus_ms(35_000),
    );
    assert_eq!(
        n.rounds().len(),
        1,
        "old-generation Ended must not clear the new round"
    );
    assert_eq!(n.rounds()[0].round.account, new);

    let stale_hide = AlarmCommand::HideRound {
        account: old.clone(),
        gid: GID.into(),
        round_id: format!("{GID}:c1"),
        version: 1,
    };
    let e = n
        .handle_command(stale_hide, CommandSource::Alarm, &t0.plus_ms(36_000))
        .unwrap_err();
    assert!(e.is(codes::ACCOUNT_STALE_GENERATION));
    let stale_snooze = AlarmCommand::Snooze {
        account: old,
        gid: GID.into(),
        round_id: format!("{GID}:c1"),
        version: 1,
        minutes: SnoozeMinutes::Five,
    };
    assert!(n
        .handle_command(stale_snooze, CommandSource::Alarm, &t0.plus_ms(36_000))
        .unwrap_err()
        .is(codes::ACCOUNT_STALE_GENERATION));
    let snap = n.snapshot(&t0.plus_ms(70_000));
    assert_eq!(snap.entries.len(), 1);
    assert_eq!(snap.entries[0].level, AlarmLevel::L3);
    assert!(snap.entries[0].snoozed_until_ms.is_none());
}

#[test]
fn notify_command_from_another_account_cannot_touch_a_round_with_the_same_ids() {
    let mut n = NotifyCore::new();
    let t0 = clock(0);
    let a = acc(1);
    let b = ctx("acc-b", "test", 1);
    for who in [&a, &b] {
        n.apply_round_event(
            RoundEvent::Started {
                round: WaitingRoundRef {
                    account: who.clone(),
                    gid: GID.into(),
                    round_id: format!("{GID}:c1"),
                    version: 1,
                },
                start_message_id: Some("c1".into()),
                start_time_ms: Some(T0_SERVER),
                start_confirmed: true,
                label: "gr***01".into(),
            },
            &t0,
        );
    }
    assert_eq!(
        n.rounds().len(),
        2,
        "same gid under two accounts are two rounds"
    );
    // b hides its own; a's entry stays.
    let (ack, _) = n
        .handle_command(
            AlarmCommand::HideRound {
                account: b.clone(),
                gid: GID.into(),
                round_id: format!("{GID}:c1"),
                version: 1,
            },
            CommandSource::Alarm,
            &t0.plus_ms(40_000),
        )
        .unwrap();
    assert_eq!(ack, core_notify::CommandAck::Hidden { count: 1 });
    let snap = n.snapshot(&t0.plus_ms(40_000));
    assert_eq!(snap.entries.len(), 1);
    assert_eq!(snap.entries[0].account, a);
    // A command naming an account that has no such round fails closed.
    let e = n
        .handle_command(
            AlarmCommand::OpenConversation {
                account: ctx("acc-c", "test", 1),
                gid: GID.into(),
                round_id: format!("{GID}:c1"),
                version: 1,
            },
            CommandSource::Alarm,
            &t0.plus_ms(40_000),
        )
        .unwrap_err();
    assert!(e.is(core_notify::codes::NOTIFY_ROUND_NOT_FOUND));
    // Setting / tray windows may not issue round commands at all.
    let e = n
        .handle_command(
            AlarmCommand::HideRound {
                account: a,
                gid: GID.into(),
                round_id: format!("{GID}:c1"),
                version: 1,
            },
            CommandSource::Setting,
            &t0.plus_ms(40_000),
        )
        .unwrap_err();
    assert!(e.is(core_notify::codes::NOTIFY_COMMAND_NOT_ALLOWED));
}

#[test]
fn account_registry_rejects_stale_and_never_issued_generations() {
    let mut reg = AccountRegistry::new(100);
    let attempt = reg.start_login(contracts::Environment::named("test"));
    let out = reg
        .publish_identity(
            &attempt.attempt_id,
            UpstreamIdentity {
                buid: Buid::new("buid-1"),
                uid: "u1".into(),
                agent_id: None,
                environment: contracts::Environment::named("test"),
            },
        )
        .unwrap();
    let ctx1 = out.ctx.clone();
    assert!(reg.validate(&ctx1).is_ok());
    // Never issued: a forged "future" generation is unknown, not accepted.
    assert!(reg
        .validate(&ctx1.next_generation())
        .unwrap_err()
        .is(codes::ACCOUNT_UNKNOWN));
    // Wrong environment for a known account id.
    let wrong_env = contracts::AccountContext::new(
        ctx1.account_id.clone(),
        contracts::Environment::named("production"),
        ctx1.session_generation,
    );
    assert!(reg
        .validate(&wrong_env)
        .unwrap_err()
        .is(codes::ACCOUNT_UNKNOWN));
    // Server says not logged in: generation advances first.
    let revoke = reg.invalidate(&ctx1.account_id, "ticket expired").unwrap();
    assert_eq!(revoke.revoked_generation, ctx1.session_generation);
    assert!(reg
        .validate(&ctx1)
        .unwrap_err()
        .is(codes::ACCOUNT_STALE_GENERATION));
    // The new generation exists but the account is not online either.
    let cur = reg.current_context(&ctx1.account_id).unwrap();
    assert!(cur.session_generation > ctx1.session_generation);
    assert!(reg
        .validate(&cur)
        .unwrap_err()
        .is(core_account::codes::ACCOUNT_NOT_ONLINE));
    // Transport callbacks of the old generation are refused too.
    assert!(reg
        .on_transport_disconnected(&ctx1)
        .unwrap_err()
        .is(codes::ACCOUNT_STALE_GENERATION));
    // Logout (no credential kept): the old context stays stale, no context
    // is current at all.
    let revoke = reg.logout(&ctx1.account_id, LogoutMode::Logout).unwrap();
    assert_eq!(revoke.revoked_generation, cur.session_generation);
    assert!(reg
        .validate(&ctx1)
        .unwrap_err()
        .is(codes::ACCOUNT_STALE_GENERATION));
    assert!(reg
        .validate(&cur)
        .unwrap_err()
        .is(codes::ACCOUNT_STALE_GENERATION));
    assert!(reg.current_context(&ctx1.account_id).is_none());
}

#[test]
fn assistant_result_binding_rejects_stale_generation_and_other_identity() {
    let current = TranslationBinding {
        account: acc(3),
        gid: GID.into(),
        draft_version: 2,
    };
    let stale_gen = TranslationBinding {
        account: acc(2),
        ..current.clone()
    };
    assert!(accept_result(&stale_gen, &current)
        .unwrap_err()
        .is(codes::ACCOUNT_STALE_GENERATION));
    let other = TranslationBinding {
        account: ctx("acc-b", "test", 3),
        ..current.clone()
    };
    assert!(accept_result(&other, &current)
        .unwrap_err()
        .is(core_assistant::codes::STALE_BINDING));
    let other_env = TranslationBinding {
        account: ctx("acc-test", "production", 3),
        ..current.clone()
    };
    assert!(accept_result(&other_env, &current)
        .unwrap_err()
        .is(core_assistant::codes::STALE_BINDING));
    // A result from a *newer* generation than the current one is not the
    // current binding either (it cannot have been requested by this draft).
    let newer = TranslationBinding {
        account: acc(4),
        ..current.clone()
    };
    assert!(accept_result(&newer, &current).is_err());
    assert!(accept_result(&current, &current).is_ok());
}

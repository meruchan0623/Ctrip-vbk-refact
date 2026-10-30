//! Q4 — duplicates across sources (Realtime twice through two WSS
//! connections + Compensation + History replay of the same server id):
//! exactly one message, no round restart, no second L3 sound in notify
//! (strong-alert §4.6, §7 "连续与重复消息", 00-architecture §4).
#![allow(clippy::unwrap_used)]

mod common;

use common::*;
use contracts::{MessageSource, RoundEndReason, RoundEvent, SenderRole};
use core_im::{DropReason, Fact, MergeOutcome, StreamId};
use core_notify::{NotifyCore, Sound};

#[test]
fn same_server_id_from_four_sources_is_one_message_one_round_one_sound() {
    let mut h = ImHarness::new();
    let mut n = NotifyCore::new();
    let t = T0_SERVER + 10_000;
    let copies = [
        customer_in(GID, "c1", t),
        customer_in(GID, "c1", t),
        msg_in(
            GID,
            "c1",
            t,
            SenderRole::Customer,
            MessageSource::Compensation,
        ),
        msg_in(GID, "c1", t, SenderRole::Customer, MessageSource::History),
        msg_in(GID, "c1", t, SenderRole::Customer, MessageSource::Init),
    ];
    let mut inserted = 0;
    let mut l2 = Vec::new();
    for (i, copy) in copies.into_iter().enumerate() {
        let rep = h.message(copy.clone());
        assert!(rep.applied);
        if rep.message == Some(MergeOutcome::Inserted) {
            inserted += 1;
            // The host only fans a *new, non-replay* message out to L1/L2.
            if !copy.source.is_replay() {
                l2.extend(n.on_new_message(&h.account, GID, true, &clock(10_000 + i as u64)));
            }
        } else {
            assert_eq!(rep.message, Some(MergeOutcome::Duplicate), "copy {i}");
            assert_eq!(rep.round_events, 0, "copy {i} must not touch the round");
        }
        let fx = feed(&mut n, h.events(), &clock(10_000 + i as u64));
        assert_eq!(shows(&fx), 0);
    }
    assert_eq!(inserted, 1);
    assert_eq!(h.core.index().len(), 1);
    let rec = h.core.index().find_by_message_id(GID, "c1").unwrap();
    assert_eq!(rec.seen_count, 5);
    assert_eq!(sounds(&l2, Sound::NewMessage), 1, "one new-message tone");
    assert_eq!(
        l2.iter()
            .filter(|e| matches!(e, core_notify::Effect::Banner { .. }))
            .count(),
        1
    );
    let r = h.waiting();
    assert_eq!(r.version, 1, "duplicates never bump the round version");
    assert_eq!(r.start_time_ms, Some(t));
    assert_eq!(n.rounds().len(), 1);

    // Escalation: one raise, one timeout sound, then refreshes only.
    let fx = drive(&mut n, &clock(10_000), 0, 60);
    assert_eq!(raises(&fx), 1);
    assert_eq!(sounds(&fx, Sound::Timeout), 1);
    // More duplicates after T1 change nothing in either core.
    for src in [
        MessageSource::Realtime,
        MessageSource::Compensation,
        MessageSource::History,
    ] {
        let rep = h.message(msg_in(GID, "c1", t, SenderRole::Customer, src));
        assert_eq!(rep.message, Some(MergeOutcome::Duplicate));
        assert_eq!(rep.round_events, 0);
    }
    assert!(h.events().is_empty());
    let fx = drive(&mut n, &clock(70_000), 0, 5);
    assert_eq!(raises(&fx), 0);
    assert_eq!(sounds(&fx, Sound::Timeout), 0);
    assert_eq!(sounds(&fx, Sound::Loop), 0);
}

#[test]
fn duplicate_sequence_numbers_are_dropped_before_the_index() {
    // Two connections that replay the *same* envelope seq: dropped by the
    // cursor, never merged, never a resync.
    let mut h = ImHarness::new();
    let env = h.envelope(StreamId::Message, Fact::Message(customer("c1", 10_000)));
    assert!(h.core.ingest(env.clone()).unwrap().applied);
    let rep = h.core.ingest(env.clone()).unwrap();
    assert!(!rep.applied);
    assert_eq!(rep.dropped, Some(DropReason::DuplicateSeq));
    assert!(rep.needs_resync.is_none());
    let mut older = env;
    older.seq = 0;
    assert_eq!(
        h.core.ingest(older).unwrap().dropped,
        Some(DropReason::DuplicateSeq)
    );
    assert_eq!(h.core.index().len(), 1);
    assert_eq!(count_started(&h.events()), 1);
}

#[test]
fn history_and_init_replay_never_restart_an_ended_round_or_start_a_new_one() {
    let mut h = ImHarness::new();
    let mut n = NotifyCore::new();
    h.message(customer("c1", T0_SERVER + 10_000));
    h.message(msg_in(
        GID,
        "s1",
        T0_SERVER + 12_000,
        SenderRole::MerchantOther,
        MessageSource::Realtime,
    ));
    let ev = h.events();
    assert_eq!(
        ended_reason(&ev),
        Some(RoundEndReason::MerchantReplyConfirmed)
    );
    feed(&mut n, ev, &clock(12_000));
    assert!(n.rounds().is_empty());

    // Page / init replay of the same two messages, plus an older customer
    // message that only history knows about.
    for src in [MessageSource::History, MessageSource::Init] {
        h.message(msg_in(
            GID,
            "c0",
            T0_SERVER + 5_000,
            SenderRole::Customer,
            src,
        ));
        h.message(msg_in(
            GID,
            "c1",
            T0_SERVER + 10_000,
            SenderRole::Customer,
            src,
        ));
        h.message(msg_in(
            GID,
            "s1",
            T0_SERVER + 12_000,
            SenderRole::MerchantOther,
            src,
        ));
    }
    assert!(h.core.round_state(GID).is_idle());
    assert!(h.events().is_empty());
    // A replay-only customer message *after* the reply is not live evidence:
    // no round starts from a page (rule b); only a live copy can.
    h.message(msg_in(
        GID,
        "c2",
        T0_SERVER + 13_000,
        SenderRole::Customer,
        MessageSource::History,
    ));
    assert!(h.core.round_state(GID).is_idle());
    assert!(h.events().is_empty());
    let rep = h.message(msg_in(
        GID,
        "c2",
        T0_SERVER + 13_000,
        SenderRole::Customer,
        MessageSource::Compensation,
    ));
    assert_eq!(
        rep.message,
        Some(MergeOutcome::Updated),
        "gaining a live source is a change"
    );
    let r = h.waiting();
    assert_eq!(r.start_message_id.as_deref(), Some("c2"));
    let ev = h.events();
    assert_eq!(count_started(&ev), 1);
    let fx = feed(&mut n, ev, &clock(13_000));
    assert_eq!(shows(&fx), 0);
    let fx = drive(&mut n, &clock(13_000), 0, 31);
    assert_eq!(raises(&fx), 1);
    assert_eq!(sounds(&fx, Sound::Timeout), 1);
}

#[test]
fn repeated_started_upserts_of_the_same_round_do_not_resound_or_reraise() {
    // core-im may re-emit `Started` (version bump) for the same round id;
    // notify treats it as an upsert.
    let mut n = NotifyCore::new();
    let t0 = clock(0);
    let r = contracts::WaitingRoundRef {
        account: acc(1),
        gid: GID.into(),
        round_id: format!("{GID}:c1"),
        version: 1,
    };
    let started = |v: u64| RoundEvent::Started {
        round: contracts::WaitingRoundRef {
            version: v,
            ..r.clone()
        },
        start_message_id: Some("c1".into()),
        start_time_ms: Some(T0_SERVER),
        start_confirmed: true,
        label: "gr***01".into(),
    };
    n.apply_round_event(started(1), &t0);
    let fx = drive(&mut n, &t0, 0, 31);
    assert_eq!(raises(&fx), 1);
    assert_eq!(sounds(&fx, Sound::Timeout), 1);
    let mut fx = Vec::new();
    for v in [1, 2, 3, 2] {
        fx.extend(n.apply_round_event(started(v), &t0.plus_ms(40_000)));
    }
    assert_eq!(raises(&fx), 0);
    assert_eq!(sounds(&fx, Sound::Timeout), 0);
    assert_eq!(n.rounds().len(), 1);
    assert_eq!(
        n.rounds()[0].round.version,
        3,
        "a stale version never regresses"
    );
}

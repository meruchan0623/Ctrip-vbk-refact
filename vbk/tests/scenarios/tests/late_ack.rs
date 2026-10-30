//! Q3 — late ACK boundary: customer M1 → agent send intent S (boundary M1)
//! → customer M2 → S confirmed late. The round must NOT be cleared (M2 is
//! unanswered); a continued round starts from M2 and core-notify keeps /
//! raises an entry (plan §7 "迟到回复证据", strong-alert §4.3/§4.4).
#![allow(clippy::unwrap_used)]

mod common;

use common::*;
use contracts::{
    AlarmLevel, MessageSource, ReconcileState, RoundEndReason, RoundEvent, SendDisposition,
    SenderRole,
};
use core_notify::{Effect, NotifyCore, Sound};

fn m1_intent_m2(h: &mut ImHarness) -> String {
    h.message(customer("m1", T0_SERVER + 10_000));
    let intent = h.core.create_send_intent(GID, T0_SERVER + 11_000).unwrap();
    assert_eq!(intent.customer_boundary_message_id.as_deref(), Some("m1"));
    assert_eq!(
        intent.frozen_round_id.as_deref(),
        Some(format!("{GID}:m1").as_str())
    );
    h.core.mark_submitted(&intent.local_id).unwrap();
    h.message(customer("m2", T0_SERVER + 20_000));
    intent.local_id
}

#[test]
fn late_ack_ends_m1_round_and_continues_from_m2_into_notify() {
    let mut h = ImHarness::new();
    let mut n = NotifyCore::new();
    let lid = m1_intent_m2(&mut h);
    let fx = feed(&mut n, h.events(), &clock(20_000));
    assert_eq!(shows(&fx), 0);
    // T1 passes for m1 → one raise, one timeout sound.
    let fx = drive(&mut n, &clock(20_000), 0, 25);
    assert_eq!(raises(&fx), 1);
    assert_eq!(sounds(&fx, Sound::Timeout), 1);

    // The ACK arrives late, with a server time between m1 and m2.
    h.core
        .apply_send_result(
            &lid,
            SendDisposition::Confirmed {
                server_message_id: "t1".into(),
                server_time_ms: T0_SERVER + 15_000,
            },
        )
        .unwrap();
    let ev = h.events();
    assert_eq!(ev.len(), 2);
    assert!(
        matches!(&ev[0], RoundEvent::Ended { round, reason: RoundEndReason::MerchantReplyConfirmed } if round.round_id == format!("{GID}:m1"))
    );
    assert!(
        matches!(&ev[1], RoundEvent::Started { round, start_confirmed: true, start_time_ms: Some(t), .. } if round.round_id == format!("{GID}:m2") && *t == T0_SERVER + 20_000)
    );
    let r = h.waiting();
    assert_eq!(r.start_message_id.as_deref(), Some("m2"));

    // notify: m2 is already > T1 old at 55 s → the entry is kept (new round
    // id) and raised again once, with its own one-shot timeout sound.
    let now = clock(55_000);
    let fx = feed(&mut n, ev, &now);
    assert_eq!(raises(&fx), 1, "m2 round must be raised once");
    assert_eq!(sounds(&fx, Sound::Timeout), 1);
    assert!(!has(&fx, &Effect::HideAlarm) || shows(&fx) == 1);
    let snap = n.snapshot(&now);
    assert_eq!(snap.entries.len(), 1);
    assert_eq!(snap.entries[0].round_id, format!("{GID}:m2"));
    assert_eq!(snap.entries[0].waiting_since_ms, Some(T0_SERVER + 20_000));
    assert_eq!(snap.entries[0].waited_seconds, 35);
    assert_eq!(snap.entries[0].level, AlarmLevel::L3);
    // Steady state: only refreshes, no further raises or sounds.
    let fx = drive(&mut n, &now, 0, 10);
    assert_eq!(raises(&fx), 0);
    assert_eq!(sounds(&fx, Sound::Timeout), 0);
}

#[test]
fn late_ack_with_server_time_after_m2_still_leaves_m2_waiting() {
    let mut h = ImHarness::new();
    let lid = m1_intent_m2(&mut h);
    h.events();
    h.core
        .apply_send_result(
            &lid,
            SendDisposition::Confirmed {
                server_message_id: "t1".into(),
                server_time_ms: T0_SERVER + 25_000,
            },
        )
        .unwrap();
    assert_eq!(h.waiting().start_message_id.as_deref(), Some("m2"));
    assert_eq!(count_ended(&h.events()), 1);
}

#[test]
fn late_ack_via_readback_reconcile_uses_the_same_boundary() {
    // The ACK never arrives; the read-back finds the message by local id.
    let mut h = ImHarness::new();
    let lid = m1_intent_m2(&mut h);
    h.core
        .apply_send_result(&lid, SendDisposition::Unknown)
        .unwrap();
    h.events();
    let mut found = msg_in(
        GID,
        "t1",
        T0_SERVER + 15_000,
        SenderRole::MerchantSelf,
        MessageSource::History,
    );
    found.local_id = Some(lid.clone());
    assert!(matches!(
        h.core.reconcile_unknown(&lid, &[found]).unwrap(),
        core_im::ReconcileOutcome::Confirmed { .. }
    ));
    assert_eq!(h.waiting().start_message_id.as_deref(), Some("m2"));
    let ev = h.events();
    assert_eq!(count_ended(&ev), 1);
    assert_eq!(count_started(&ev), 1);
}

#[test]
fn late_ack_whose_boundary_is_m2_clears_everything() {
    // Control case: the agent composed after seeing M2 → boundary M2.
    let mut h = ImHarness::new();
    h.message(customer("m1", T0_SERVER + 10_000));
    h.message(customer("m2", T0_SERVER + 20_000));
    let intent = h.core.create_send_intent(GID, T0_SERVER + 21_000).unwrap();
    assert_eq!(intent.customer_boundary_message_id.as_deref(), Some("m2"));
    h.core.mark_submitted(&intent.local_id).unwrap();
    h.events();
    h.core
        .apply_send_result(
            &intent.local_id,
            SendDisposition::Confirmed {
                server_message_id: "t1".into(),
                server_time_ms: T0_SERVER + 22_000,
            },
        )
        .unwrap();
    assert!(h.core.round_state(GID).is_idle());
    let ev = h.events();
    assert_eq!(count_ended(&ev), 1);
    assert_eq!(count_started(&ev), 0);
}

#[test]
fn late_ack_during_reconcile_barrier_is_applied_after_resync_without_losing_m2() {
    let mut h = ImHarness::new();
    let lid = m1_intent_m2(&mut h);
    h.events();
    // Gap on the message stream → barrier.
    h.skip(core_im::StreamId::Message, 3);
    let rep = h.message(customer("m3", T0_SERVER + 30_000));
    assert!(matches!(rep.dropped, Some(core_im::DropReason::Gap { .. })));
    assert!(matches!(
        h.core.reconcile_state(),
        ReconcileState::Reconciling { .. }
    ));
    h.core
        .apply_send_result(
            &lid,
            SendDisposition::Confirmed {
                server_message_id: "t1".into(),
                server_time_ms: T0_SERVER + 15_000,
            },
        )
        .unwrap();
    assert!(h.events().is_empty(), "no round decision while reconciling");
    assert_eq!(
        h.waiting().start_message_id.as_deref(),
        Some("m1"),
        "unchanged until resync"
    );
    h.core.resync_complete(
        core_im::StreamId::Message,
        contracts::StreamCursor::new(1, h.seq[0]),
    );
    assert_eq!(h.core.reconcile_state(), ReconcileState::Normal);
    assert_eq!(h.waiting().start_message_id.as_deref(), Some("m2"));
    let ev = h.events();
    assert_eq!(count_ended(&ev), 1);
    assert_eq!(count_started(&ev), 1);
}

//! Q6 — reconcile barrier end-to-end: a gap on `im.message` → core-im
//! reports `needs_resync` and `Reconciling` → notify pauses popups and
//! sounds → `resync_complete` → `Normal` → at most one raise + one timeout
//! sound for an already-overdue round (strong-alert §5, §7 "断网、睡眠与重启").
#![allow(clippy::unwrap_used)]

mod common;

use common::*;
use contracts::{ReconcileState, StreamCursor};
use core_im::{DropReason, Fact, StreamId};
use core_net::{ReconcileCoordinator, ReconcileReason};
use core_notify::{Effect, NotifyCore, Sound};

#[test]
fn gap_pauses_popups_until_resync_then_raises_once() {
    let mut h = ImHarness::new();
    let mut n = NotifyCore::new();
    let mut coord = ReconcileCoordinator::new();

    // c1 arrives, then the stream loses two envelopes before c2.
    h.message(customer("c1", T0_SERVER + 10_000));
    feed(&mut n, h.events(), &clock(10_000));
    h.skip(StreamId::Message, 2);
    let rep = h.message(customer("c2", T0_SERVER + 12_000));
    assert!(!rep.applied);
    assert_eq!(
        rep.dropped,
        Some(DropReason::Gap {
            expected: 2,
            got: 4
        })
    );
    assert_eq!(rep.needs_resync, Some(StreamId::Message));
    assert!(matches!(
        h.core.reconcile_state(),
        ReconcileState::Reconciling { generation: 1 }
    ));
    assert_eq!(h.core.required_resyncs(), vec![StreamId::Message]);
    // Everything on the broken stream is dropped until the re-handshake;
    // the conversation stream is unaffected.
    let rep = h.message(customer("c3", T0_SERVER + 13_000));
    assert_eq!(rep.dropped, Some(DropReason::AwaitingResync));
    let rep = h.conversation(conv(contracts::ConversationStatus::Active, true, false));
    assert!(rep.applied);
    assert_eq!(rep.needs_resync, Some(StreamId::Message), "still pending");
    assert!(h.events().is_empty());

    // Host mirrors the barrier into net's coordinator and into notify.
    let g = coord.begin_reconcile(ReconcileReason::StreamGap);
    assert_eq!(coord.state(), ReconcileState::Reconciling { generation: g });
    let fx = n.apply_reconcile_state(coord.state(), &clock(13_000));
    assert_eq!(shows(&fx), 0);
    // T1 for c1 elapses during the barrier: no popup, no sound, no flash.
    let fx = drive(&mut n, &clock(13_000), 0, 60);
    assert_eq!(shows(&fx), 0);
    assert_eq!(sounds(&fx, Sound::Timeout), 0);
    assert_eq!(sounds(&fx, Sound::Loop), 0);
    assert!(!has(&fx, &Effect::TrayFlash(true)));
    assert!(!n.alarm_visible());
    let snap = n.snapshot(&clock(73_000));
    assert!(snap.reconciling);
    assert_eq!(snap.entries.len(), 1, "the entry is kept, just not popped");

    // Re-handshake: compensation re-delivers c2/c3 from the new cursor.
    h.core
        .resync_complete(StreamId::Message, StreamCursor::new(2, 0));
    h.epoch = 2;
    h.seq[0] = 0;
    assert_eq!(h.core.reconcile_state(), ReconcileState::Normal);
    h.message(msg_in(
        GID,
        "c2",
        T0_SERVER + 12_000,
        contracts::SenderRole::Customer,
        contracts::MessageSource::Compensation,
    ));
    h.message(msg_in(
        GID,
        "c3",
        T0_SERVER + 13_000,
        contracts::SenderRole::Customer,
        contracts::MessageSource::Compensation,
    ));
    let r = h.waiting();
    assert_eq!(
        r.start_message_id.as_deref(),
        Some("c1"),
        "start never moves later"
    );
    assert!(h.events().is_empty(), "same round, no new event");
    assert!(coord.complete(g));
    assert_eq!(coord.state(), ReconcileState::Normal);
    let mut fx = n.apply_reconcile_state(coord.state(), &clock(74_000));
    fx.extend(feed(&mut n, h.events(), &clock(74_000)));
    assert_eq!(raises(&fx), 1, "exactly one raise after the barrier lifts");
    assert_eq!(sounds(&fx, Sound::Timeout), 1);
    let fx = drive(&mut n, &clock(74_000), 0, 20);
    assert_eq!(raises(&fx), 0);
    assert_eq!(sounds(&fx, Sound::Timeout), 0);
    assert_eq!(count(&fx, &Effect::UpdateAlarm), 20);
    assert!(!n.snapshot(&clock(94_000)).reconciling);
}

#[test]
fn stale_reconcile_completion_cannot_lift_a_newer_barrier() {
    let mut coord = ReconcileCoordinator::new();
    let mut n = NotifyCore::new();
    let g1 = coord.begin_reconcile(ReconcileReason::Offline);
    let g2 = coord.begin_reconcile(ReconcileReason::WakeFromSleep);
    assert!(!coord.complete(g1), "older generation is a no-op");
    n.apply_reconcile_state(coord.state(), &clock(0));
    assert!(n.snapshot(&clock(0)).reconciling);
    assert!(coord.complete(g2));
    n.apply_reconcile_state(coord.state(), &clock(1));
    assert!(!n.snapshot(&clock(1)).reconciling);
    // notify never declares recovery itself: it only mirrors the state.
    n.apply_reconcile_state(ReconcileState::Reconciling { generation: 9 }, &clock(2));
    assert!(n.snapshot(&clock(2)).reconciling);
}

#[test]
fn epoch_change_and_second_stream_gap_require_every_broken_stream_to_resync() {
    let mut h = ImHarness::new();
    h.message(customer("c1", T0_SERVER + 10_000));
    h.events();
    // Epoch change on the message stream, gap on the conversation stream.
    h.epoch = 2;
    let rep = h.message(customer("c2", T0_SERVER + 11_000));
    assert_eq!(rep.dropped, Some(DropReason::EpochChanged));
    h.skip(StreamId::Conversation, 1);
    let rep = h.conversation(conv(contracts::ConversationStatus::Finished, true, false));
    // (the harness epoch applies to both streams: epoch change + gap)
    assert!(matches!(
        rep.dropped,
        Some(DropReason::Gap { .. } | DropReason::EpochChanged)
    ));
    assert_eq!(h.core.required_resyncs().len(), 2);
    assert!(matches!(
        h.core.reconcile_state(),
        ReconcileState::Reconciling { generation: 1 }
    ));
    // Completing one stream keeps the barrier; the dropped Finished fact
    // must not have ended the round.
    h.core
        .resync_complete(StreamId::Message, StreamCursor::new(2, 0));
    assert!(h.core.is_reconciling());
    assert!(h.core.round_state(GID).round().is_some());
    h.core
        .resync_complete(StreamId::Conversation, StreamCursor::new(1, h.seq[1]));
    assert_eq!(h.core.reconcile_state(), ReconcileState::Normal);
    assert!(
        h.core.round_state(GID).round().is_some(),
        "absence of the dropped fact proves nothing"
    );
    // The reconcile generation is monotonic across barriers.
    h.skip(StreamId::Conversation, 5);
    h.conversation(conv(contracts::ConversationStatus::Active, true, false));
    assert!(matches!(
        h.core.reconcile_state(),
        ReconcileState::Reconciling { generation: 2 }
    ));
}

#[test]
fn facts_applied_during_barrier_are_evaluated_only_when_it_lifts() {
    // A finished conversation learnt on the (healthy) conversation stream
    // while the message stream is broken ends the round only after resync.
    let mut h = ImHarness::new();
    let mut n = NotifyCore::new();
    h.message(customer("c1", T0_SERVER + 10_000));
    feed(&mut n, h.events(), &clock(10_000));
    drive(&mut n, &clock(10_000), 0, 31);
    assert!(n.alarm_visible());
    h.skip(StreamId::Message, 1);
    h.message(customer("c2", T0_SERVER + 42_000));
    n.apply_reconcile_state(h.core.reconcile_state(), &clock(42_000));
    h.conversation(conv(contracts::ConversationStatus::Finished, true, false));
    assert!(h.events().is_empty());
    assert!(n.alarm_visible(), "barrier keeps the window");
    h.core
        .resync_complete(StreamId::Message, StreamCursor::new(1, h.seq[0]));
    let ev = h.events();
    assert_eq!(
        ended_reason(&ev),
        Some(contracts::RoundEndReason::ConversationFinished)
    );
    let mut fx = feed(&mut n, ev, &clock(43_000));
    fx.extend(n.apply_reconcile_state(ReconcileState::Normal, &clock(43_000)));
    assert!(has(&fx, &Effect::HideAlarm));
    assert_eq!(raises(&fx), 0);
    assert!(n.rounds().is_empty());
}

#[test]
fn transport_disconnect_is_a_fact_not_a_barrier_by_itself() {
    let mut h = ImHarness::new();
    h.message(customer("c1", T0_SERVER + 10_000));
    h.events();
    h.push(
        StreamId::Transport,
        Fact::Transport(core_im::TransportState::Disconnected),
    );
    assert_eq!(
        h.core.transport_state(),
        Some(core_im::TransportState::Disconnected)
    );
    assert_eq!(
        h.core.reconcile_state(),
        ReconcileState::Normal,
        "the host raises the barrier via net's coordinator"
    );
    assert!(h.events().is_empty());
    assert!(h.core.round_state(GID).round().is_some());
}

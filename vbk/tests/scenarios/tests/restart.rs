//! Q7 — restart: store `PendingVerification` + im `restore` + notify
//! `restore` → no popup until `Normal` *and* re-confirmation by fresh facts;
//! afterwards remind at most once (strong-alert §5 "重启后恢复…最多提醒一次",
//! §7 "断网、睡眠与重启", F06).
#![allow(clippy::unwrap_used)]

mod common;

use common::*;
use contracts::{
    AlarmLevel, ConversationStatus, MessageSource, ReconcileState, ReminderSettings,
    RoundEndReason, RoundEvent, SendDisposition, SenderRole, StreamCursor,
};
use core_im::{ImCore, StreamId};
use core_notify::{Effect, NotifyCore, RestoredRound, Sound};
use core_store::{
    MemoryStore, Namespace, ReconcileEvidence, ReminderStateRepo, RoundRecord, Store,
};

/// Runs a session up to an overdue, shown round and returns what a host
/// would persist for both cores.
fn session_before_crash() -> (ImHarness, NotifyCore, Vec<RestoredRound>) {
    let mut h = ImHarness::new();
    let mut n = NotifyCore::new();
    h.message(customer("c1", T0_SERVER + 10_000));
    feed(&mut n, h.events(), &clock(10_000));
    let fx = drive(&mut n, &clock(10_000), 0, 40);
    assert_eq!(raises(&fx), 1);
    let persisted = n.persistable();
    assert_eq!(persisted.len(), 1);
    assert!(persisted[0].start_confirmed);
    (h, n, persisted)
}

#[test]
fn store_round_records_are_pending_verification_until_evidence_is_complete() {
    let ns = Namespace::from_context(&acc(1));
    let store = MemoryStore::new();
    let mut txn = store.begin(&ns).unwrap();
    ReminderStateRepo::put(
        &mut txn,
        &RoundRecord {
            gid: GID.into(),
            round_id: format!("{GID}:c1"),
            version: 3,
            start_message_id: Some("c1".into()),
            start_time_ms: Some(T0_SERVER + 10_000),
            start_confirmed: true,
            reminded_version: 3,
            hidden_version: 0,
            snoozed_until_ms: None,
        },
    );
    store.commit(txn).unwrap();
    let pending = ReminderStateRepo::load_all(&store, &ns).unwrap();
    assert_eq!(pending.len(), 1);
    for partial in [
        ReconcileEvidence {
            compensation_complete: false,
            conversation_readback_complete: false,
        },
        ReconcileEvidence {
            compensation_complete: true,
            conversation_readback_complete: false,
        },
        ReconcileEvidence {
            compensation_complete: false,
            conversation_readback_complete: true,
        },
    ] {
        let p = ReminderStateRepo::load_all(&store, &ns).unwrap();
        assert!(p
            .reconcile(partial)
            .unwrap_err()
            .is(core_store::codes::STORE_NOT_RECONCILED));
    }
    let rows = pending.reconcile(ReconcileEvidence::complete()).unwrap();
    assert_eq!(rows[0].version, 3);
    assert!(
        rows[0].start_confirmed,
        "the stored flag is data; the cores decide trust"
    );
}

#[test]
fn restart_pops_at_most_once_and_only_after_normal_plus_reconfirmation() {
    let (h0, _n0, persisted) = session_before_crash();
    let im_state = h0.core.persisted_state();

    // ---- process restart ----
    let mut h = ImHarness::from_core(ImCore::restore(im_state));
    assert!(matches!(
        h.core.reconcile_state(),
        ReconcileState::Reconciling { .. }
    ));
    assert!(h.core.round_state(GID).is_pending());
    let mut n = NotifyCore::new();
    let boot = clock(100_000);
    n.restore(persisted, &boot);
    // Nothing is listed or popped right after restore.
    let fx = drive(&mut n, &boot, 0, 5);
    assert_eq!(shows(&fx), 0);
    assert!(n.snapshot(&boot.plus_ms(5_000)).entries.is_empty());

    // im's restore upsert: the round is 待核对 (unconfirmed) under a bumped
    // version. Still no popup.
    let ev = h.events();
    assert!(
        matches!(&ev[0], RoundEvent::Started { start_confirmed: false, round, .. } if round.version == 2)
    );
    let fx = feed(&mut n, ev, &boot.plus_ms(6_000));
    assert_eq!(shows(&fx), 0);
    assert_eq!(n.rounds()[0].round.version, 2);

    // Barrier lifts in notify before the facts are back: still no popup.
    let fx = n.apply_reconcile_state(ReconcileState::Normal, &boot.plus_ms(7_000));
    assert_eq!(shows(&fx), 0);
    let fx = drive(&mut n, &boot.plus_ms(7_000), 0, 40);
    assert_eq!(shows(&fx), 0);
    assert_eq!(sounds(&fx, Sound::Timeout), 0);
    let snap = n.snapshot(&boot.plus_ms(47_000));
    assert_eq!(snap.entries.len(), 1, "listed as 待核对 after T1");
    assert!(!snap.entries[0].start_confirmed);
    assert_eq!(snap.entries[0].level, AlarmLevel::L0);

    // Read-back: conversation + history copy of c1, then the two resyncs.
    h.conversation(conv(ConversationStatus::Active, true, false));
    h.message(msg_in(
        GID,
        "c1",
        T0_SERVER + 10_000,
        SenderRole::Customer,
        MessageSource::History,
    ));
    assert!(h.events().is_empty(), "frozen until both streams resynced");
    h.core
        .resync_complete(StreamId::Conversation, StreamCursor::new(1, h.seq[1]));
    assert!(h.core.is_reconciling());
    h.core
        .resync_complete(StreamId::Message, StreamCursor::new(1, h.seq[0]));
    assert_eq!(h.core.reconcile_state(), ReconcileState::Normal);
    let r = h.waiting();
    assert_eq!(r.start_message_id.as_deref(), Some("c1"));
    assert_eq!(r.version, 3);
    let ev = h.events();
    assert!(matches!(&ev[0], RoundEvent::StartConfirmed { round, .. } if round.version == 3));

    // Now, and only now, one raise + one timeout sound.
    let t = boot.plus_ms(48_000);
    let fx = feed(&mut n, ev, &t);
    assert_eq!(raises(&fx), 1);
    assert_eq!(sounds(&fx, Sound::Timeout), 1);
    let snap = n.snapshot(&t);
    assert!(snap.entries[0].start_confirmed);
    assert_eq!(snap.entries[0].level, AlarmLevel::L3);
    assert_eq!(snap.entries[0].waiting_since_ms, Some(T0_SERVER + 10_000));

    // Afterwards: no second raise, even when L4 is switched on and reached.
    let s = ReminderSettings {
        continuous_l4: true,
        ..Default::default()
    };
    let fx = n.set_settings(s, &t).unwrap();
    assert_eq!(raises(&fx), 0);
    let fx = drive(&mut n, &t, 0, 120);
    assert_eq!(raises(&fx), 0, "a restored round reminds at most once");
    assert_eq!(sounds(&fx, Sound::Timeout), 0);
    assert_eq!(
        n.snapshot(&t.plus_ms(120_000)).entries[0].level,
        AlarmLevel::L4
    );
}

#[test]
fn restart_with_reply_found_in_readback_ends_silently() {
    let (h0, _n0, persisted) = session_before_crash();
    let mut h = ImHarness::from_core(ImCore::restore(h0.core.persisted_state()));
    let mut n = NotifyCore::new();
    let boot = clock(100_000);
    n.restore(persisted, &boot);
    feed(&mut n, h.events(), &boot);
    n.apply_reconcile_state(ReconcileState::Normal, &boot);
    h.conversation(conv(ConversationStatus::Active, true, false));
    h.message(msg_in(
        GID,
        "c1",
        T0_SERVER + 10_000,
        SenderRole::Customer,
        MessageSource::History,
    ));
    // Another agent answered while we were down.
    h.message(msg_in(
        GID,
        "s1",
        T0_SERVER + 50_000,
        SenderRole::MerchantOther,
        MessageSource::History,
    ));
    h.core
        .resync_complete(StreamId::Conversation, StreamCursor::new(1, h.seq[1]));
    h.core
        .resync_complete(StreamId::Message, StreamCursor::new(1, h.seq[0]));
    let ev = h.events();
    assert_eq!(
        ended_reason(&ev),
        Some(RoundEndReason::MerchantReplyConfirmed)
    );
    let fx = feed(&mut n, ev, &boot.plus_ms(1_000));
    assert_eq!(shows(&fx), 0);
    assert_eq!(sounds(&fx, Sound::Timeout), 0);
    assert!(n.rounds().is_empty());
    assert!(!n.alarm_visible());
}

#[test]
fn restart_without_readback_never_pops_and_keeps_the_round() {
    let (h0, _n0, persisted) = session_before_crash();
    let mut h = ImHarness::from_core(ImCore::restore(h0.core.persisted_state()));
    let mut n = NotifyCore::new();
    let boot = clock(100_000);
    n.restore(persisted, &boot);
    feed(&mut n, h.events(), &boot);
    n.apply_reconcile_state(ReconcileState::Normal, &boot);
    // Only the conversation came back; the message history did not.
    h.conversation(conv(ConversationStatus::Active, true, false));
    h.core
        .resync_complete(StreamId::Conversation, StreamCursor::new(1, h.seq[1]));
    h.core
        .resync_complete(StreamId::Message, StreamCursor::new(1, 0));
    assert!(h.core.round_state(GID).is_pending(), "no fabricated start");
    assert!(h.events().is_empty());
    let fx = drive(&mut n, &boot, 0, 600);
    assert_eq!(shows(&fx), 0);
    assert_eq!(sounds(&fx, Sound::Timeout), 0);
    assert_eq!(sounds(&fx, Sound::Loop), 0);
    assert!(!n.snapshot(&boot.plus_ms(600_000)).entries[0].start_confirmed);
}

#[test]
fn restored_hidden_and_snoozed_state_survives_reconfirmation() {
    let (h0, mut n0, _) = session_before_crash();
    let t = clock(50_000);
    let v = n0.rounds()[0].round.version;
    n0.handle_command(
        contracts::AlarmCommand::HideRound {
            account: acc(1),
            gid: GID.into(),
            round_id: format!("{GID}:c1"),
            version: v,
        },
        core_notify::CommandSource::Alarm,
        &t,
    )
    .unwrap();
    let persisted = n0.persistable();
    assert_eq!(persisted[0].hidden_version, Some(v));

    let mut h = ImHarness::from_core(ImCore::restore(h0.core.persisted_state()));
    let mut n = NotifyCore::new();
    let boot = clock(100_000);
    n.restore(persisted, &boot);
    feed(&mut n, h.events(), &boot);
    n.apply_reconcile_state(ReconcileState::Normal, &boot);
    h.conversation(conv(ConversationStatus::Active, true, false));
    h.message(msg_in(
        GID,
        "c1",
        T0_SERVER + 10_000,
        SenderRole::Customer,
        MessageSource::History,
    ));
    h.core
        .resync_complete(StreamId::Conversation, StreamCursor::new(1, h.seq[1]));
    h.core
        .resync_complete(StreamId::Message, StreamCursor::new(1, h.seq[0]));
    let fx = feed(&mut n, h.events(), &boot.plus_ms(1_000));
    assert_eq!(
        shows(&fx),
        0,
        "hidden before the restart stays hidden for the same round id"
    );
    assert!(n.snapshot(&boot.plus_ms(1_000)).entries.is_empty());
    // A new customer message after the reply opens a *new* round that shows.
    h.message(msg_in(
        GID,
        "s1",
        T0_SERVER + 110_000,
        SenderRole::MerchantOther,
        MessageSource::Realtime,
    ));
    h.message(customer("c2", T0_SERVER + 111_000));
    let ev = h.events();
    assert_eq!(count_ended(&ev), 1);
    assert_eq!(count_started(&ev), 1);
    feed(&mut n, ev, &clock(111_000));
    let fx = drive(&mut n, &clock(111_000), 0, 31);
    assert_eq!(raises(&fx), 1);
    assert!(has(&fx, &Effect::PlaySound(Sound::Timeout)));
}

#[test]
fn restart_under_new_generation_rebinds_im_state_and_host_must_rebind_notify() {
    // Re-auth after restart: a new session generation. core-im re-binds
    // the persisted rounds/outbox; the host must hand notify the restored
    // rounds under the *current* context, otherwise the first event of the
    // new generation purges them (and their hidden/snoozed state).
    let (h0, n0, persisted) = session_before_crash();
    let state = h0.core.persisted_state();
    let new_ctx = acc(2);
    let mut h = ImHarness::from_core(ImCore::restore_as(state, new_ctx.clone()).unwrap());
    assert_eq!(h.core.account(), &new_ctx);
    let rebound: Vec<RestoredRound> = persisted
        .into_iter()
        .map(|mut r| {
            r.round.account = new_ctx.clone();
            r
        })
        .collect();
    let mut n = NotifyCore::new();
    let boot = clock(100_000);
    n.restore(rebound, &boot);
    let ev = h.events();
    assert!(ev.iter().all(|e| e.round().account == new_ctx));
    feed(&mut n, ev, &boot);
    assert_eq!(n.rounds().len(), 1);
    assert!(n.rounds()[0].restored, "same round, still the restored one");
    drop(n0);
}

#[test]
fn reply_sent_right_after_restart_is_not_a_false_alarm_once_history_is_back() {
    // The agent answers from the web page before compensation delivered the
    // customer message that was stamped earlier. After read-back the round
    // must end (or never start), not pop a strong alert for an answered
    // message.
    let (h0, _n0, persisted) = session_before_crash();
    let mut h = ImHarness::from_core(ImCore::restore(h0.core.persisted_state()));
    let mut n = NotifyCore::new();
    let boot = clock(100_000);
    n.restore(persisted, &boot);
    feed(&mut n, h.events(), &boot);
    n.apply_reconcile_state(ReconcileState::Normal, &boot);
    let intent = h.core.create_send_intent(GID, T0_SERVER + 101_000).unwrap();
    assert_eq!(
        intent.customer_boundary_message_id, None,
        "index is empty after restart"
    );
    h.core.mark_submitted(&intent.local_id).unwrap();
    h.core
        .apply_send_result(
            &intent.local_id,
            SendDisposition::Confirmed {
                server_message_id: "t1".into(),
                server_time_ms: T0_SERVER + 101_000,
            },
        )
        .unwrap();
    h.conversation(conv(ConversationStatus::Active, true, false));
    h.message(msg_in(
        GID,
        "c1",
        T0_SERVER + 10_000,
        SenderRole::Customer,
        MessageSource::Compensation,
    ));
    h.core
        .resync_complete(StreamId::Conversation, StreamCursor::new(1, h.seq[1]));
    h.core
        .resync_complete(StreamId::Message, StreamCursor::new(1, h.seq[0]));
    assert!(h.core.round_state(GID).is_idle());
    let ev = h.events();
    assert_eq!(
        ended_reason(&ev),
        Some(RoundEndReason::MerchantReplyConfirmed)
    );
    let fx = feed(&mut n, ev, &boot.plus_ms(2_000));
    assert_eq!(shows(&fx), 0);
    assert_eq!(sounds(&fx, Sound::Timeout), 0);
    assert!(n.rounds().is_empty());
    // A customer message stamped after the reply still opens a round.
    h.message(customer("c2", T0_SERVER + 102_000));
    let ev = h.events();
    assert_eq!(count_started(&ev), 1);
    feed(&mut n, ev, &clock(102_000));
    let fx = drive(&mut n, &clock(102_000), 0, 31);
    assert_eq!(raises(&fx), 1);
}

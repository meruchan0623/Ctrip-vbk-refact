//! Q2 — send already took effect but the local result is unknown:
//! `SendDisposition::Unknown` survives `persisted_state() → restore()` and a
//! store reload, nothing turns it into a resend, and a later inbound echo
//! carrying the same `local_id` confirms it (README 不变量 2, F04, F08).
#![allow(clippy::unwrap_used)]

mod common;

use common::*;
use contracts::{
    ConversationStatus, MessageSource, MsgKind, ReconcileState, RoundEndReason, RoundEvent,
    SendDisposition, SenderRole, StreamCursor,
};
use core_im::{codes as im_codes, ImCore, MergeOutcome, ReconcileOutcome, SendState, StreamId};
use core_store::{FileStore, MemoryStore, Namespace, SendIntentRecord, SendIntentRepo, Store};

fn unknown_after_c1(h: &mut ImHarness) -> String {
    h.message(customer("c1", 10_000));
    h.events();
    let intent = h.core.create_send_intent(GID, 11_000).unwrap();
    h.core.mark_submitted(&intent.local_id).unwrap();
    h.core
        .apply_send_result(&intent.local_id, SendDisposition::Unknown)
        .unwrap();
    assert!(h.events().is_empty(), "unknown never emits a round event");
    intent.local_id
}

#[test]
fn unknown_survives_persist_and_restore_and_is_never_resendable() {
    let mut h = ImHarness::new();
    let lid = unknown_after_c1(&mut h);
    assert_eq!(h.core.outbox().unknown().count(), 1);
    assert_eq!(h.waiting().start_message_id.as_deref(), Some("c1"));

    // Crash + restart under the same generation.
    let state = h.core.persisted_state();
    assert_eq!(state.outbox.len(), 1);
    assert_eq!(state.outbox[0].state, SendState::Unknown);
    let restored = ImCore::restore(state.clone());
    assert_eq!(
        restored.outbox().get(&lid).unwrap().state,
        SendState::Unknown
    );
    assert_eq!(restored.outbox().unknown().count(), 1);
    assert!(restored.is_reconciling(), "restart is a reconcile barrier");
    assert!(
        restored.round_state(GID).is_pending(),
        "round is 待核对, not dropped"
    );

    // Restart under a re-authenticated generation of the same identity.
    let restored2 = ImCore::restore_as(state.clone(), acc(2)).unwrap();
    let e = restored2.outbox().get(&lid).unwrap();
    assert_eq!(e.state, SendState::Unknown);
    assert_eq!(
        e.intent.account,
        acc(2),
        "intent re-bound to the current generation"
    );
    // Another identity cannot adopt the snapshot.
    assert!(ImCore::restore_as(state.clone(), ctx("acc-b", "test", 2))
        .unwrap_err()
        .is(im_codes::IM_ACCOUNT_MISMATCH));
    assert!(ImCore::restore_as(state, acc(0))
        .unwrap_err()
        .is(contracts::codes::ACCOUNT_STALE_GENERATION));

    // No path back to a resend: re-submitting an unknown intent is refused
    // before and after the restart; read-back without evidence stays unknown.
    let mut h2 = ImHarness::from_core(restored);
    assert!(h2
        .core
        .mark_submitted(&lid)
        .unwrap_err()
        .is(im_codes::IM_INTENT_STATE));
    assert_eq!(
        h2.core.reconcile_unknown(&lid, &[]).unwrap(),
        ReconcileOutcome::StillUnknown
    );
    assert_eq!(h2.core.outbox().unknown().count(), 1);
    // A pending (never submitted) intent that was in flight at the crash is
    // unknown too, never pending again.
    let mut h3 = ImHarness::new();
    let i3 = h3.core.create_send_intent(GID, 1).unwrap();
    let st = h3.core.persisted_state();
    let r3 = ImCore::restore(st);
    assert_eq!(
        r3.outbox().get(&i3.local_id).unwrap().state,
        SendState::Unknown
    );
}

#[test]
fn inbound_echo_with_same_local_id_confirms_restored_unknown_and_ends_round() {
    let mut h = ImHarness::new();
    let lid = unknown_after_c1(&mut h);
    let mut h = ImHarness::from_core(ImCore::restore(h.core.persisted_state()));

    // Read-back after restart: conversation + history copy of c1, then the
    // server echo of our own message carrying our local id (回推先于 ACK).
    h.conversation(conv(ConversationStatus::Active, true, false));
    h.message(msg_in(
        GID,
        "c1",
        10_000,
        SenderRole::Customer,
        MessageSource::History,
    ));
    let mut echo = msg_in(
        GID,
        "t1",
        12_000,
        SenderRole::MerchantSelf,
        MessageSource::Realtime,
    );
    echo.local_id = Some(lid.clone());
    let rep = h.message(echo);
    assert_eq!(rep.message, Some(MergeOutcome::Inserted));
    let e = h.core.outbox().get(&lid).unwrap();
    assert_eq!(
        e.state,
        SendState::Confirmed {
            server_message_id: "t1".into(),
            server_time_ms: 12_000
        }
    );
    assert_eq!(h.core.outbox().unknown().count(), 0);
    // Still behind the restart barrier: no round decision yet.
    assert!(h.core.is_reconciling());
    assert!(h.events().iter().all(|e| matches!(
        e,
        RoundEvent::Started {
            start_confirmed: false,
            ..
        }
    )));

    h.core
        .resync_complete(StreamId::Message, StreamCursor::new(1, h.seq[0]));
    h.core
        .resync_complete(StreamId::Conversation, StreamCursor::new(1, h.seq[1]));
    assert_eq!(h.core.reconcile_state(), ReconcileState::Normal);
    assert!(
        h.core.round_state(GID).is_idle(),
        "c1 was answered by the confirmed echo"
    );
    assert_eq!(
        ended_reason(&h.events()),
        Some(RoundEndReason::MerchantReplyConfirmed)
    );

    // A later ACK (send_result) for the same intent is idempotent, a
    // conflicting one is refused, and a late Unknown never regresses.
    assert!(matches!(
        h.core
            .apply_send_result(
                &lid,
                SendDisposition::Confirmed {
                    server_message_id: "t1".into(),
                    server_time_ms: 12_000
                }
            )
            .unwrap(),
        SendState::Confirmed { .. }
    ));
    assert!(matches!(
        h.core
            .apply_send_result(&lid, SendDisposition::Unknown)
            .unwrap(),
        SendState::Confirmed { .. }
    ));
    assert!(h
        .core
        .apply_send_result(
            &lid,
            SendDisposition::Rejected {
                code: "E".into(),
                reason: "late".into()
            }
        )
        .unwrap_err()
        .is(im_codes::IM_INTENT_STATE));
    assert!(h.events().is_empty());
}

#[test]
fn server_echo_after_local_rejection_confirms_the_intent_in_outbox_and_index() {
    // SDK said "rejected" but the server echoes the message back with our
    // local id: the server accepted it. Outbox and index must agree
    // (dedup already lets evidence win), otherwise the UI offers a retry of
    // a message the customer already received (重复副作用).
    let mut h = ImHarness::new();
    h.message(customer("c1", 10_000));
    h.events();
    let intent = h.core.create_send_intent(GID, 11_000).unwrap();
    h.core.mark_submitted(&intent.local_id).unwrap();
    h.core
        .apply_send_result(
            &intent.local_id,
            SendDisposition::Rejected {
                code: "E-TIMEOUT".into(),
                reason: "sdk".into(),
            },
        )
        .unwrap();
    assert_eq!(h.waiting().start_message_id.as_deref(), Some("c1"));
    let mut echo = msg_in(
        GID,
        "t1",
        12_000,
        SenderRole::MerchantSelf,
        MessageSource::Realtime,
    );
    echo.local_id = Some(intent.local_id.clone());
    h.message(echo);
    let rec = h.core.index().find_by_message_id(GID, "t1").unwrap();
    assert!(rec.is_confirmed_merchant_reply());
    assert!(h.core.round_state(GID).is_idle());
    assert_eq!(
        h.core.outbox().get(&intent.local_id).unwrap().state,
        SendState::Confirmed {
            server_message_id: "t1".into(),
            server_time_ms: 12_000
        },
        "outbox must reflect the server evidence like the index does"
    );
    assert_eq!(h.core.outbox().unknown().count(), 0);
}

#[test]
fn store_reload_keeps_unknown_and_has_no_resend_state() {
    let ns = Namespace::from_context(&acc(1));
    let dir = std::env::temp_dir().join(format!("vbk-qa-send-unknown-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    {
        let store = FileStore::open(&dir).unwrap();
        let mut txn = store.begin(&ns).unwrap();
        let mut rec = SendIntentRecord::new("l1", GID, acc(1), 11_000);
        rec.frozen_round_id = Some(format!("{GID}:c1"));
        rec.customer_boundary_message_id = Some("c1".into());
        SendIntentRepo::put(&mut txn, &rec).unwrap();
        store.commit(txn).unwrap();
        // A record of another namespace cannot be smuggled into this txn.
        let mut txn = store.begin(&ns).unwrap();
        let foreign = SendIntentRecord::new("l2", GID, ctx("acc-b", "test", 1), 11_000);
        assert!(SendIntentRepo::put(&mut txn, &foreign)
            .unwrap_err()
            .is(core_store::codes::STORE_TXN_MISMATCH));
    }
    // "Restart": a fresh store handle over the same directory.
    let store = FileStore::open(&dir).unwrap();
    let all = SendIntentRepo::load_all(&store, &ns).unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].disposition, SendDisposition::Unknown);
    assert!(all[0].needs_reconciliation());
    assert_eq!(
        SendIntentRepo::unknown_intents(&store, &ns).unwrap().len(),
        1
    );
    let raw = store
        .get(&ns, "send_intents", "l1")
        .unwrap()
        .unwrap()
        .to_json();
    for forbidden in ["resend", "retry", "pending"] {
        assert!(
            !raw.contains(forbidden),
            "document must not encode a resend state: {raw}"
        );
    }
    // Unknown evidence never overwrites a definite disposition; a definite
    // one is CAS-guarded.
    let mut txn = store.begin(&ns).unwrap();
    let rec = SendIntentRepo::apply_disposition(
        &store,
        &mut txn,
        "l1",
        SendDisposition::Confirmed {
            server_message_id: "t1".into(),
            server_time_ms: 12_000,
        },
    )
    .unwrap();
    assert_eq!(rec.server_message_id.as_deref(), Some("t1"));
    store.commit(txn).unwrap();
    let mut txn = store.begin(&ns).unwrap();
    let rec = SendIntentRepo::apply_disposition(&store, &mut txn, "l1", SendDisposition::Unknown)
        .unwrap();
    assert!(rec.disposition.is_confirmed());
    assert!(txn.is_empty(), "late Unknown writes nothing");
    assert!(SendIntentRepo::unknown_intents(&store, &ns)
        .unwrap()
        .is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn store_unknown_record_is_not_mutated_by_loading_under_either_backend() {
    let ns = Namespace::from_context(&acc(1));
    let store = MemoryStore::new();
    let mut txn = store.begin(&ns).unwrap();
    SendIntentRepo::put(&mut txn, &SendIntentRecord::new("l1", GID, acc(1), 1)).unwrap();
    store.commit(txn).unwrap();
    let before = store.get(&ns, "send_intents", "l1").unwrap();
    for _ in 0..3 {
        let _ = SendIntentRepo::unknown_intents(&store, &ns).unwrap();
        let _ = SendIntentRepo::get(&store, &ns, "l1").unwrap();
    }
    assert_eq!(store.get(&ns, "send_intents", "l1").unwrap(), before);
    assert_eq!(
        store.last_commit(&ns).unwrap().unwrap().revision,
        1,
        "reads never commit"
    );
}

#[test]
fn own_unknown_message_in_index_is_never_a_confirmed_reply() {
    let mut h = ImHarness::new();
    let lid = unknown_after_c1(&mut h);
    let rec = h.core.index().find_by_local_id(GID, &lid).unwrap();
    assert_eq!(rec.kind, MsgKind::Business);
    assert_eq!(rec.disposition, Some(SendDisposition::Unknown));
    assert!(!rec.is_confirmed_merchant_reply());
    assert_eq!(h.waiting().start_message_id.as_deref(), Some("c1"));
}

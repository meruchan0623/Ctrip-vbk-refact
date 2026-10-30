//! Q10 — store: two namespaces never share records; `logout_lock` blocks
//! writes; a corrupt document is quarantined, never wiped; the complete
//! watermark moves only via `prove_complete`; CAS conflicts are detected
//! (dev 05-store, plan §2 invariants 3/5/6, F07/F08).
#![allow(clippy::unwrap_used)]

mod common;

use common::*;
use contracts::json::JsonValue;
use contracts::SendDisposition;
use core_store::{
    codes, DraftRepo, FileStore, MemoryStore, Namespace, PinnedRepo, ReminderStateRepo,
    RoundRecord, SendIntentRecord, SendIntentRepo, Store, SyncWatermarkRepo,
};

fn tmp(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("vbk-qa-store-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn round(gid: &str) -> RoundRecord {
    RoundRecord {
        gid: gid.into(),
        round_id: format!("{gid}:c1"),
        version: 1,
        start_message_id: Some("c1".into()),
        start_time_ms: Some(T0_SERVER),
        start_confirmed: true,
        reminded_version: 0,
        hidden_version: 0,
        snoozed_until_ms: None,
    }
}

#[test]
fn namespaces_are_isolated_on_disk_even_for_the_same_gid_and_similar_names() {
    let dir = tmp("ns");
    let store = FileStore::open(&dir).unwrap();
    let a = Namespace::from_context(&acc(1));
    let b = Namespace::from_context(&ctx("acc-b", "test", 1));
    let a_prod = Namespace::from_context(&ctx("acc-test", "production", 1));
    // Names that would collide after naive sanitising.
    let tricky1 = Namespace::from_context(&ctx("x/y", "test", 1));
    let tricky2 = Namespace::from_context(&ctx("x%2fy", "test", 1));
    let dot = Namespace::from_context(&ctx("..", "../../escape", 1));
    for (ns, text) in [
        (&a, "A"),
        (&b, "B"),
        (&a_prod, "P"),
        (&tricky1, "T1"),
        (&tricky2, "T2"),
        (&dot, "D"),
    ] {
        let mut txn = store.begin(ns).unwrap();
        ReminderStateRepo::put(&mut txn, &round(GID));
        DraftRepo::save_draft(&store, &mut txn, GID, text, 0).unwrap();
        PinnedRepo::set_pinned(&mut txn, GID, true);
        store.commit(txn).unwrap();
    }
    for (ns, text) in [
        (&a, "A"),
        (&b, "B"),
        (&a_prod, "P"),
        (&tricky1, "T1"),
        (&tricky2, "T2"),
        (&dot, "D"),
    ] {
        assert_eq!(
            DraftRepo::load(&store, ns, GID).unwrap().unwrap().text,
            text
        );
        assert_eq!(ReminderStateRepo::load_all(&store, ns).unwrap().len(), 1);
        assert_eq!(store.last_commit(ns).unwrap().unwrap().revision, 1);
        let d = store.namespace_dir(ns);
        assert!(d.starts_with(&dir), "{d:?} escaped the root");
    }
    // Deleting in one namespace leaves the others intact.
    let mut txn = store.begin(&a).unwrap();
    ReminderStateRepo::remove(&mut txn, GID, &format!("{GID}:c1"));
    DraftRepo::delete_draft(&store, &mut txn, GID, 1).unwrap();
    store.commit(txn).unwrap();
    assert!(ReminderStateRepo::load_all(&store, &a).unwrap().is_empty());
    assert_eq!(ReminderStateRepo::load_all(&store, &b).unwrap().len(), 1);
    assert_eq!(
        ReminderStateRepo::load_all(&store, &a_prod).unwrap().len(),
        1
    );
    assert!(PinnedRepo::is_pinned(&store, &b, GID).unwrap());
    // Dedup keys embed the namespace.
    assert_ne!(
        core_store::record_dedup_key(&a, GID, core_store::UpstreamScope::ServerMessage("m1")),
        core_store::record_dedup_key(&a_prod, GID, core_store::UpstreamScope::ServerMessage("m1"))
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn logout_lock_blocks_writes_but_keeps_data_readable_and_unlock_restores() {
    for backend in 0..2 {
        let dir = tmp(&format!("lock{backend}"));
        let store: Box<dyn Store> = if backend == 0 {
            Box::new(FileStore::open(&dir).unwrap())
        } else {
            Box::new(MemoryStore::new())
        };
        let ns = Namespace::from_context(&acc(1));
        let other = Namespace::from_context(&ctx("acc-b", "test", 1));
        let mut txn = store.begin(&ns).unwrap();
        SendIntentRepo::put(&mut txn, &SendIntentRecord::new("l1", GID, acc(1), 1)).unwrap();
        store.commit(txn).unwrap();
        // A transaction begun before the lock cannot commit after it.
        let mut late = store.begin(&ns).unwrap();
        ReminderStateRepo::put(&mut late, &round(GID));
        store.logout_lock(&ns).unwrap();
        assert!(store.is_locked(&ns).unwrap());
        assert!(store.commit(late).unwrap_err().is(codes::STORE_LOCKED));
        assert!(store.begin(&ns).unwrap_err().is(codes::STORE_LOCKED));
        // Reads work: unknown intents survive a logout for later reconcile.
        assert_eq!(
            SendIntentRepo::unknown_intents(store.as_ref(), &ns)
                .unwrap()
                .len(),
            1
        );
        assert!(ReminderStateRepo::load_all(store.as_ref(), &ns)
            .unwrap()
            .is_empty());
        // Another account is not locked.
        assert!(!store.is_locked(&other).unwrap());
        let mut txn = store.begin(&other).unwrap();
        ReminderStateRepo::put(&mut txn, &round(GID));
        store.commit(txn).unwrap();
        // Re-auth unlocks; data is still there.
        store.unlock_after_reauth(&ns).unwrap();
        assert!(!store.is_locked(&ns).unwrap());
        let mut txn = store.begin(&ns).unwrap();
        ReminderStateRepo::put(&mut txn, &round(GID));
        store.commit(txn).unwrap();
        assert_eq!(
            SendIntentRepo::load_all(store.as_ref(), &ns).unwrap().len(),
            1
        );
        assert_eq!(
            ReminderStateRepo::load_all(store.as_ref(), &ns)
                .unwrap()
                .len(),
            1
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[test]
fn corrupt_or_foreign_document_is_quarantined_not_wiped() {
    let dir = tmp("corrupt");
    let store = FileStore::open(&dir).unwrap();
    let ns = Namespace::from_context(&acc(1));
    let mut txn = store.begin(&ns).unwrap();
    ReminderStateRepo::put(&mut txn, &round(GID));
    store.commit(txn).unwrap();
    let state = store.namespace_dir(&ns).join("state.json");
    let good = std::fs::read_to_string(&state).unwrap();

    // 1. Truncated JSON.
    std::fs::write(&state, &good[..good.len() / 2]).unwrap();
    let e = store.get(&ns, "rounds", "x").unwrap_err();
    assert!(e.is(codes::STORE_CORRUPT));
    assert!(!state.exists(), "moved aside");
    let q = store.quarantined_files(&ns).unwrap();
    assert_eq!(q.len(), 1);
    assert_eq!(
        std::fs::read_to_string(&q[0]).unwrap(),
        &good[..good.len() / 2],
        "evidence kept byte for byte"
    );
    // Every access stays refused until the host acknowledges.
    assert!(store.begin(&ns).unwrap_err().is(codes::STORE_CORRUPT));
    assert!(store
        .list(&ns, "rounds")
        .unwrap_err()
        .is(codes::STORE_CORRUPT));
    assert!(store.last_commit(&ns).unwrap_err().is(codes::STORE_CORRUPT));
    // Other namespaces are unaffected.
    let other = Namespace::from_context(&ctx("acc-b", "test", 1));
    assert!(store.begin(&other).is_ok());
    let acked = store.acknowledge_corruption(&ns).unwrap();
    assert_eq!(acked.len(), 1);
    assert!(
        acked[0].exists(),
        "acknowledging never deletes the evidence"
    );
    assert!(
        ReminderStateRepo::load_all(&store, &ns).unwrap().is_empty(),
        "starts empty"
    );

    // 2. A valid document of *another* identity copied into this directory
    //    (F08 backup mix-up) is rejected the same way.
    let mut txn = store.begin(&ns).unwrap();
    ReminderStateRepo::put(&mut txn, &round(GID));
    store.commit(txn).unwrap();
    let mut doc = JsonValue::parse(&std::fs::read_to_string(&state).unwrap()).unwrap();
    let mut meta = doc.get("meta").cloned().unwrap();
    meta.insert("account_id", JsonValue::string("acc-b"));
    doc.insert("meta", meta);
    std::fs::write(&state, doc.to_json()).unwrap();
    let e = store.get(&ns, "rounds", "x").unwrap_err();
    assert!(e.is(codes::STORE_CORRUPT));
    assert!(e
        .detail
        .as_deref()
        .unwrap_or("")
        .contains("identity mismatch"));
    assert_eq!(store.quarantined_files(&ns).unwrap().len(), 2);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn complete_watermark_only_moves_through_prove_complete() {
    let store = MemoryStore::new();
    let ns = Namespace::from_context(&acc(1));
    let mut txn = store.begin(&ns).unwrap();
    let w = SyncWatermarkRepo::set_page_breakpoint(&store, &mut txn, GID, 5_000).unwrap();
    assert_eq!(w.complete_watermark_ms, None);
    SyncWatermarkRepo::set_conversation_cursor(&mut txn, 9_000);
    SyncWatermarkRepo::set_compensation_cursor(&mut txn, 8_000);
    store.commit(txn).unwrap();
    for bp in [4_000, 3_000, 9_999] {
        let mut txn = store.begin(&ns).unwrap();
        let w = SyncWatermarkRepo::set_page_breakpoint(&store, &mut txn, GID, bp).unwrap();
        store.commit(txn).unwrap();
        assert_eq!(w.page_breakpoint_ms, Some(bp));
        assert_eq!(
            w.complete_watermark_ms, None,
            "pages never imply completeness"
        );
    }
    // The cursors are separate chains.
    assert_eq!(
        SyncWatermarkRepo::conversation_cursor(&store, &ns).unwrap(),
        Some(9_000)
    );
    assert_eq!(
        SyncWatermarkRepo::compensation_cursor(&store, &ns).unwrap(),
        Some(8_000)
    );
    let mut txn = store.begin(&ns).unwrap();
    let w = SyncWatermarkRepo::prove_complete(&store, &mut txn, GID, 3_000).unwrap();
    store.commit(txn).unwrap();
    assert_eq!(w.complete_watermark_ms, Some(3_000));
    assert_eq!(w.page_breakpoint_ms, Some(9_999), "breakpoint preserved");
    // Same rule in core-im: `isDone == false` never advances.
    let mut h = ImHarness::new();
    h.core.note_history_page(GID, 2_000, Some(2_000));
    assert!(!h.core.prove_history_complete(GID, false, 1_000));
    assert!(!h.core.watermarks().history(GID).unwrap().is_complete());
    assert!(h.core.prove_history_complete(GID, true, 1_000));
    assert_eq!(
        h.core
            .watermarks()
            .history(GID)
            .unwrap()
            .complete_watermark_ms,
        Some(1_000)
    );
    // Another gid is untouched.
    assert!(SyncWatermarkRepo::history(&store, &ns, GID2)
        .unwrap()
        .complete_watermark_ms
        .is_none());
}

#[test]
fn cas_conflicts_are_detected_at_commit_for_drafts_and_intents() {
    let store = MemoryStore::new();
    let ns = Namespace::from_context(&acc(1));
    // Draft: two editors read version 0; the second commit loses.
    let mut t1 = store.begin(&ns).unwrap();
    let mut t2 = store.begin(&ns).unwrap();
    assert_eq!(
        DraftRepo::save_draft(&store, &mut t1, GID, "first", 0).unwrap(),
        1
    );
    assert_eq!(
        DraftRepo::save_draft(&store, &mut t2, GID, "second", 0).unwrap(),
        1
    );
    store.commit(t1).unwrap();
    assert!(store.commit(t2).unwrap_err().is(codes::STORE_CAS_CONFLICT));
    assert_eq!(
        DraftRepo::load(&store, &ns, GID).unwrap().unwrap().text,
        "first"
    );
    // A stale expected_version is refused up front (late translation result).
    let mut t3 = store.begin(&ns).unwrap();
    assert!(DraftRepo::save_draft(&store, &mut t3, GID, "late", 0)
        .unwrap_err()
        .is(codes::STORE_CAS_CONFLICT));
    assert!(DraftRepo::delete_draft(&store, &mut t3, GID, 0)
        .unwrap_err()
        .is(codes::STORE_CAS_CONFLICT));
    // Send intent: an ACK and a rejection racing on the same intent.
    let mut t = store.begin(&ns).unwrap();
    SendIntentRepo::put(&mut t, &SendIntentRecord::new("l1", GID, acc(1), 1)).unwrap();
    store.commit(t).unwrap();
    let mut ta = store.begin(&ns).unwrap();
    let mut tb = store.begin(&ns).unwrap();
    SendIntentRepo::apply_disposition(
        &store,
        &mut ta,
        "l1",
        SendDisposition::Confirmed {
            server_message_id: "t1".into(),
            server_time_ms: 2,
        },
    )
    .unwrap();
    SendIntentRepo::apply_disposition(
        &store,
        &mut tb,
        "l1",
        SendDisposition::Rejected {
            code: "E".into(),
            reason: "r".into(),
        },
    )
    .unwrap();
    store.commit(ta).unwrap();
    assert!(store.commit(tb).unwrap_err().is(codes::STORE_CAS_CONFLICT));
    assert!(SendIntentRepo::get(&store, &ns, "l1")
        .unwrap()
        .unwrap()
        .disposition
        .is_confirmed());
    // Transactions cannot cross stores.
    let other_store = MemoryStore::new();
    let txn = store.begin(&ns).unwrap();
    assert!(other_store
        .commit(txn)
        .unwrap_err()
        .is(codes::STORE_TXN_MISMATCH));
}

#[test]
fn nothing_is_visible_before_commit_and_an_io_failure_is_not_corruption() {
    let dir = tmp("commit");
    let store = FileStore::open(&dir).unwrap();
    let ns = Namespace::from_context(&acc(1));
    let mut txn = store.begin(&ns).unwrap();
    ReminderStateRepo::put(&mut txn, &round(GID));
    assert!(ReminderStateRepo::load_all(&store, &ns).unwrap().is_empty());
    assert!(store.last_commit(&ns).unwrap().is_none());
    let fact = store.commit(txn).unwrap();
    assert_eq!(fact.revision, 1);
    assert_eq!(ReminderStateRepo::load_all(&store, &ns).unwrap().len(), 1);
    // A namespace directory that is a file: IO error, nothing quarantined.
    let bad = Namespace::from_context(&ctx("acc-file", "test", 1));
    let d = store.namespace_dir(&bad);
    std::fs::create_dir_all(d.parent().unwrap()).unwrap();
    std::fs::write(&d, b"not a dir").unwrap();
    let e = store.begin(&bad).unwrap_err();
    assert!(e.is(codes::STORE_IO), "{e:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

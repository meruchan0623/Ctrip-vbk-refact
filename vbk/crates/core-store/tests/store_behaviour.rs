//! Store invariants through the public API (DAT-01 / DAT-02 / 05-store).

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use contracts::json::JsonValue;
use contracts::{AccountContext, AccountId, Environment, SendDisposition};
use core_store::{
    codes, DraftRepo, FileStore, MemoryStore, Namespace, PinnedRepo, ReconcileEvidence,
    ReminderStateRepo, RoundRecord, SendIntentRecord, SendIntentRepo, Store, SyncWatermarkRepo,
};

static DIR_SEQ: AtomicU64 = AtomicU64::new(1);

/// Unique temp dir, removed on drop.
struct TempRoot(PathBuf);

impl TempRoot {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "core-store-test-{}-{}-{}",
            std::process::id(),
            DIR_SEQ.fetch_add(1, Ordering::Relaxed),
            tag
        ));
        let _ = fs::remove_dir_all(&dir);
        Self(dir)
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn ns(account: &str) -> Namespace {
    Namespace::new(Environment::named("test-env"), AccountId::new(account))
}

fn ctx(account: &str, generation: u64) -> AccountContext {
    AccountContext::new(AccountId::new(account), Environment::named("test-env"), generation)
}

fn round(gid: &str, round_id: &str) -> RoundRecord {
    RoundRecord {
        gid: gid.into(),
        round_id: round_id.into(),
        version: 1,
        start_message_id: Some("m-1".into()),
        start_time_ms: Some(1_700_000_000_000),
        start_confirmed: true,
        reminded_version: 0,
        hidden_version: 0,
        snoozed_until_ms: None,
    }
}

/// Runs the same scenario against both backends.
fn both(tag: &str, scenario: impl Fn(&dyn Store)) {
    let mem = MemoryStore::new();
    scenario(&mem);
    let root = TempRoot::new(tag);
    let file = FileStore::open(&root.0).expect("open");
    scenario(&file);
}

#[test]
fn uncommitted_transaction_is_invisible_until_commit() {
    both("commit-before-publish", |store| {
        let ns = ns("acc_1");
        let mut txn = store.begin(&ns).expect("begin");
        ReminderStateRepo::put(&mut txn, &round("g1", "r1"));
        PinnedRepo::set_pinned(&mut txn, "g1", true);
        assert!(!txn.is_empty());

        // Nothing visible, no commit fact yet.
        assert!(ReminderStateRepo::get(store, &ns, "g1", "r1").expect("get").is_none());
        assert!(!PinnedRepo::is_pinned(store, &ns, "g1").expect("pinned"));
        assert_eq!(store.last_commit(&ns).expect("fact"), None);

        let fact = store.commit(txn).expect("commit");
        assert_eq!(fact.revision, 1);
        assert!(fact.committed_at_ms > 0);
        assert_eq!(store.last_commit(&ns).expect("fact"), Some(fact));
        assert!(PinnedRepo::is_pinned(store, &ns, "g1").expect("pinned"));
        let loaded = ReminderStateRepo::load_all(store, &ns).expect("load");
        assert_eq!(loaded.len(), 1);

        // A dropped transaction publishes nothing.
        let mut dropped = store.begin(&ns).expect("begin");
        ReminderStateRepo::put(&mut dropped, &round("g2", "r9"));
        drop(dropped);
        assert_eq!(ReminderStateRepo::load_all(store, &ns).expect("load").len(), 1);
        assert_eq!(store.last_commit(&ns).expect("fact").map(|f| f.revision), Some(1));
    });
}

#[test]
fn load_all_returns_pending_verification_that_needs_evidence() {
    both("pending-verification", |store| {
        let ns = ns("acc_1");
        let mut txn = store.begin(&ns).expect("begin");
        ReminderStateRepo::put(&mut txn, &round("g1", "r1"));
        store.commit(txn).expect("commit");

        let pending = ReminderStateRepo::load_all(store, &ns).expect("load");
        assert_eq!(pending.len(), 1);
        let e = pending
            .reconcile(ReconcileEvidence {
                compensation_complete: true,
                conversation_readback_complete: false,
            })
            .expect_err("incomplete evidence");
        assert!(e.is(codes::STORE_NOT_RECONCILED));

        let pending = ReminderStateRepo::load_all(store, &ns).expect("load");
        let rounds = pending.reconcile(ReconcileEvidence::complete()).expect("reconciled");
        assert_eq!(rounds, vec![round("g1", "r1")]);
    });
}

#[test]
fn file_store_atomic_rename_survives_partial_temp_write() {
    let root = TempRoot::new("atomic");
    let store = FileStore::open(&root.0).expect("open");
    let ns = ns("acc_1");
    let mut txn = store.begin(&ns).expect("begin");
    ReminderStateRepo::put(&mut txn, &round("g1", "r1"));
    store.commit(txn).expect("commit");

    let dir = store.namespace_dir(&ns);
    assert!(dir.join("state.json").exists());
    assert!(fs::read_dir(&dir)
        .expect("dir")
        .all(|e| !e.expect("entry").file_name().to_string_lossy().contains(".tmp-")));

    // Simulate a crash in the middle of the next write: a truncated temp
    // file sits next to the intact document.
    fs::write(dir.join("state.json.tmp-deadbeef"), b"{\"meta\":{\"environment\":\"test-").expect("partial");
    let loaded = ReminderStateRepo::load_all(&store, &ns).expect("intact document still loads");
    assert_eq!(loaded.len(), 1);

    // The next commit replaces the document and clears the stale temp file.
    let mut txn = store.begin(&ns).expect("begin");
    ReminderStateRepo::put(&mut txn, &round("g2", "r2"));
    let fact = store.commit(txn).expect("commit");
    assert_eq!(fact.revision, 2);
    assert!(!dir.join("state.json.tmp-deadbeef").exists());
    let reopened = FileStore::open(&root.0).expect("reopen");
    assert_eq!(ReminderStateRepo::load_all(&reopened, &ns).expect("load").len(), 2);
}

#[test]
fn corrupt_document_is_quarantined_and_reported_not_wiped() {
    let root = TempRoot::new("corrupt");
    let store = FileStore::open(&root.0).expect("open");
    let ns = ns("acc_1");
    let mut txn = store.begin(&ns).expect("begin");
    ReminderStateRepo::put(&mut txn, &round("g1", "r1"));
    store.commit(txn).expect("commit");
    let dir = store.namespace_dir(&ns);
    fs::write(dir.join("state.json"), b"{ this is not json").expect("corrupt");

    let e = ReminderStateRepo::load_all(&store, &ns).expect_err("corrupt");
    assert!(e.is(codes::STORE_CORRUPT), "{e}");
    let quarantined = store.quarantined_files(&ns).expect("list");
    assert_eq!(quarantined.len(), 1);
    assert!(quarantined[0]
        .file_name()
        .expect("name")
        .to_string_lossy()
        .starts_with("state.json.corrupt-"));
    assert_eq!(fs::read(&quarantined[0]).expect("evidence"), b"{ this is not json");
    assert!(!dir.join("state.json").exists());

    // Still blocked (reads and writes) until the host acknowledges.
    assert!(store.begin(&ns).expect_err("blocked").is(codes::STORE_CORRUPT));
    assert!(store.get(&ns, "rounds", "x").expect_err("blocked").is(codes::STORE_CORRUPT));
    let acked = store.acknowledge_corruption(&ns).expect("ack");
    assert_eq!(acked, quarantined);
    assert!(quarantined[0].exists(), "evidence is never deleted here");
    assert_eq!(ReminderStateRepo::load_all(&store, &ns).expect("fresh").len(), 0);

    // A document carrying another account's identity is corrupt too.
    let other = Namespace::new(Environment::named("test-env"), AccountId::new("acc_2"));
    let mut txn = store.begin(&other).expect("begin");
    PinnedRepo::set_pinned(&mut txn, "g1", true);
    store.commit(txn).expect("commit");
    fs::copy(store.namespace_dir(&other).join("state.json"), dir.join("state.json")).expect("copy");
    let e = store.begin(&ns).expect_err("identity mismatch");
    assert!(e.is(codes::STORE_CORRUPT));
    assert!(e.detail.as_deref().unwrap_or("").contains("identity mismatch"));
    assert_eq!(store.quarantined_files(&ns).expect("list").len(), 2);
}

#[test]
fn io_error_is_store_io_not_corrupt() {
    let root = TempRoot::new("io");
    let store = FileStore::open(&root.0).expect("open");
    let ns = ns("acc_1");
    // Make the namespace directory path a file so the write cannot succeed.
    let dir = store.namespace_dir(&ns);
    fs::create_dir_all(dir.parent().expect("parent")).expect("mkdir");
    fs::write(&dir, b"not a directory").expect("file");
    let e = store.begin(&ns).expect_err("cannot read dir");
    assert!(e.is(codes::STORE_IO), "{e}");
}

#[test]
fn logout_lock_blocks_writes_but_keeps_data_and_files() {
    both("logout-lock", |store| {
        let ns = ns("acc_1");
        let mut txn = store.begin(&ns).expect("begin");
        ReminderStateRepo::put(&mut txn, &round("g1", "r1"));
        DraftRepo::save_draft(store, &mut txn, "g1", "draft text", 0).expect("draft");
        store.commit(txn).expect("commit");

        store.logout_lock(&ns).expect("lock");
        assert!(store.is_locked(&ns).expect("locked"));
        assert!(store.begin(&ns).expect_err("locked").is(codes::STORE_LOCKED));

        // Reads still work; data is intact.
        assert_eq!(ReminderStateRepo::load_all(store, &ns).expect("load").len(), 1);
        assert_eq!(
            DraftRepo::load(store, &ns, "g1").expect("draft").map(|d| d.text),
            Some("draft text".to_string())
        );

        // A transaction begun before the lock cannot commit either.
        store.unlock_after_reauth(&ns).expect("unlock");
        let mut early = store.begin(&ns).expect("begin");
        PinnedRepo::set_pinned(&mut early, "g1", true);
        store.logout_lock(&ns).expect("lock");
        assert!(store.commit(early).expect_err("locked").is(codes::STORE_LOCKED));
        assert!(!PinnedRepo::is_pinned(store, &ns, "g1").expect("pinned"));

        store.unlock_after_reauth(&ns).expect("unlock");
        assert!(!store.is_locked(&ns).expect("locked"));
        let mut txn = store.begin(&ns).expect("begin after re-auth");
        PinnedRepo::set_pinned(&mut txn, "g1", true);
        store.commit(txn).expect("commit");
    });

    // On disk the files are still there while locked.
    let root = TempRoot::new("logout-lock-files");
    let store = FileStore::open(&root.0).expect("open");
    let ns = ns("acc_1");
    let mut txn = store.begin(&ns).expect("begin");
    ReminderStateRepo::put(&mut txn, &round("g1", "r1"));
    store.commit(txn).expect("commit");
    store.logout_lock(&ns).expect("lock");
    let dir = store.namespace_dir(&ns);
    assert!(dir.join("state.json").exists());
    assert!(dir.join("logout.lock").exists());
    let reopened = FileStore::open(&root.0).expect("reopen");
    assert!(reopened.is_locked(&ns).expect("persisted lock"));
}

#[test]
fn unknown_send_intent_survives_reload_and_is_never_marked_resend() {
    let root = TempRoot::new("unknown-intent");
    let ns = ns("acc_1");
    {
        let store = FileStore::open(&root.0).expect("open");
        let mut txn = store.begin(&ns).expect("begin");
        let mut intent = SendIntentRecord::new("local-1", "g1", ctx("acc_1", 3), 1_700_000_000_000);
        intent.frozen_round_id = Some("r1".into());
        intent.customer_boundary_message_id = Some("m-7".into());
        SendIntentRepo::put(&mut txn, &intent).expect("put");
        let confirmed = SendIntentRecord::new("local-2", "g1", ctx("acc_1", 3), 1_700_000_000_001);
        SendIntentRepo::put(&mut txn, &confirmed).expect("put");
        store.commit(txn).expect("commit");

        let mut txn = store.begin(&ns).expect("begin");
        SendIntentRepo::apply_disposition(
            &store,
            &mut txn,
            "local-2",
            SendDisposition::Confirmed {
                server_message_id: "srv-2".into(),
                server_time_ms: 1_700_000_000_500,
            },
        )
        .expect("evidence");
        store.commit(txn).expect("commit");

        // An intent from another namespace is refused.
        let mut txn = store.begin(&ns).expect("begin");
        let foreign = SendIntentRecord::new("local-x", "g1", ctx("acc_2", 1), 1);
        assert!(SendIntentRepo::put(&mut txn, &foreign).is_err());
    }

    // "Restart": a fresh store instance over the same root.
    let store = FileStore::open(&root.0).expect("reopen");
    let all = SendIntentRepo::load_all(&store, &ns).expect("load");
    assert_eq!(all.len(), 2);
    let unknown = SendIntentRepo::unknown_intents(&store, &ns).expect("unknown");
    assert_eq!(unknown.len(), 1);
    assert_eq!(unknown[0].local_id, "local-1");
    assert_eq!(unknown[0].disposition, SendDisposition::Unknown);
    assert!(unknown[0].needs_reconciliation());
    assert_eq!(unknown[0].account, ctx("acc_1", 3), "generation is kept for stale checks");
    assert_eq!(unknown[0].frozen_round_id.as_deref(), Some("r1"));
    assert_eq!(unknown[0].customer_boundary_message_id.as_deref(), Some("m-7"));
    // Loading changed nothing on disk.
    assert_eq!(store.last_commit(&ns).expect("fact").map(|f| f.revision), Some(2));

    // Later "unknown" evidence never downgrades a confirmed intent.
    let mut txn = store.begin(&ns).expect("begin");
    let rec = SendIntentRepo::apply_disposition(&store, &mut txn, "local-2", SendDisposition::Unknown).expect("noop");
    assert!(rec.disposition.is_confirmed());
    assert_eq!(rec.server_message_id.as_deref(), Some("srv-2"));
}

#[test]
fn draft_cas_conflict_rejects_stale_writer() {
    both("draft-cas", |store| {
        let ns = ns("acc_1");
        let mut txn = store.begin(&ns).expect("begin");
        let v1 = DraftRepo::save_draft(store, &mut txn, "g1", "hello", 0).expect("save");
        assert_eq!(v1, 1);
        store.commit(txn).expect("commit");

        // Two writers read version 1; the first commits.
        let mut a = store.begin(&ns).expect("begin");
        let v2 = DraftRepo::save_draft(store, &mut a, "g1", "hello world", 1).expect("save a");
        assert_eq!(v2, 2);
        let mut b = store.begin(&ns).expect("begin");
        DraftRepo::save_draft(store, &mut b, "g1", "late translation", 1).expect("prepared before a committed");
        store.commit(a).expect("commit a");
        let e = store.commit(b).expect_err("stale");
        assert!(e.is(codes::STORE_CAS_CONFLICT));
        assert_eq!(
            DraftRepo::load(store, &ns, "g1").expect("load").map(|d| (d.text, d.version)),
            Some(("hello world".to_string(), 2))
        );

        // And a writer that reads after the commit sees the conflict immediately.
        let mut c = store.begin(&ns).expect("begin");
        let e = DraftRepo::save_draft(store, &mut c, "g1", "old", 1).expect_err("stale");
        assert!(e.is(codes::STORE_CAS_CONFLICT));
        assert!(c.is_empty());
    });
}

#[test]
fn complete_watermark_only_moves_with_prove_complete() {
    both("watermark", |store| {
        let ns = ns("acc_1");
        let mut txn = store.begin(&ns).expect("begin");
        SyncWatermarkRepo::set_conversation_cursor(&mut txn, 1_000);
        SyncWatermarkRepo::set_compensation_cursor(&mut txn, 2_000);
        SyncWatermarkRepo::set_page_breakpoint(store, &mut txn, "g1", 900).expect("page");
        store.commit(txn).expect("commit");

        let wm = SyncWatermarkRepo::history(store, &ns, "g1").expect("wm");
        assert_eq!(wm.page_breakpoint_ms, Some(900));
        assert_eq!(wm.complete_watermark_ms, None, "a page never implies completeness");

        let mut txn = store.begin(&ns).expect("begin");
        SyncWatermarkRepo::set_page_breakpoint(store, &mut txn, "g1", 800).expect("page");
        store.commit(txn).expect("commit");
        let wm = SyncWatermarkRepo::history(store, &ns, "g1").expect("wm");
        assert_eq!(wm.page_breakpoint_ms, Some(800));
        assert_eq!(wm.complete_watermark_ms, None);

        let mut txn = store.begin(&ns).expect("begin");
        SyncWatermarkRepo::prove_complete(store, &mut txn, "g1", 800).expect("prove");
        store.commit(txn).expect("commit");
        let wm = SyncWatermarkRepo::history(store, &ns, "g1").expect("wm");
        assert_eq!(wm.page_breakpoint_ms, Some(800), "breakpoint preserved");
        assert_eq!(wm.complete_watermark_ms, Some(800));

        assert_eq!(SyncWatermarkRepo::conversation_cursor(store, &ns).expect("c"), Some(1_000));
        assert_eq!(SyncWatermarkRepo::compensation_cursor(store, &ns).expect("c"), Some(2_000));
        assert_eq!(SyncWatermarkRepo::history(store, &ns, "g-other").expect("wm"), Default::default());
    });
}

#[test]
fn two_namespaces_are_isolated_on_disk() {
    let root = TempRoot::new("isolation");
    let store = FileStore::open(&root.0).expect("open");
    let a = ns("acc_a");
    let b = ns("acc_b");
    let b_other_env = Namespace::new(Environment::named("other-env"), AccountId::new("acc_b"));

    let mut txn = store.begin(&a).expect("begin");
    DraftRepo::save_draft(&store, &mut txn, "g1", "A's draft", 0).expect("draft");
    store.commit(txn).expect("commit");
    let mut txn = store.begin(&b).expect("begin");
    DraftRepo::save_draft(&store, &mut txn, "g1", "B's draft", 0).expect("draft");
    store.commit(txn).expect("commit");
    let mut txn = store.begin(&b_other_env).expect("begin");
    DraftRepo::save_draft(&store, &mut txn, "g1", "B other env", 0).expect("draft");
    store.commit(txn).expect("commit");

    let dirs = [store.namespace_dir(&a), store.namespace_dir(&b), store.namespace_dir(&b_other_env)];
    assert_ne!(dirs[0], dirs[1]);
    assert_ne!(dirs[1], dirs[2]);
    for d in &dirs {
        assert!(d.starts_with(&root.0));
        assert!(d.join("state.json").exists());
    }
    assert_eq!(DraftRepo::load(&store, &a, "g1").expect("a").map(|d| d.text), Some("A's draft".into()));
    assert_eq!(DraftRepo::load(&store, &b, "g1").expect("b").map(|d| d.text), Some("B's draft".into()));
    assert_eq!(
        DraftRepo::load(&store, &b_other_env, "g1").expect("b2").map(|d| d.text),
        Some("B other env".into())
    );

    // Locking / corrupting one namespace does not touch the other.
    store.logout_lock(&a).expect("lock");
    assert!(!store.is_locked(&b).expect("b unlocked"));
    fs::write(dirs[1].join("state.json"), b"garbage").expect("corrupt b");
    assert!(DraftRepo::load(&store, &b, "g1").is_err());
    assert_eq!(
        DraftRepo::load(&store, &b_other_env, "g1").expect("b2").map(|d| d.version),
        Some(1)
    );
    // The on-disk document contains nothing credential-like.
    let text = fs::read_to_string(dirs[0].join("state.json")).expect("read");
    assert!(!core_store::looks_secret_like(&text));
    let doc = JsonValue::parse(&text).expect("json");
    assert_eq!(doc.path("meta.account_id").and_then(JsonValue::as_str), Some("acc_a"));
}

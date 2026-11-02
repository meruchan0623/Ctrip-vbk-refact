//! Fault models for the durable write path (I-04a acceptance 3 / I-25
//! acceptance 2). One fixture serves both items.
//!
//! * Model A, process termination at the three `file.rs` fail points. Run
//!   two ways: in-process `FaultAction::Crash` (a dead writer's leftovers,
//!   with a concurrent second namespace) and a real `abort()` of a child
//!   process (`child_writer`), read back by the parent.
//! * Model B, filesystem errors (`ENOSPC` / `EACCES` / `EROFS`).
//! * Model C, power loss: a property test over a simulated filesystem whose
//!   write sequence is cut at every prefix, with adversarial persistence.
//!
//! Iteration counts are small by default so `cargo test` stays fast; set
//! `VBK_FAULT_ITER` to scale (the plan's platform runs use >= 300 per point).
//! Platform coverage (APFS / NTFS / ReFS) is **not** exercised here.

#![allow(clippy::unwrap_used)]

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use contracts::json::JsonValue;
use contracts::{AccountId, Environment};
use core_store::hooks::{self, FailPoint, FaultAction, FsyncKind, FsyncProbe};
use core_store::{
    codes, write_atomic, FileStore, JobPayload, MemoryStore, Namespace, PersistJob, PersistQueue,
    PersistTracker, ReminderStateRepo, RoundRecord, Store, SyncWatermarkRepo, PERSIST_THREAD,
};

static DIR_SEQ: AtomicU64 = AtomicU64::new(1);

struct TempRoot(PathBuf);

impl TempRoot {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "core-store-fault-{}-{}-{}",
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
    Namespace::new(Environment::named("fault"), AccountId::new(account))
}

fn iterations(default: usize) -> usize {
    std::env::var("VBK_FAULT_ITER")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn round(version: u64) -> RoundRecord {
    RoundRecord {
        gid: "g".into(),
        round_id: "r".into(),
        version,
        start_message_id: None,
        start_time_ms: Some(1),
        start_confirmed: true,
        reminded_version: version,
        hidden_version: 0,
        snoozed_until_ms: None,
    }
}

fn commit_value(store: &FileStore, n: &Namespace, v: u64) -> Result<(), contracts::AppError> {
    let mut txn = store.begin(n)?;
    txn.put("c", "k", JsonValue::string(format!("v{v}")));
    store.commit(txn).map(|_| ())
}

/// Reads `(revision, value)` back and checks they agree: a document is
/// either wholly the old or wholly the new one.
fn read_back(store: &FileStore, n: &Namespace) -> (u64, Option<String>) {
    let rev = store
        .last_commit(n)
        .expect("document must load (never unreadable)")
        .map_or(0, |f| f.revision);
    let val = store
        .get(n, "c", "k")
        .expect("get")
        .and_then(|v| v.as_str().map(str::to_string));
    match (&val, rev) {
        (None, 0) => {}
        (Some(v), r) => assert_eq!(v, &format!("v{r}"), "value and revision must be one commit"),
        (None, r) => panic!("revision {r} without value"),
    }
    (rev, val)
}

fn stray_tmp_files(dir: &Path) -> usize {
    fn walk(p: &Path, n: &mut usize) {
        if let Ok(rd) = fs::read_dir(p) {
            for e in rd.flatten() {
                let path = e.path();
                if path.is_dir() {
                    walk(&path, n);
                } else if e
                    .file_name()
                    .to_str()
                    .is_some_and(|f| f.starts_with("state.json.tmp-"))
                {
                    *n += 1;
                }
            }
        }
    }
    let mut n = 0;
    walk(dir, &mut n);
    n
}

// ----------------------------------------------------------------- model A

#[test]
fn model_a_in_process_crash_single_namespace_is_exact() {
    for point in FailPoint::MODEL_A {
        for i in 0..iterations(40) {
            let root = TempRoot::new("a1");
            let store = FileStore::open(&root.0).unwrap();
            let n = ns("a");
            let done = i % 5; // commits that complete before the "kill"
            for v in 1..=done as u64 {
                commit_value(&store, &n, v).unwrap();
            }
            let _fault = hooks::inject(&root.0, point, FaultAction::Crash, 0, Some(1));
            let died = commit_value(&store, &n, done as u64 + 1);
            assert!(died.is_err(), "crash must surface as an error");
            drop(_fault);

            // "Restart": a fresh store object over the same directory.
            let reopened = FileStore::open(&root.0).unwrap();
            let (rev, _) = read_back(&reopened, &n);
            let expected = match point {
                // rename already happened: the new document is in place.
                FailPoint::BeforeSyncDir => done as u64 + 1,
                _ => done as u64,
            };
            assert_eq!(rev, expected, "{point:?} i={i}");
            // A crash before the rename leaves its temp file; the next save
            // removes it.
            if point != FailPoint::BeforeSyncDir {
                assert!(stray_tmp_files(&root.0) >= 1, "crash leaves tmp, {point:?}");
            }
            commit_value(&reopened, &n, expected + 1).unwrap();
            assert_eq!(stray_tmp_files(&root.0), 0, "next save cleans tmp");
            assert_eq!(read_back(&reopened, &n).0, expected + 1);
        }
    }
}

#[test]
fn model_a_crash_during_concurrent_two_namespace_queue_writes() {
    for point in FailPoint::MODEL_A {
        for i in 0..iterations(15) {
            let root = TempRoot::new("a2");
            let store = Arc::new(FileStore::open(&root.0).unwrap());
            let (a, b) = (ns("a"), ns("b"));
            let q = PersistQueue::spawn(store.clone()).unwrap();
            let mut tracker = PersistTracker::new();
            let mut last_seq: BTreeMap<Namespace, u64> = BTreeMap::new();

            // Fire on the (i%4)-th write to this root.
            let fault = hooks::inject(&root.0, point, FaultAction::Crash, i % 4, Some(1));
            for round_no in 1..=20u64 {
                for n in [&a, &b] {
                    let job = PersistJob {
                        ns: n.clone(),
                        seq: q.next_seq(),
                        payload: JobPayload::Rounds(vec![round(round_no)]),
                    };
                    last_seq.insert(n.clone(), job.seq);
                    assert!(q.submit(vec![job]).is_empty());
                }
                q.flush(Duration::from_secs(10)).unwrap();
                tracker.apply_receipts(q.drain_receipts());
                // Retry parked work like the host tick does.
                let again = tracker.take_pending();
                assert!(q.submit(again).is_empty());
            }
            q.flush(Duration::from_secs(10)).unwrap();
            tracker.apply_receipts(q.drain_receipts());
            drop(fault);
            drop(q);

            // Restart: every namespace loads, every record decodes.
            let reopened = FileStore::open(&root.0).unwrap();
            for n in [&a, &b] {
                let recs = ReminderStateRepo::load_all(&reopened, n)
                    .expect("load")
                    .reconcile(core_store::ReconcileEvidence::complete())
                    .unwrap();
                assert!(recs.len() <= 1);
                let (r, _) = PersistQueue::persisted_seq(&reopened, n).unwrap();
                if let Some(seq) = r {
                    assert!(seq <= last_seq[n], "persisted seq never ahead of enqueued");
                    assert_eq!(recs[0].version, recs[0].reminded_version);
                }
            }
        }
    }
}

const CHILD_ENV: &str = "VBK_FAULT_CHILD";

/// Not a test by itself: re-executed in a child process by
/// `model_a_real_abort_in_child_process`; returns immediately otherwise.
#[test]
fn child_writer() {
    let Ok(spec) = std::env::var(CHILD_ENV) else {
        return;
    };
    let parts: Vec<&str> = spec.split('|').collect();
    let dir = PathBuf::from(parts[0]);
    let point = match parts[1] {
        "sync_all" => FailPoint::BeforeSyncAll,
        "rename" => FailPoint::BeforeRename,
        _ => FailPoint::BeforeSyncDir,
    };
    let skip: usize = parts[2].parse().unwrap();
    let store = FileStore::open(&dir).unwrap();
    let n = ns("a");
    let _fault = hooks::inject(&dir, point, FaultAction::Abort, skip, Some(1));
    for v in 1..=50u64 {
        commit_value(&store, &n, v).unwrap();
    }
    // Reaching here means the abort never fired.
    std::process::exit(3);
}

#[test]
fn model_a_real_abort_in_child_process() {
    let exe = std::env::current_exe().unwrap();
    for (name, point) in [
        ("sync_all", FailPoint::BeforeSyncAll),
        ("rename", FailPoint::BeforeRename),
        ("sync_dir", FailPoint::BeforeSyncDir),
    ] {
        for i in 0..iterations(12) {
            let root = TempRoot::new("a3");
            let skip = i % 6;
            let status = Command::new(&exe)
                .args(["--exact", "child_writer", "--nocapture", "--test-threads=1"])
                .env(CHILD_ENV, format!("{}|{}|{}", root.0.display(), name, skip))
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .unwrap();
            assert!(!status.success(), "child must have been aborted");
            assert_ne!(status.code(), Some(3), "abort did not fire");

            let reopened = FileStore::open(&root.0).unwrap();
            let n = ns("a");
            let (rev, _) = read_back(&reopened, &n);
            let expected = if point == FailPoint::BeforeSyncDir {
                skip as u64 + 1
            } else {
                skip as u64
            };
            assert_eq!(rev, expected, "{name} skip={skip}");
            commit_value(&reopened, &n, expected + 1).unwrap();
            assert_eq!(stray_tmp_files(&root.0), 0);
        }
    }
}

// ----------------------------------------------------------------- model B

#[test]
fn model_b_filesystem_errors_fail_cleanly_and_recover() {
    let cases: [(&str, FailPoint, std::io::ErrorKind); 3] = [
        ("ENOSPC", FailPoint::BeforeWrite, std::io::ErrorKind::Other),
        (
            "EACCES",
            FailPoint::BeforeCreate,
            std::io::ErrorKind::PermissionDenied,
        ),
        ("EROFS", FailPoint::BeforeCreate, std::io::ErrorKind::Other),
    ];
    for (label, point, kind) in cases {
        for _ in 0..iterations(20) {
            let root = TempRoot::new("b");
            let store = Arc::new(FileStore::open(&root.0).unwrap());
            let (a, b) = (ns("a"), ns("b"));
            commit_value(&store, &a, 1).unwrap();
            let q = PersistQueue::spawn(store.clone()).unwrap();
            let mut tracker = PersistTracker::new();

            let fault = hooks::inject(&root.0, point, FaultAction::Io(kind, label), 0, Some(1));
            let seq = q.next_seq();
            let job = PersistJob {
                ns: a.clone(),
                seq,
                payload: JobPayload::Compensation(42),
            };
            assert!(q.submit(vec![job]).is_empty());
            q.flush(Duration::from_secs(10)).unwrap();
            tracker.apply_receipts(q.drain_receipts());
            drop(fault);

            assert!(tracker.persist_failed(), "{label}: flag set");
            assert_eq!(tracker.last_error_code(), Some(codes::STORE_IO));
            assert_eq!(
                SyncWatermarkRepo::compensation_cursor(&*store, &a).unwrap(),
                None,
                "{label}: old document intact"
            );
            assert_eq!(read_back(&store, &a).0, 1);
            assert_eq!(
                stray_tmp_files(&root.0),
                0,
                "{label}: error path cleans tmp"
            );

            // Business continues for another namespace while `a` is failing.
            let seq_b = q.next_seq();
            assert!(q
                .submit(vec![PersistJob {
                    ns: b.clone(),
                    seq: seq_b,
                    payload: JobPayload::Compensation(7),
                }])
                .is_empty());

            // Error cleared: the parked job retries and the flag drops.
            assert!(q.submit(tracker.take_pending()).is_empty());
            q.flush(Duration::from_secs(10)).unwrap();
            tracker.apply_receipts(q.drain_receipts());
            assert!(!tracker.persist_failed(), "{label}: flag cleared");
            assert_eq!(
                SyncWatermarkRepo::compensation_cursor(&*store, &a).unwrap(),
                Some(42)
            );
            assert_eq!(
                SyncWatermarkRepo::compensation_cursor(&*store, &b).unwrap(),
                Some(7)
            );
        }
    }
}

#[test]
fn model_b_corrupt_document_is_quarantined_and_work_continues() {
    let root = TempRoot::new("bq");
    let store = FileStore::open(&root.0).unwrap();
    let n = ns("a");
    commit_value(&store, &n, 1).unwrap();
    let doc = store.namespace_dir(&n).join("state.json");
    fs::write(&doc, b"{ not json").unwrap();

    let e = store.begin(&n).expect_err("corrupt");
    assert!(e.is(codes::STORE_CORRUPT));
    assert!(!doc.exists(), "bad document moved away, not deleted");
    let files = store.quarantined_files(&n).unwrap();
    assert_eq!(files.len(), 1);
    assert!(files[0].parent().unwrap().ends_with("quarantine"));
    assert_eq!(fs::read(&files[0]).unwrap(), b"{ not json");

    // Until acknowledged the namespace stays refused; after, it works.
    assert!(store.begin(&n).unwrap_err().is(codes::STORE_CORRUPT));
    store.acknowledge_corruption(&n).unwrap();
    commit_value(&store, &n, 1).unwrap();
    assert_eq!(read_back(&store, &n).0, 1);
    // Another namespace was never affected.
    commit_value(&store, &ns("b"), 1).unwrap();
}

#[test]
fn newer_schema_document_is_refused_and_left_untouched() {
    let root = TempRoot::new("schema");
    let store = FileStore::open(&root.0).unwrap();
    let n = ns("a");
    commit_value(&store, &n, 1).unwrap();
    let path = store.namespace_dir(&n).join("state.json");
    let text = fs::read_to_string(&path).unwrap();
    assert!(text.contains("\"schema_version\":2"), "{text}");
    let newer = text.replace("\"schema_version\":2", "\"schema_version\":99");
    fs::write(&path, &newer).unwrap();

    for _ in 0..3 {
        let e = store.begin(&n).expect_err("must refuse");
        assert!(e.is(codes::STORE_SCHEMA_TOO_NEW), "{e:?}");
    }
    assert_eq!(fs::read_to_string(&path).unwrap(), newer, "bytes unchanged");
    assert!(store.quarantined_files(&n).unwrap().is_empty());
}

#[test]
fn legacy_v1_document_upgrades_on_next_commit() {
    let root = TempRoot::new("legacy");
    let store = FileStore::open(&root.0).unwrap();
    let n = ns("a");
    commit_value(&store, &n, 1).unwrap();
    let path = store.namespace_dir(&n).join("state.json");
    let legacy = fs::read_to_string(&path)
        .unwrap()
        .replace(",\"schema_version\":2", "");
    assert!(!legacy.contains("schema_version"));
    fs::write(&path, legacy).unwrap();

    assert_eq!(read_back(&store, &n).0, 1, "v1 reads fine");
    commit_value(&store, &n, 2).unwrap();
    assert!(fs::read_to_string(&path)
        .unwrap()
        .contains("\"schema_version\":2"));
}

// ----------------------------------------------------------------- CAS

#[test]
fn stale_base_revision_is_a_cas_conflict_in_both_backends() {
    let root = TempRoot::new("cas");
    let file = FileStore::open(&root.0).unwrap();
    let mem = MemoryStore::new();
    let stores: [&dyn Store; 2] = [&file, &mem];
    for store in stores {
        let n = ns("a");
        let mut t1 = store.begin(&n).unwrap();
        let mut t2 = store.begin(&n).unwrap();
        t1.put("c", "x", JsonValue::string("1"));
        t2.put("c", "y", JsonValue::string("2"));
        store.commit(t1).unwrap();
        let e = store.commit(t2).expect_err("stale transaction");
        assert!(e.is(codes::STORE_CAS_CONFLICT), "{e:?}");
        assert!(store.get(&n, "c", "y").unwrap().is_none());
    }
}

#[test]
fn concurrent_commits_to_one_namespace_serialise_without_lost_updates() {
    let root = TempRoot::new("serial");
    let store = Arc::new(FileStore::open(&root.0).unwrap());
    let n = ns("a");
    let workers: Vec<_> = (0..4)
        .map(|t| {
            let (store, n) = (store.clone(), n.clone());
            std::thread::spawn(move || {
                let mut ok = 0;
                for i in 0..25 {
                    // Retry on conflict, as a correct caller does.
                    loop {
                        let mut txn = store.begin(&n).unwrap();
                        txn.put("c", &format!("t{t}-{i}"), JsonValue::string("x"));
                        match store.commit(txn) {
                            Ok(_) => {
                                ok += 1;
                                break;
                            }
                            Err(e) if e.is(codes::STORE_CAS_CONFLICT) => continue,
                            Err(e) => panic!("{e:?}"),
                        }
                    }
                }
                ok
            })
        })
        .collect();
    let total: i32 = workers.into_iter().map(|w| w.join().unwrap()).sum();
    assert_eq!(total, 100);
    assert_eq!(store.list(&n, "c").unwrap().len(), 100);
    assert_eq!(store.last_commit(&n).unwrap().unwrap().revision, 100);
}

// ------------------------------------------------------------ fsync counts

#[test]
fn write_atomic_and_commit_fsync_counts() {
    let root = TempRoot::new("count");
    let store = FileStore::open(&root.0).unwrap();
    let n = ns("a");
    commit_value(&store, &n, 1).unwrap(); // creates directories

    let probe = FsyncProbe::start(&root.0);
    write_atomic(&store.namespace_dir(&n), "extra.json", b"{}").unwrap();
    let ev = probe.events();
    // Measured: `create_durable_dir_all` re-syncs the existing directory and
    // its parent (2), then the temp file (1) and the directory entry (1).
    // The plan's "2 fsyncs per commit" undercounts; the baseline is 4.
    let kinds: Vec<_> = ev.iter().map(|e| e.kind).collect();
    assert_eq!(
        kinds,
        vec![
            FsyncKind::Directory,
            FsyncKind::Directory,
            FsyncKind::File,
            FsyncKind::Directory
        ],
        "{ev:?}"
    );

    probe.clear();
    commit_value(&store, &n, 2).unwrap();
    assert_eq!(probe.count(), 4, "baseline fsyncs per commit");
}

#[test]
fn probe_is_scoped_to_its_directory_prefix() {
    let (r1, r2) = (TempRoot::new("p1"), TempRoot::new("p2"));
    let (s1, s2) = (
        FileStore::open(&r1.0).unwrap(),
        FileStore::open(&r2.0).unwrap(),
    );
    let probe = FsyncProbe::start(&r1.0);
    commit_value(&s2, &ns("a"), 1).unwrap();
    assert_eq!(probe.count(), 0);
    commit_value(&s1, &ns("a"), 1).unwrap();
    assert!(probe.count() > 0);
}

// -------------------------------------------- 10k interleaved, reversed seq

#[test]
fn ten_thousand_interleaved_jobs_never_regress_a_namespace() {
    let root = TempRoot::new("flood");
    let store = Arc::new(FileStore::open(&root.0).unwrap());
    let q = Arc::new(PersistQueue::spawn(store.clone()).unwrap());
    let (a, b) = (ns("a"), ns("b"));
    let per_ns = iterations(5000).max(5000);

    // Observer: the persisted seq of each namespace never decreases.
    let stop = Arc::new(AtomicBool::new(false));
    let observer = {
        let (store, stop, a, b) = (store.clone(), stop.clone(), a.clone(), b.clone());
        std::thread::spawn(move || {
            let mut seen: BTreeMap<Namespace, u64> = BTreeMap::new();
            while !stop.load(Ordering::Relaxed) {
                for n in [&a, &b] {
                    if let Ok((Some(r), _)) = PersistQueue::persisted_seq(&*store, n) {
                        let prev = seen.insert(n.clone(), r).unwrap_or(0);
                        assert!(r >= prev, "persisted seq regressed {prev} -> {r}");
                    }
                }
                std::thread::sleep(Duration::from_millis(1));
            }
        })
    };

    let mut tracker = PersistTracker::new();
    let mut last: BTreeMap<Namespace, u64> = BTreeMap::new();
    let mut window: Vec<PersistJob> = Vec::new();
    let push = |q: &PersistQueue, tracker: &mut PersistTracker, job: PersistJob| {
        let mut job = Some(job);
        while let Some(j) = job.take() {
            if let Err(e) = q.try_enqueue(j) {
                job = Some(e.into_job());
                tracker.apply_receipts(q.drain_receipts());
                std::thread::sleep(Duration::from_micros(200));
            }
        }
    };
    for i in 0..per_ns as u64 {
        for n in [&a, &b] {
            let job = PersistJob {
                ns: n.clone(),
                seq: q.next_seq(),
                payload: JobPayload::Rounds(vec![round(i + 1)]),
            };
            last.insert(n.clone(), job.seq);
            window.push(job);
        }
        if window.len() >= 16 {
            // Deliver each window newest-first: older seq arrives after newer.
            for job in window.drain(..).rev() {
                push(&q, &mut tracker, job);
            }
        }
    }
    for job in window.drain(..).rev() {
        push(&q, &mut tracker, job);
    }
    q.flush(Duration::from_secs(60)).unwrap();
    tracker.apply_receipts(q.drain_receipts());
    stop.store(true, Ordering::Relaxed);
    observer.join().unwrap();

    assert!(!tracker.persist_failed());
    for n in [&a, &b] {
        let (r, _) = PersistQueue::persisted_seq(&*store, n).unwrap();
        assert_eq!(
            r,
            Some(last[n]),
            "final persisted seq = last successful seq"
        );
        let recs = ReminderStateRepo::load_all(&*store, n)
            .unwrap()
            .reconcile(core_store::ReconcileEvidence::complete())
            .unwrap();
        assert_eq!(recs[0].version, per_ns as u64, "newest snapshot wins");
    }
    let s = q.stats();
    // Reversed delivery is resolved either inside a batch (coalesced) or
    // across batches (stale drop); which one depends on timing.
    assert!(
        s.stale_dropped + s.coalesced > 0,
        "reversed windows must be resolved by coalescing or stale drops"
    );
    assert!(
        s.commits < (2 * per_ns) as u64 / 2,
        "coalescing must beat one commit per job: {s:?}"
    );
    let _ = PERSIST_THREAD;
}

// ----------------------------------------------------------------- model C

/// Simulated filesystem for the power-loss property. A crash may persist
/// each directory entry as either its last synced or its latest volatile
/// binding, and any prefix of the unsynced bytes of a file.
#[derive(Clone)]
struct Inode {
    data: Vec<u8>,
    synced: usize,
}

#[derive(Clone)]
struct SimFs {
    inodes: Vec<Inode>,
    volatile: BTreeMap<String, usize>,
    durable: BTreeMap<String, usize>,
}

#[derive(Clone, Copy, Debug)]
enum Op {
    CreateTmp,
    WriteFirstHalf,
    WriteSecondHalf,
    FsyncTmp,
    RenameOverName,
    FsyncDir,
}

impl SimFs {
    fn with_doc(old: &[u8]) -> Self {
        let mut fs = SimFs {
            inodes: vec![Inode {
                data: old.to_vec(),
                synced: old.len(),
            }],
            volatile: BTreeMap::new(),
            durable: BTreeMap::new(),
        };
        fs.volatile.insert("state.json".into(), 0);
        fs.durable.insert("state.json".into(), 0);
        fs
    }

    fn apply(&mut self, op: Op, new: &[u8]) {
        let half = new.len() / 2;
        match op {
            Op::CreateTmp => {
                self.inodes.push(Inode {
                    data: Vec::new(),
                    synced: 0,
                });
                self.volatile.insert("tmp".into(), self.inodes.len() - 1);
            }
            Op::WriteFirstHalf => {
                let i = self.volatile["tmp"];
                self.inodes[i].data.extend_from_slice(&new[..half]);
            }
            Op::WriteSecondHalf => {
                let i = self.volatile["tmp"];
                self.inodes[i].data.extend_from_slice(&new[half..]);
            }
            Op::FsyncTmp => {
                let i = self.volatile["tmp"];
                self.inodes[i].synced = self.inodes[i].data.len();
            }
            Op::RenameOverName => {
                if let Some(i) = self.volatile.remove("tmp") {
                    self.volatile.insert("state.json".into(), i);
                }
            }
            Op::FsyncDir => self.durable = self.volatile.clone(),
        }
    }

    /// One adversarial post-crash view of `state.json`.
    fn crash_read(&self, rng: &mut Lcg) -> Option<Vec<u8>> {
        let binding = if rng.next() % 2 == 0 {
            self.durable.get("state.json")
        } else {
            self.volatile.get("state.json")
        }?;
        let ino = &self.inodes[*binding];
        let unsynced = ino.data.len() - ino.synced.min(ino.data.len());
        let extra = if unsynced == 0 {
            0
        } else {
            (rng.next() as usize) % (unsynced + 1)
        };
        Some(ino.data[..ino.synced.min(ino.data.len()) + extra].to_vec())
    }
}

struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 33
    }
}

fn violations(sequence: &[Op], trials: usize) -> usize {
    let (old, new): (&[u8], &[u8]) = (b"OLD-DOCUMENT-CONTENT", b"NEW-DOCUMENT-CONTENT-LONGER");
    let mut rng = Lcg(0x5eed);
    let mut bad = 0;
    for cut in 0..=sequence.len() {
        let mut fs = SimFs::with_doc(old);
        for op in &sequence[..cut] {
            fs.apply(*op, new);
        }
        for _ in 0..trials {
            match fs.crash_read(&mut rng) {
                Some(bytes) if bytes == old || bytes == new => {}
                _ => bad += 1,
            }
        }
    }
    bad
}

/// The op order `write_atomic` performs (verified against the real
/// implementation by `write_atomic_op_order_matches_the_model`).
const REAL_SEQUENCE: [Op; 6] = [
    Op::CreateTmp,
    Op::WriteFirstHalf,
    Op::WriteSecondHalf,
    Op::FsyncTmp,
    Op::RenameOverName,
    Op::FsyncDir,
];

#[test]
fn model_c_any_prefix_of_write_atomic_reads_old_or_new() {
    assert_eq!(violations(&REAL_SEQUENCE, 2000), 0);
}

#[test]
fn model_c_property_has_teeth_without_fsync_before_rename() {
    // The pre-I-25 `login.rs` / `display.rs` shape: write, rename, no fsync.
    let unsafe_sequence = [
        Op::CreateTmp,
        Op::WriteFirstHalf,
        Op::WriteSecondHalf,
        Op::RenameOverName,
    ];
    assert!(
        violations(&unsafe_sequence, 2000) > 0,
        "the simulated filesystem must expose a torn document"
    );
}

#[test]
fn write_atomic_op_order_matches_the_model() {
    // The model assumes: file fsync strictly before rename strictly before
    // directory fsync. Observe it on the real code with fail points: a crash
    // before the rename must leave the old document, a crash after must show
    // the new one, and the fsync events must be [file, directory].
    let root = TempRoot::new("order");
    let dir = root.0.join("d");
    write_atomic(&dir, "state.json", b"OLD").unwrap();

    let probe = FsyncProbe::start(&root.0);
    let g = hooks::inject(
        &root.0,
        FailPoint::BeforeRename,
        FaultAction::Crash,
        0,
        Some(1),
    );
    assert!(write_atomic(&dir, "state.json", b"NEW").is_err());
    drop(g);
    assert_eq!(fs::read(dir.join("state.json")).unwrap(), b"OLD");
    let kinds = after_setup(&probe);
    assert_eq!(kinds, vec![FsyncKind::File], "file synced before rename");

    probe.clear();
    let g = hooks::inject(
        &root.0,
        FailPoint::BeforeSyncDir,
        FaultAction::Crash,
        0,
        Some(1),
    );
    assert!(write_atomic(&dir, "state.json", b"NEW").is_err());
    drop(g);
    assert_eq!(fs::read(dir.join("state.json")).unwrap(), b"NEW");
    let kinds = after_setup(&probe);
    assert_eq!(kinds, vec![FsyncKind::File], "directory not yet synced");

    probe.clear();
    write_atomic(&dir, "state.json", b"NEWER").unwrap();
    let kinds = after_setup(&probe);
    assert_eq!(kinds, vec![FsyncKind::File, FsyncKind::Directory]);
}

/// Fsync kinds of the write itself: drops the leading directory syncs that
/// `create_durable_dir_all` performs before the temp file exists.
fn after_setup(probe: &FsyncProbe) -> Vec<FsyncKind> {
    probe
        .events()
        .iter()
        .map(|e| e.kind)
        .skip_while(|k| *k == FsyncKind::Directory)
        .collect()
}

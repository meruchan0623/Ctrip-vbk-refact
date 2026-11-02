//! Persistence queue (I-04a): durable writes leave the caller's thread.
//!
//! Problem: every inbound fact used to run `begin -> commit` (two `fsync`s
//! per namespace) while the host held its global `Cores` mutex on the main
//! thread. Disk latency therefore stalled the 1 Hz scheduler and every other
//! command.
//!
//! Design (std-only):
//!
//! * One dedicated thread, named [`PERSIST_THREAD`], owns all queued writes.
//!   Callers hand it a [`PersistJob`] through a **bounded**
//!   `std::sync::mpsc::sync_channel`; enqueueing is `try_send`, so a caller
//!   never waits for the disk. A full queue hands the job back
//!   ([`EnqueueError::Full`]); the caller parks it in a [`PersistTracker`] and
//!   retries on a later tick.
//! * `seq` is allocated by [`PersistQueue::next_seq`] (an `AtomicU64`)
//!   while the caller still holds its own lock, so it orders snapshots by the
//!   order in which they were taken. The worker never writes a job whose
//!   `seq` is not greater than the last one it wrote for the same
//!   `(namespace, kind)`; an out-of-order older snapshot cannot overwrite a
//!   newer one.
//! * **Coalescing**: the worker drains everything that is queued, keeps only
//!   the newest job per `(namespace, kind)`, and commits one transaction per
//!   namespace (rounds and compensation cursor together: one `fsync` pair
//!   instead of two). A snapshot identical to the last one written is not
//!   written again.
//! * Every job is acknowledged on a receipt channel ([`Receipt`]): written,
//!   skipped (logout-locked), superseded (a newer snapshot already landed)
//!   or failed. A failed commit, including one whose store code panicked,
//!   returns the unwritten jobs inside the receipt so the
//!   [`PersistTracker`] can retry them; the tracker also owns the
//!   `persist_failed` state the UI and the send barrier read.
//! * [`PersistQueue::flush`] is a barrier: when it returns `Ok`, every job
//!   enqueued before it has been committed (or failed and reported).
//! * `LogoutLock` is a job too, so the lock's `fsync` is also off the
//!   caller's thread and stays ordered with respect to earlier writes.
//!
//! The worker records one `persist_meta/seq` document per namespace
//! (`rounds`, `compensation` = last written `seq` of this process) so tests
//! and diagnostics can read back what was last committed.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use contracts::json::JsonValue;
use contracts::AppError;

use crate::error::codes;
use crate::repo::reminder::{ReminderStateRepo, RoundRecord};
use crate::repo::sync::SyncWatermarkRepo;
use crate::store::{Namespace, Store};

/// Name of the persistence thread (asserted by the fsync probe in tests).
pub const PERSIST_THREAD: &str = "vbk-persist";
/// Default queue capacity in jobs.
pub const QUEUE_CAPACITY: usize = 256;
/// Retries of a commit that lost a `base_revision` race with another writer.
const CAS_RETRIES: usize = 5;

/// Collection and key of the last-written-`seq` record.
pub const META_COLLECTION: &str = "persist_meta";
pub const META_KEY: &str = "seq";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobPayload {
    /// Full snapshot of the persistable waiting rounds of the namespace.
    /// Records are upserted; an older snapshot is superseded by a newer one.
    Rounds(Vec<RoundRecord>),
    /// Compensation watermark (`beginMsgTime`, Unix ms).
    Compensation(i64),
    /// Makes the namespace read-only until re-auth. Never coalesced.
    LogoutLock,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersistJob {
    pub ns: Namespace,
    pub seq: u64,
    pub payload: JobPayload,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
enum Kind {
    Rounds,
    Compensation,
    Lock,
}

impl JobPayload {
    fn kind(&self) -> Kind {
        match self {
            JobPayload::Rounds(_) => Kind::Rounds,
            JobPayload::Compensation(_) => Kind::Compensation,
            JobPayload::LogoutLock => Kind::Lock,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReceiptOutcome {
    /// Committed (or identical to what is already on disk).
    Written,
    /// The namespace is logout-locked: the write was intentionally dropped.
    Skipped,
    /// A newer snapshot of the same `(namespace, kind)` was already written;
    /// this older one was dropped. For the caller it is done (retrying it
    /// can never land), so the tracker treats it like `Written`.
    Superseded,
    /// Not written. `unwritten` are the jobs to retry.
    Failed {
        error: AppError,
        unwritten: Vec<PersistJob>,
    },
}

/// `(namespace, seq, outcome)`: `seq` is the highest `seq` the commit covers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Receipt {
    pub ns: Namespace,
    pub seq: u64,
    pub outcome: ReceiptOutcome,
}

#[derive(Debug)]
pub enum EnqueueError {
    /// Queue full: nothing was blocked, the job is returned.
    Full(PersistJob),
    /// The worker is gone.
    Closed(PersistJob),
}

impl EnqueueError {
    pub fn into_job(self) -> PersistJob {
        match self {
            EnqueueError::Full(j) | EnqueueError::Closed(j) => j,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlushError {
    Timeout,
    Closed,
}

/// Counters, mostly for tests and the baseline report.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct QueueStats {
    /// Transactions committed.
    pub commits: u64,
    /// Jobs replaced by a newer job of the same `(namespace, kind)`.
    pub coalesced: u64,
    /// Jobs dropped because a newer `seq` had already been written.
    pub stale_dropped: u64,
    /// Snapshots not written because they equal the last written one.
    pub unchanged: u64,
    /// Namespace writes whose processing panicked (the worker survives and
    /// reports the jobs as `Failed`).
    pub panics: u64,
}

#[derive(Debug, Default)]
struct Counters {
    commits: AtomicU64,
    coalesced: AtomicU64,
    stale_dropped: AtomicU64,
    unchanged: AtomicU64,
    panics: AtomicU64,
}

enum Msg {
    Job(PersistJob),
    Flush(mpsc::Sender<()>),
}

type SharedStore = Arc<dyn Store + Send + Sync>;

pub struct PersistQueue {
    tx: SyncSender<Msg>,
    seq: AtomicU64,
    receipts: Mutex<Receiver<Receipt>>,
    counters: Arc<Counters>,
    handle: Mutex<Option<JoinHandle<()>>>,
}

impl std::fmt::Debug for PersistQueue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PersistQueue")
            .field("next_seq", &self.seq.load(Ordering::Relaxed))
            .finish_non_exhaustive()
    }
}

impl PersistQueue {
    pub fn spawn(store: SharedStore) -> std::io::Result<Self> {
        Self::spawn_with_capacity(store, QUEUE_CAPACITY)
    }

    pub fn spawn_with_capacity(store: SharedStore, capacity: usize) -> std::io::Result<Self> {
        let (tx, rx) = mpsc::sync_channel::<Msg>(capacity.max(1));
        let (rtx, rrx) = mpsc::channel::<Receipt>();
        let counters = Arc::new(Counters::default());
        let worker = Worker {
            store,
            rx,
            receipts: rtx,
            counters: Arc::clone(&counters),
            last_seq: HashMap::new(),
            last_payload: HashMap::new(),
        };
        let handle = std::thread::Builder::new()
            .name(PERSIST_THREAD.to_string())
            .spawn(move || worker.run())?;
        Ok(Self {
            tx,
            seq: AtomicU64::new(1),
            receipts: Mutex::new(rrx),
            counters,
            handle: Mutex::new(Some(handle)),
        })
    }

    /// Next snapshot sequence number. Call it **while the lock that guards
    /// the snapshotted state is still held**, so `seq` follows snapshot order.
    pub fn next_seq(&self) -> u64 {
        self.seq.fetch_add(1, Ordering::SeqCst)
    }

    /// Non-blocking enqueue.
    pub fn try_enqueue(&self, job: PersistJob) -> Result<(), EnqueueError> {
        match self.tx.try_send(Msg::Job(job)) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(m)) => Err(EnqueueError::Full(job_of(m))),
            Err(TrySendError::Disconnected(m)) => Err(EnqueueError::Closed(job_of(m))),
        }
    }

    /// Enqueues as many jobs as fit; returns the ones that did not.
    pub fn submit(&self, jobs: Vec<PersistJob>) -> Vec<PersistJob> {
        jobs.into_iter()
            .filter_map(|j| self.try_enqueue(j).err().map(EnqueueError::into_job))
            .collect()
    }

    /// Receipts produced since the last call. Never blocks on the worker.
    pub fn drain_receipts(&self) -> Vec<Receipt> {
        let rx = self.receipts.lock().unwrap_or_else(|p| p.into_inner());
        rx.try_iter().collect()
    }

    /// Barrier: returns once every job enqueued before this call has been
    /// processed. Waits up to `timeout` in total (enqueue and processing).
    pub fn flush(&self, timeout: Duration) -> Result<(), FlushError> {
        let deadline = Instant::now() + timeout;
        let (ack_tx, ack_rx) = mpsc::channel();
        let mut msg = Msg::Flush(ack_tx);
        loop {
            match self.tx.try_send(msg) {
                Ok(()) => break,
                Err(TrySendError::Full(m)) => {
                    if Instant::now() >= deadline {
                        return Err(FlushError::Timeout);
                    }
                    msg = m;
                    std::thread::sleep(Duration::from_millis(1));
                }
                Err(TrySendError::Disconnected(_)) => return Err(FlushError::Closed),
            }
        }
        match ack_rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(()) => Ok(()),
            Err(RecvTimeoutError::Timeout) => Err(FlushError::Timeout),
            Err(RecvTimeoutError::Disconnected) => Err(FlushError::Closed),
        }
    }

    pub fn stats(&self) -> QueueStats {
        QueueStats {
            commits: self.counters.commits.load(Ordering::Relaxed),
            coalesced: self.counters.coalesced.load(Ordering::Relaxed),
            stale_dropped: self.counters.stale_dropped.load(Ordering::Relaxed),
            unchanged: self.counters.unchanged.load(Ordering::Relaxed),
            panics: self.counters.panics.load(Ordering::Relaxed),
        }
    }

    /// Last `(rounds, compensation)` `seq` committed for `ns` by this or a
    /// previous run of the queue (`None` = never written).
    pub fn persisted_seq(
        store: &dyn Store,
        ns: &Namespace,
    ) -> Result<(Option<u64>, Option<u64>), AppError> {
        let Some(v) = store.get(ns, META_COLLECTION, META_KEY)? else {
            return Ok((None, None));
        };
        let field = |name: &str| v.get(name).and_then(JsonValue::as_i64).map(|n| n as u64);
        Ok((field("rounds"), field("compensation")))
    }
}

impl Drop for PersistQueue {
    fn drop(&mut self) {
        // The worker finishes whatever is queued, then sees the channel
        // closed and exits. Not joined: dropping must never wait for a disk.
        let _ = self.handle.lock().unwrap_or_else(|p| p.into_inner()).take();
    }
}

/// Only `Msg::Job` is ever sent through `try_enqueue`.
fn job_of(m: Msg) -> PersistJob {
    match m {
        Msg::Job(j) => j,
        Msg::Flush(_) => unreachable!("try_enqueue only sends jobs"),
    }
}

struct Worker {
    store: SharedStore,
    rx: Receiver<Msg>,
    receipts: mpsc::Sender<Receipt>,
    counters: Arc<Counters>,
    last_seq: HashMap<(Namespace, Kind), u64>,
    last_payload: HashMap<(Namespace, Kind), JobPayload>,
}

impl Worker {
    fn run(mut self) {
        while let Ok(first) = self.rx.recv() {
            let mut jobs = Vec::new();
            let mut flushes = Vec::new();
            let mut msg = Some(first);
            while let Some(m) = msg.take() {
                match m {
                    Msg::Job(j) => {
                        jobs.push(j);
                        msg = self.rx.try_recv().ok();
                    }
                    // Everything enqueued before the flush is in `jobs`;
                    // anything after it waits for the next round.
                    Msg::Flush(ack) => flushes.push(ack),
                }
            }
            // Panics are caught per namespace inside `process` (so every job
            // still gets a receipt); this outer guard only keeps the thread
            // alive if the bookkeeping itself ever panics.
            let batch = catch_unwind(AssertUnwindSafe(|| self.process(jobs)));
            if batch.is_err() {
                self.counters.panics.fetch_add(1, Ordering::Relaxed);
            }
            for ack in flushes {
                let _ = ack.send(());
            }
        }
    }

    fn process(&mut self, jobs: Vec<PersistJob>) {
        // Data jobs are grouped between logout locks, which act as ordered
        // barriers: writes queued before a lock land before it.
        let mut group: Vec<PersistJob> = Vec::new();
        for job in jobs {
            if job.payload == JobPayload::LogoutLock {
                self.write_group(std::mem::take(&mut group));
                self.apply_lock(job);
            } else {
                group.push(job);
            }
        }
        self.write_group(group);
    }

    /// Runs one store operation, turning a panic inside the store into a
    /// `Failed` outcome that hands the jobs back for a retry. Without this a
    /// panicking `commit` would drop the batch with no receipt at all, and
    /// the host would neither retry nor show "本地保存失败".
    fn guarded<R>(
        &self,
        jobs: &[PersistJob],
        f: impl FnOnce() -> Result<R, AppError>,
    ) -> Result<R, ReceiptOutcome> {
        match catch_unwind(AssertUnwindSafe(f)) {
            Ok(Ok(r)) => Ok(r),
            Ok(Err(e)) => Err(ReceiptOutcome::Failed {
                error: e,
                unwritten: jobs.to_vec(),
            }),
            Err(_) => {
                self.counters.panics.fetch_add(1, Ordering::Relaxed);
                Err(ReceiptOutcome::Failed {
                    error: AppError::new(codes::STORE_IO, "persistence worker panicked"),
                    unwritten: jobs.to_vec(),
                })
            }
        }
    }

    fn apply_lock(&mut self, job: PersistJob) {
        let result = self.guarded(std::slice::from_ref(&job), || {
            self.store.logout_lock(&job.ns)
        });
        self.last_payload.retain(|(ns, _), _| *ns != job.ns);
        let outcome = match result {
            Ok(()) => ReceiptOutcome::Written,
            Err(failed) => failed,
        };
        self.counters.commits.fetch_add(1, Ordering::Relaxed);
        self.receive(Receipt {
            ns: job.ns,
            seq: job.seq,
            outcome,
        });
    }

    fn write_group(&mut self, group: Vec<PersistJob>) {
        // Newest job per (namespace, kind); older ones are coalesced away.
        let mut best: BTreeMap<Namespace, BTreeMap<Kind, PersistJob>> = BTreeMap::new();
        for job in group {
            let key = (job.ns.clone(), job.payload.kind());
            if self.last_seq.get(&key).is_some_and(|&done| job.seq <= done) {
                self.counters.stale_dropped.fetch_add(1, Ordering::Relaxed);
                // Acknowledged, not silently dropped: the caller may have
                // parked this job after a failure and would otherwise keep
                // `persist_failed` set for a retry that can never land.
                self.receive(Receipt {
                    ns: job.ns,
                    seq: job.seq,
                    outcome: ReceiptOutcome::Superseded,
                });
                continue;
            }
            let slot = best.entry(job.ns.clone()).or_default();
            match slot.get(&job.payload.kind()) {
                Some(kept) if kept.seq >= job.seq => {
                    self.counters.coalesced.fetch_add(1, Ordering::Relaxed);
                }
                Some(_) => {
                    self.counters.coalesced.fetch_add(1, Ordering::Relaxed);
                    slot.insert(job.payload.kind(), job);
                }
                None => {
                    slot.insert(job.payload.kind(), job);
                }
            }
        }
        for (ns, jobs) in best {
            self.write_namespace(ns, jobs.into_values().collect());
        }
    }

    fn write_namespace(&mut self, ns: Namespace, jobs: Vec<PersistJob>) {
        let top_seq = jobs.iter().map(|j| j.seq).max().unwrap_or(0);
        let changed: Vec<PersistJob> = jobs
            .iter()
            .filter(|j| self.last_payload.get(&(ns.clone(), j.payload.kind())) != Some(&j.payload))
            .cloned()
            .collect();
        if changed.is_empty() {
            self.counters
                .unchanged
                .fetch_add(jobs.len() as u64, Ordering::Relaxed);
            for j in &jobs {
                self.last_seq.insert((ns.clone(), j.payload.kind()), j.seq);
            }
            self.receive(Receipt {
                ns,
                seq: top_seq,
                outcome: ReceiptOutcome::Written,
            });
            return;
        }
        let outcome = match self.guarded(&jobs, || self.commit(&ns, &jobs)) {
            Ok(()) => {
                for j in &jobs {
                    let key = (ns.clone(), j.payload.kind());
                    self.last_seq.insert(key.clone(), j.seq);
                    self.last_payload.insert(key, j.payload.clone());
                }
                ReceiptOutcome::Written
            }
            Err(ReceiptOutcome::Failed { error, .. }) if error.is(codes::STORE_LOCKED) => {
                ReceiptOutcome::Skipped
            }
            Err(failed) => failed,
        };
        self.receive(Receipt {
            ns,
            seq: top_seq,
            outcome,
        });
    }

    fn commit(&self, ns: &Namespace, jobs: &[PersistJob]) -> Result<(), AppError> {
        let mut attempt = 0;
        loop {
            let mut txn = self.store.begin(ns)?;
            let mut meta = JsonValue::object();
            // Carry over the other kind's last seq so one field never erases
            // the other.
            let (prev_r, prev_c) = match self.store.get(ns, META_COLLECTION, META_KEY)? {
                Some(v) => (
                    v.get("rounds").and_then(JsonValue::as_i64),
                    v.get("compensation").and_then(JsonValue::as_i64),
                ),
                None => (None, None),
            };
            let (mut rounds_seq, mut comp_seq) = (prev_r, prev_c);
            for job in jobs {
                match &job.payload {
                    JobPayload::Rounds(records) => {
                        for rec in records {
                            ReminderStateRepo::put(&mut txn, rec);
                        }
                        rounds_seq = Some(job.seq as i64);
                    }
                    JobPayload::Compensation(ms) => {
                        SyncWatermarkRepo::set_compensation_cursor(&mut txn, *ms);
                        comp_seq = Some(job.seq as i64);
                    }
                    JobPayload::LogoutLock => {}
                }
            }
            if let Some(n) = rounds_seq {
                meta.insert("rounds", JsonValue::number_from_i64(n));
            }
            if let Some(n) = comp_seq {
                meta.insert("compensation", JsonValue::number_from_i64(n));
            }
            txn.put(META_COLLECTION, META_KEY, meta);
            match self.store.commit(txn) {
                Ok(_) => {
                    self.counters.commits.fetch_add(1, Ordering::Relaxed);
                    return Ok(());
                }
                Err(e) if e.is(codes::STORE_CAS_CONFLICT) && attempt < CAS_RETRIES => {
                    attempt += 1;
                }
                Err(e) => return Err(e),
            }
        }
    }

    fn receive(&self, receipt: Receipt) {
        let _ = self.receipts.send(receipt);
    }
}

/// Caller-side bookkeeping that lives next to the caller's own state (the
/// host keeps one inside its `Cores`): jobs that did not fit into the queue
/// or failed to write, and the namespaces currently in `persist_failed`.
#[derive(Debug, Default)]
pub struct PersistTracker {
    pending: BTreeMap<(Namespace, Kind), PersistJob>,
    failed: BTreeSet<Namespace>,
    last_error: Option<String>,
}

impl PersistTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Parks a job for a later retry. Per `(namespace, kind)` only the job
    /// with the highest `seq` is kept.
    pub fn stash(&mut self, job: PersistJob) {
        let key = (job.ns.clone(), job.payload.kind());
        match self.pending.get(&key) {
            Some(kept) if kept.seq >= job.seq => {}
            _ => {
                self.pending.insert(key, job);
            }
        }
    }

    pub fn stash_all(&mut self, jobs: impl IntoIterator<Item = PersistJob>) {
        for j in jobs {
            self.stash(j);
        }
    }

    /// Takes every parked job, oldest `seq` first.
    pub fn take_pending(&mut self) -> Vec<PersistJob> {
        let mut jobs: Vec<PersistJob> = std::mem::take(&mut self.pending).into_values().collect();
        jobs.sort_by_key(|j| j.seq);
        jobs
    }

    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }

    /// Consumes receipts: a failure marks the namespace `persist_failed` and
    /// parks the unwritten jobs; a success (written, skipped because locked,
    /// or superseded by a newer snapshot) clears the mark unless something
    /// for the namespace is still parked.
    pub fn apply_receipts(&mut self, receipts: Vec<Receipt>) {
        for r in receipts {
            match r.outcome {
                ReceiptOutcome::Written | ReceiptOutcome::Skipped | ReceiptOutcome::Superseded => {
                    if !self.pending.keys().any(|(ns, _)| *ns == r.ns) {
                        self.failed.remove(&r.ns);
                        if self.failed.is_empty() {
                            self.last_error = None;
                        }
                    }
                }
                ReceiptOutcome::Failed { error, unwritten } => {
                    self.last_error = Some(error.code.clone());
                    self.failed.insert(r.ns);
                    self.stash_all(unwritten);
                }
            }
        }
    }

    /// True while any namespace could not be persisted ("本地保存失败").
    pub fn persist_failed(&self) -> bool {
        !self.failed.is_empty()
    }

    pub fn failed_namespaces(&self) -> Vec<Namespace> {
        self.failed.iter().cloned().collect()
    }

    /// Error code of the latest failure (`store.io`, ...); never a path.
    pub fn last_error_code(&self) -> Option<&str> {
        self.last_error.as_deref()
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use crate::{FileStore, MemoryStore};
    use contracts::{AccountId, Environment};
    use std::sync::atomic::AtomicBool;
    use std::sync::Condvar;

    fn ns(a: &str) -> Namespace {
        Namespace::new(Environment::named("t"), AccountId::new(a))
    }

    fn round(gid: &str, version: u64) -> RoundRecord {
        RoundRecord {
            gid: gid.into(),
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

    fn job(q: &PersistQueue, n: &Namespace, payload: JobPayload) -> PersistJob {
        PersistJob {
            ns: n.clone(),
            seq: q.next_seq(),
            payload,
        }
    }

    /// Store wrapper whose `commit` blocks until opened.
    struct Gated {
        inner: MemoryStore,
        open: Mutex<bool>,
        cv: Condvar,
        commits: AtomicU64,
        fail: AtomicBool,
        /// `commit` panics once (a store bug), then behaves again.
        panic_once: AtomicBool,
    }

    impl Gated {
        fn new(open: bool) -> Arc<Self> {
            Arc::new(Self {
                inner: MemoryStore::new(),
                open: Mutex::new(open),
                cv: Condvar::new(),
                commits: AtomicU64::new(0),
                fail: AtomicBool::new(false),
                panic_once: AtomicBool::new(false),
            })
        }
        fn open(&self) {
            *self.open.lock().unwrap() = true;
            self.cv.notify_all();
        }
    }

    impl Store for Gated {
        fn begin(&self, ns: &Namespace) -> Result<crate::Txn, AppError> {
            self.inner.begin(ns)
        }
        fn commit(&self, txn: crate::Txn) -> Result<crate::CommitFact, AppError> {
            let mut g = self.open.lock().unwrap();
            while !*g {
                g = self.cv.wait(g).unwrap();
            }
            drop(g);
            if self.fail.load(Ordering::SeqCst) {
                return Err(AppError::new(codes::STORE_IO, "injected"));
            }
            if self.panic_once.swap(false, Ordering::SeqCst) {
                panic!("injected store panic");
            }
            self.commits.fetch_add(1, Ordering::SeqCst);
            self.inner.commit(txn)
        }
        fn get(&self, ns: &Namespace, c: &str, k: &str) -> Result<Option<JsonValue>, AppError> {
            self.inner.get(ns, c, k)
        }
        fn list(&self, ns: &Namespace, c: &str) -> Result<Vec<(String, JsonValue)>, AppError> {
            self.inner.list(ns, c)
        }
        fn last_commit(&self, ns: &Namespace) -> Result<Option<crate::CommitFact>, AppError> {
            self.inner.last_commit(ns)
        }
        fn logout_lock(&self, ns: &Namespace) -> Result<(), AppError> {
            self.inner.logout_lock(ns)
        }
        fn unlock_after_reauth(&self, ns: &Namespace) -> Result<(), AppError> {
            self.inner.unlock_after_reauth(ns)
        }
        fn is_locked(&self, ns: &Namespace) -> Result<bool, AppError> {
            self.inner.is_locked(ns)
        }
    }

    #[test]
    fn full_queue_returns_job_without_blocking_and_coalesces_after() {
        let store = Gated::new(false);
        let q = PersistQueue::spawn_with_capacity(store.clone(), 2).unwrap();
        let a = ns("a");
        // The worker takes the first job and blocks inside commit; two more
        // fit in the channel, the next is refused immediately.
        let mut rejected = Vec::new();
        let started = Instant::now();
        for v in 1..=8 {
            let j = job(&q, &a, JobPayload::Rounds(vec![round("g", v)]));
            if let Err(e) = q.try_enqueue(j) {
                assert!(matches!(e, EnqueueError::Full(_)));
                rejected.push(e.into_job());
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        assert!(started.elapsed() < Duration::from_secs(2), "must not block");
        assert!(!rejected.is_empty());

        let mut tracker = PersistTracker::new();
        tracker.stash_all(rejected);
        assert_eq!(tracker.pending_len(), 1, "stash merges per ns+kind");

        store.open();
        q.flush(Duration::from_secs(5)).unwrap();
        // Retry the parked (newest of the rejected) job.
        assert!(q.submit(tracker.take_pending()).is_empty());
        q.flush(Duration::from_secs(5)).unwrap();
        let (r, _) = PersistQueue::persisted_seq(&store.inner, &a).unwrap();
        assert_eq!(r, Some(8), "newest snapshot is the one on disk");
        let recs = ReminderStateRepo::load_all(&store.inner, &a).unwrap();
        let recs = recs
            .reconcile(crate::ReconcileEvidence::complete())
            .unwrap();
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].version, 8);
    }

    #[test]
    fn out_of_order_seq_never_overwrites_newer() {
        let store = Gated::new(true);
        let q = PersistQueue::spawn(store.clone()).unwrap();
        let a = ns("a");
        let jobs: Vec<_> = (1..=5)
            .map(|v| job(&q, &a, JobPayload::Rounds(vec![round("g", v)])))
            .collect();
        // Newest first, then the older ones, flushing between to defeat batching.
        for j in jobs.iter().rev() {
            q.try_enqueue(j.clone()).unwrap();
            q.flush(Duration::from_secs(5)).unwrap();
        }
        let (r, _) = PersistQueue::persisted_seq(&store.inner, &a).unwrap();
        assert_eq!(r, Some(5));
        let s = q.stats();
        assert_eq!(s.stale_dropped, 4);
        assert_eq!(s.commits, 1);
    }

    #[test]
    fn rounds_and_compensation_share_one_commit_per_namespace() {
        let store = Gated::new(false);
        let q = PersistQueue::spawn(store.clone()).unwrap();
        let (a, b) = (ns("a"), ns("b"));
        // First job keeps the worker busy so the rest batch together.
        q.try_enqueue(job(&q, &a, JobPayload::Compensation(1)))
            .unwrap();
        std::thread::sleep(Duration::from_millis(20));
        for v in 1..=3 {
            q.try_enqueue(job(&q, &b, JobPayload::Rounds(vec![round("g", v)])))
                .unwrap();
        }
        q.try_enqueue(job(&q, &b, JobPayload::Compensation(99)))
            .unwrap();
        store.open();
        q.flush(Duration::from_secs(5)).unwrap();
        // a: 1 commit, b: 1 commit for 4 jobs.
        assert_eq!(store.commits.load(Ordering::SeqCst), 2);
        assert_eq!(q.stats().coalesced, 2);
        assert_eq!(
            SyncWatermarkRepo::compensation_cursor(&store.inner, &b).unwrap(),
            Some(99)
        );
        let (r, c) = PersistQueue::persisted_seq(&store.inner, &b).unwrap();
        assert!(r.is_some() && c.is_some());
    }

    #[test]
    fn unchanged_snapshot_is_not_rewritten() {
        let store = Gated::new(true);
        let q = PersistQueue::spawn(store.clone()).unwrap();
        let a = ns("a");
        for _ in 0..3 {
            q.try_enqueue(job(&q, &a, JobPayload::Rounds(vec![round("g", 1)])))
                .unwrap();
            q.flush(Duration::from_secs(5)).unwrap();
        }
        assert_eq!(store.commits.load(Ordering::SeqCst), 1);
        assert_eq!(q.stats().unchanged, 2);
    }

    #[test]
    fn failure_sets_flag_then_recovers_on_retry() {
        let store = Gated::new(true);
        store.fail.store(true, Ordering::SeqCst);
        let q = PersistQueue::spawn(store.clone()).unwrap();
        let a = ns("a");
        let mut tracker = PersistTracker::new();
        q.try_enqueue(job(&q, &a, JobPayload::Compensation(7)))
            .unwrap();
        q.flush(Duration::from_secs(5)).unwrap();
        tracker.apply_receipts(q.drain_receipts());
        assert!(tracker.persist_failed());
        assert_eq!(tracker.last_error_code(), Some(codes::STORE_IO));
        assert_eq!(tracker.pending_len(), 1, "unwritten job parked for retry");
        assert_eq!(
            SyncWatermarkRepo::compensation_cursor(&store.inner, &a).unwrap(),
            None,
            "old document untouched"
        );

        // Fault cleared: the retry succeeds and the flag drops.
        store.fail.store(false, Ordering::SeqCst);
        assert!(q.submit(tracker.take_pending()).is_empty());
        q.flush(Duration::from_secs(5)).unwrap();
        tracker.apply_receipts(q.drain_receipts());
        assert!(!tracker.persist_failed());
        assert_eq!(tracker.last_error_code(), None);
        assert_eq!(
            SyncWatermarkRepo::compensation_cursor(&store.inner, &a).unwrap(),
            Some(7)
        );
    }

    /// Counter-example for the retry path: a job fails, a newer snapshot of
    /// the same kind is written before the host retries the parked one, and
    /// the retry is stale-dropped. The data on disk is correct, so the
    /// tracker must leave `persist_failed`; a dropped job therefore needs a
    /// receipt, or the flag would stick until an unrelated later write.
    #[test]
    fn stale_retry_after_a_newer_write_still_clears_persist_failed() {
        let store = Gated::new(true);
        let q = PersistQueue::spawn(store.clone()).unwrap();
        let a = ns("a");
        let mut tracker = PersistTracker::new();

        store.fail.store(true, Ordering::SeqCst);
        q.try_enqueue(job(&q, &a, JobPayload::Rounds(vec![round("g", 1)])))
            .unwrap();
        q.flush(Duration::from_secs(5)).unwrap();
        store.fail.store(false, Ordering::SeqCst);
        // Newer snapshot lands before the tick looks at the receipts.
        q.try_enqueue(job(&q, &a, JobPayload::Rounds(vec![round("g", 2)])))
            .unwrap();
        q.flush(Duration::from_secs(5)).unwrap();

        // Tick 1: sees [Failed(seq1), Written(seq2)], parks seq1, retries it.
        tracker.apply_receipts(q.drain_receipts());
        assert!(tracker.persist_failed(), "the failure is reported");
        let retry = tracker.take_pending();
        assert_eq!(retry.len(), 1);
        assert!(q.submit(retry).is_empty());
        q.flush(Duration::from_secs(5)).unwrap();
        assert_eq!(q.stats().stale_dropped, 1, "the old snapshot is dropped");

        // Tick 2: the drop must be acknowledged so the flag clears.
        tracker.apply_receipts(q.drain_receipts());
        assert!(
            !tracker.persist_failed(),
            "disk holds the newer snapshot; persist_failed must not stick"
        );
        assert_eq!(tracker.pending_len(), 0);
        let recs = ReminderStateRepo::load_all(&store.inner, &a)
            .unwrap()
            .reconcile(crate::ReconcileEvidence::complete())
            .unwrap();
        assert_eq!(
            recs[0].version, 2,
            "older snapshot never overwrote the newer one"
        );
    }

    /// Counter-example for the panic path: a store bug that panics inside
    /// `commit` must not lose the jobs silently. The worker survives, the
    /// jobs come back as `Failed` so the tracker retries them, and the next
    /// batch is processed normally.
    #[test]
    fn a_panicking_commit_yields_a_failed_receipt_and_the_worker_survives() {
        let store = Gated::new(true);
        let q = PersistQueue::spawn(store.clone()).unwrap();
        let (a, b) = (ns("a"), ns("b"));
        let mut tracker = PersistTracker::new();
        store.panic_once.store(true, Ordering::SeqCst);
        // Both namespaces are in one batch; only the first commit panics.
        q.try_enqueue(job(&q, &a, JobPayload::Compensation(1)))
            .unwrap();
        q.try_enqueue(job(&q, &b, JobPayload::Compensation(2)))
            .unwrap();
        q.flush(Duration::from_secs(5)).unwrap();
        assert_eq!(q.stats().panics, 1);
        tracker.apply_receipts(q.drain_receipts());
        assert!(tracker.persist_failed(), "a panicked write is a failure");
        assert_eq!(tracker.pending_len(), 1, "the panicked job is parked");
        assert_eq!(
            SyncWatermarkRepo::compensation_cursor(&store.inner, &b).unwrap(),
            Some(2),
            "the other namespace of the batch is still written"
        );
        assert!(q.submit(tracker.take_pending()).is_empty());
        q.flush(Duration::from_secs(5)).unwrap();
        tracker.apply_receipts(q.drain_receipts());
        assert!(!tracker.persist_failed());
        assert_eq!(
            SyncWatermarkRepo::compensation_cursor(&store.inner, &a).unwrap(),
            Some(1)
        );
    }

    /// Rounds and compensation of one namespace share a commit: when it
    /// fails, **both** are parked and both land on the retry.
    #[test]
    fn one_failed_commit_parks_both_kinds_and_the_retry_lands_both() {
        let store = Gated::new(false);
        let q = PersistQueue::spawn(store.clone()).unwrap();
        let a = ns("a");
        let mut tracker = PersistTracker::new();
        store.fail.store(true, Ordering::SeqCst);
        q.try_enqueue(job(&q, &a, JobPayload::Rounds(vec![round("g", 3)])))
            .unwrap();
        q.try_enqueue(job(&q, &a, JobPayload::Compensation(30)))
            .unwrap();
        store.open();
        q.flush(Duration::from_secs(5)).unwrap();
        tracker.apply_receipts(q.drain_receipts());
        assert!(tracker.persist_failed());
        assert_eq!(tracker.pending_len(), 2, "rounds and compensation parked");
        store.fail.store(false, Ordering::SeqCst);
        let retry = tracker.take_pending();
        assert!(
            retry.windows(2).all(|w| w[0].seq < w[1].seq),
            "oldest first"
        );
        assert!(q.submit(retry).is_empty());
        q.flush(Duration::from_secs(5)).unwrap();
        tracker.apply_receipts(q.drain_receipts());
        assert!(!tracker.persist_failed());
        assert_eq!(
            SyncWatermarkRepo::compensation_cursor(&store.inner, &a).unwrap(),
            Some(30)
        );
        let recs = ReminderStateRepo::load_all(&store.inner, &a)
            .unwrap()
            .reconcile(crate::ReconcileEvidence::complete())
            .unwrap();
        assert_eq!(recs[0].version, 3);
        assert_eq!(
            store.commits.load(Ordering::SeqCst),
            1,
            "one commit for both"
        );
    }

    #[test]
    fn logout_lock_is_ordered_and_later_writes_are_skipped_not_failed() {
        let store = Gated::new(true);
        let q = PersistQueue::spawn(store.clone()).unwrap();
        let a = ns("a");
        q.try_enqueue(job(&q, &a, JobPayload::LogoutLock)).unwrap();
        q.try_enqueue(job(&q, &a, JobPayload::Rounds(vec![round("g", 1)])))
            .unwrap();
        q.flush(Duration::from_secs(5)).unwrap();
        let mut tracker = PersistTracker::new();
        tracker.apply_receipts(q.drain_receipts());
        assert!(store.is_locked(&a).unwrap());
        assert!(
            !tracker.persist_failed(),
            "locked namespace is not a failure"
        );
    }

    #[test]
    fn writes_before_a_lock_land_before_it() {
        let store = Gated::new(true);
        let q = PersistQueue::spawn(store.clone()).unwrap();
        let a = ns("a");
        q.try_enqueue(job(&q, &a, JobPayload::Compensation(5)))
            .unwrap();
        q.try_enqueue(job(&q, &a, JobPayload::LogoutLock)).unwrap();
        q.flush(Duration::from_secs(5)).unwrap();
        assert_eq!(
            SyncWatermarkRepo::compensation_cursor(&store.inner, &a).unwrap(),
            Some(5)
        );
        assert!(store.is_locked(&a).unwrap());
    }

    #[test]
    fn commits_run_on_the_persist_thread_only() {
        let dir = std::env::temp_dir().join(format!("core-store-queue-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Arc::new(FileStore::open(&dir).unwrap());
        let probe = crate::hooks::FsyncProbe::start(&dir);
        let q = PersistQueue::spawn(store.clone()).unwrap();
        let a = ns("a");
        let before = probe.count();
        q.try_enqueue(job(&q, &a, JobPayload::Compensation(1)))
            .unwrap();
        q.try_enqueue(job(&q, &a, JobPayload::LogoutLock)).unwrap();
        q.flush(Duration::from_secs(5)).unwrap();
        assert!(probe.count() > before);
        // Everything after the queue started is on vbk-persist.
        let off: Vec<_> = probe
            .events()
            .into_iter()
            .filter(|e| e.thread != PERSIST_THREAD)
            .collect();
        assert!(off.is_empty(), "fsync off the persist thread: {off:?}");
        drop(q);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

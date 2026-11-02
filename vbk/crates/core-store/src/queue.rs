//! Bounded nonblocking handoff to the sole `vbk-persist` snapshot writer.
//!
//! Jobs are complete namespace snapshots, so keeping only the greatest seq
//! cannot drop a compensation update when a rounds update overtakes it.
use std::collections::HashMap;
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use contracts::{json::JsonValue, AppError};

use crate::{codes, FileStore, Namespace, ReminderStateRepo, RoundRecord, Store, SyncWatermarkRepo};

pub const QUEUE_CAPACITY: usize = 256;

#[derive(Debug, Clone)]
pub struct PersistJob {
    pub ns: Namespace,
    pub seq: u64,
    pub rounds: Option<Vec<RoundRecord>>,
    pub compensation_cursor_ms: Option<i64>,
    /// Commit the final snapshot before making the namespace read-only.
    pub logout_lock: bool,
    /// Only set following verified reauthentication.
    pub unlock_before_write: bool,
}

#[derive(Debug, Clone)]
pub struct PersistReceipt {
    pub ns: Namespace,
    pub seq: u64,
    pub result: Result<(), AppError>,
}

enum Message {
    Snapshot(PersistJob),
    Flush(mpsc::Sender<Result<(), AppError>>),
}

/// Single consumer; producers never wait for filesystem IO. When full the
/// caller retains the returned job in its per-namespace pending map.
pub struct PersistQueue {
    sender: mpsc::SyncSender<Message>,
    receipts: Mutex<mpsc::Receiver<PersistReceipt>>,
}

impl std::fmt::Debug for PersistQueue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PersistQueue").finish_non_exhaustive()
    }
}

impl PersistQueue {
    pub fn new(store: FileStore) -> Result<Self, AppError> {
        Self::spawn(QUEUE_CAPACITY, move |job| write_snapshot(&store, job))
    }

    fn spawn(
        capacity: usize,
        mut write: impl FnMut(&PersistJob) -> Result<(), AppError> + Send + 'static,
    ) -> Result<Self, AppError> {
        let (sender, receiver) = mpsc::sync_channel(capacity);
        let (status, receipts) = mpsc::channel();
        thread::Builder::new().name("vbk-persist".into()).spawn(move || {
            let mut written: HashMap<Namespace, u64> = HashMap::new();
            let mut attempted: HashMap<Namespace, u64> = HashMap::new();
            let mut failures: HashMap<Namespace, AppError> = HashMap::new();
            while let Ok(first) = receiver.recv() {
                let mut pending: HashMap<Namespace, PersistJob> = HashMap::new();
                let mut barrier = None;
                let mut next = Some(first);
                while let Some(message) = next {
                    match message {
                        Message::Snapshot(job) => coalesce(&mut pending, job),
                        Message::Flush(ack) => { barrier = Some(ack); break; }
                    }
                    next = receiver.try_recv().ok();
                }
                for (_, job) in pending {
                    if attempted.get(&job.ns).is_some_and(|seq| *seq > job.seq)
                        || written.get(&job.ns).is_some_and(|seq| *seq >= job.seq) {
                        continue;
                    }
                    attempted.insert(job.ns.clone(), job.seq);
                    let result = write(&job);
                    if let Err(error) = &result {
                        failures.insert(job.ns.clone(), error.clone());
                    } else {
                        written.insert(job.ns.clone(), job.seq);
                        failures.remove(&job.ns);
                    }
                    let _ = status.send(PersistReceipt { ns: job.ns, seq: job.seq, result });
                }
                if let Some(ack) = barrier {
                    let _ = ack.send(failures.values().next().cloned().map_or(Ok(()), Err));
                }
            }
        }).map_err(|e| AppError::new(codes::STORE_IO, format!("start persistence worker: {e}")))?;
        Ok(Self { sender, receipts: Mutex::new(receipts) })
    }

    #[allow(clippy::result_large_err)]
    pub fn try_enqueue(&self, job: PersistJob) -> Result<(), PersistJob> {
        match self.sender.try_send(Message::Snapshot(job)) {
            Ok(()) => Ok(()),
            Err(mpsc::TrySendError::Full(Message::Snapshot(job)) |
                mpsc::TrySendError::Disconnected(Message::Snapshot(job))) => Err(job),
            _ => unreachable!("only snapshots are submitted here"),
        }
    }

    pub fn drain_receipts(&self) -> Vec<PersistReceipt> {
        self.receipts.lock().unwrap_or_else(|p| p.into_inner()).try_iter().collect()
    }

    /// Waits only on explicit shutdown / maintenance paths. The deadline also
    /// covers obtaining space for the barrier; never hold a cores lock here.
    pub fn flush(&self, timeout: Duration) -> Result<(), AppError> {
        let deadline = Instant::now() + timeout;
        let (ack, result) = mpsc::channel();
        let mut message = Message::Flush(ack);
        loop {
            match self.sender.try_send(message) {
                Ok(()) => break,
                Err(mpsc::TrySendError::Disconnected(_)) => return Err(worker_unavailable()),
                Err(mpsc::TrySendError::Full(returned)) => message = returned,
            }
            if Instant::now() >= deadline { return Err(flush_timeout()); }
            thread::sleep(Duration::from_millis(1));
        }
        result.recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .map_err(|_| flush_timeout())?
    }
}

pub fn coalesce(pending: &mut HashMap<Namespace, PersistJob>, job: PersistJob) {
    if pending.get(&job.ns).map_or(true, |old| job.seq > old.seq) {
        pending.insert(job.ns.clone(), job);
    }
}

fn worker_unavailable() -> AppError {
    AppError::new("store.worker_unavailable", "local persistence worker stopped")
}
fn flush_timeout() -> AppError {
    AppError::new("store.flush_timeout", "local persistence flush deadline exceeded")
}

fn write_snapshot(store: &FileStore, job: &PersistJob) -> Result<(), AppError> {
    // A separate feature transaction can race between begin and commit.
    // Rebuild only on an explicit CAS failure, never retry unknown IO outcomes.
    if job.unlock_before_write { store.unlock_after_reauth(&job.ns)?; }
    for _ in 0..8 {
        let mut txn = store.begin(&job.ns)?;
        if let Some(rounds) = &job.rounds {
            for (key, _) in store.list(&job.ns, crate::repo::reminder::COLLECTION)? {
                txn.delete(crate::repo::reminder::COLLECTION, &key);
            }
            for record in rounds { ReminderStateRepo::put(&mut txn, record); }
        }
        if let Some(ms) = job.compensation_cursor_ms {
            SyncWatermarkRepo::set_compensation_cursor(&mut txn, ms);
        }
        txn.put("persistence", "snapshot_seq", JsonValue::number_from_i64(job.seq as i64));
        match store.commit(txn) {
            Err(error) if error.is(codes::STORE_CAS_CONFLICT) => continue,
            result => { result?; if job.logout_lock { store.logout_lock(&job.ns)?; } return Ok(()); }
        }
    }
    Err(AppError::new(codes::STORE_CAS_CONFLICT, "snapshot writer contention"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use contracts::{AccountId, Environment};
    use std::sync::Arc;

    fn job(account: &str, seq: u64) -> PersistJob {
        PersistJob { ns: Namespace::new(Environment::named("test"), AccountId::new(account)),
            seq, rounds: Some(Vec::new()), compensation_cursor_ms: Some(seq as i64), logout_lock: false, unlock_before_write: false }
    }

    #[test]
    fn bounded_handoff_returns_newest_job_without_waiting_for_disk() {
        let (entered, waiting) = mpsc::channel();
        let (resume, blocked) = mpsc::channel();
        let queue = PersistQueue::spawn(1, move |_| {
            entered.send(()).expect("signal"); blocked.recv().expect("resume"); Ok(())
        }).expect("worker");
        queue.try_enqueue(job("a", 1)).expect("first");
        waiting.recv_timeout(Duration::from_secs(2)).expect("writing");
        queue.try_enqueue(job("a", 2)).expect("queued");
        assert_eq!(queue.try_enqueue(job("a", 3)).expect_err("full").seq, 3);
        resume.send(()).expect("resume first");
        waiting.recv_timeout(Duration::from_secs(2)).expect("second writing");
        resume.send(()).expect("resume second");
        queue.flush(Duration::from_secs(2)).expect("flush");
    }

    #[test]
    fn two_namespaces_10000_reordered_jobs_never_regress_and_write_off_thread() {
        let observed = Arc::new(Mutex::new(HashMap::<Namespace, u64>::new()));
        let writes = observed.clone();
        let queue = PersistQueue::spawn(256, move |job| {
            assert_eq!(thread::current().name(), Some("vbk-persist"));
            let mut written = writes.lock().expect("observations");
            assert!(written.get(&job.ns).map_or(true, |seq| *seq < job.seq));
            written.insert(job.ns.clone(), job.seq); Ok(())
        }).expect("worker");
        let mut pending = HashMap::new();
        for seq in (1..=5000).rev() {
            for account in ["a", "b"] {
                if let Err(job) = queue.try_enqueue(job(account, seq)) { coalesce(&mut pending, job); }
            }
        }
        for (_, mut job) in pending {
            loop { match queue.try_enqueue(job) { Ok(()) => break, Err(returned) => job = returned }; thread::yield_now(); }
        }
        queue.flush(Duration::from_secs(3)).expect("flush");
        let written = observed.lock().expect("observations");
        assert_eq!(written[&job("a", 0).ns], 5000);
        assert_eq!(written[&job("b", 0).ns], 5000);
    }

    #[test]
    fn failures_reach_receipts_and_flush_and_next_success_recovers() {
        let queue = PersistQueue::spawn(4, |job| {
            if job.seq == 1 { Err(AppError::new(codes::STORE_IO, "injected ENOSPC")) } else { Ok(()) }
        }).expect("worker");
        queue.try_enqueue(job("a", 1)).expect("enqueue");
        assert!(queue.flush(Duration::from_secs(2)).expect_err("failed").is(codes::STORE_IO));
        assert!(queue.drain_receipts()[0].result.is_err());
        queue.try_enqueue(job("a", 2)).expect("enqueue recovery");
        queue.flush(Duration::from_secs(2)).expect("recovered");
        assert!(queue.drain_receipts()[0].result.is_ok());
    }
}

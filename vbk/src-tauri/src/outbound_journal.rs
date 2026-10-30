//! Durable, body-free outbound attempt boundary for the actual host command.
//! Namespace is stable across login generations. Dispatch is admitted only after
//! write_started is committed and synced; this is never a resend queue.

use std::fs::{File, OpenOptions};
use std::future::Future;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use contracts::json::JsonValue;
use contracts::{AccountContext, AppError};
use core_store::{FileStore, Namespace, Store};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::dto::SendDispositionDto;

const COLLECTION: &str = "outbound_attempts";
const GENERIC_REJECTION_REASON: &str = "upstream rejected the send (details not persisted)";

#[derive(Clone, Serialize)]
pub struct SendPayload {
    pub gid: String,
    pub text: String,
    pub original: Option<String>,
    pub quote_id: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Phase {
    WriteStarted,
    Unknown,
    Completed,
}

#[derive(Clone, Serialize, Deserialize)]
struct Attempt {
    schema: u8,
    environment: String,
    account_id: String,
    local_id: String,
    gid: String,
    creation_generation: u64,
    payload_sha256: String,
    created_at_ms: i64,
    completed_at_ms: Option<i64>,
    phase: Phase,
    disposition: SendDispositionDto,
}

/// Read-only recovery metadata. Deliberately excludes the payload and its hash;
/// these rows authorize investigation, never another upstream submission.
#[derive(Clone, Serialize, PartialEq, Eq)]
pub struct UnknownAttemptMetadata {
    pub environment: String,
    pub account_id: String,
    pub local_id: String,
    pub gid: String,
    pub creation_generation: u64,
    pub created_at_ms: i64,
    pub write_started: bool,
    pub phase: String,
}

pub struct OutboundJournal {
    store: FileStore,
}

impl std::fmt::Debug for OutboundJournal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OutboundJournal").finish_non_exhaustive()
    }
}

fn io_error() -> AppError {
    AppError::new(
        "im.journal_io",
        "durable outbound storage failed; nothing is automatically resent",
    )
}
fn corrupt() -> AppError {
    AppError::new(
        "im.journal_corrupt",
        "outbound attempt record is invalid; no write is permitted",
    )
}
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

struct WriterLock(File);
impl Drop for WriterLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

enum Reservation {
    New,
    Existing(SendDispositionDto),
}

fn payload_hash(payload: &SendPayload) -> Result<String, AppError> {
    // Struct field order is fixed. The digest covers gid/text/original/quote_id,
    // including null-vs-empty, but never a transient authorization generation.
    let bytes = serde_json::to_vec(payload).map_err(|_| corrupt())?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

impl OutboundJournal {
    pub fn open(root: impl Into<PathBuf>) -> Result<Self, AppError> {
        Ok(Self {
            store: FileStore::open(root)?,
        })
    }

    fn writer_lock(&self) -> Result<WriterLock, AppError> {
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options
            .open(self.store.root().join(".writer.lock"))
            .map_err(|_| io_error())?;
        FileExt::lock_exclusive(&file).map_err(|_| io_error())?;
        Ok(WriterLock(file))
    }

    /// FileStore's file fsync/rename is complemented by a strict metadata
    /// barrier. Sync every ancestor so a newly created namespace/root cannot
    /// disappear after dispatch. Unsupported directory sync fails closed.
    fn durability_barrier(&self, ns: &Namespace) -> Result<(), AppError> {
        let dir = self.store.namespace_dir(ns);
        File::open(dir.join("state.json"))
            .and_then(|f| f.sync_all())
            .map_err(|_| io_error())?;
        for ancestor in dir.ancestors() {
            File::open(ancestor)
                .and_then(|f| f.sync_all())
                .map_err(|_| io_error())?;
        }
        Ok(())
    }

    fn decode(
        value: &JsonValue,
        account: &AccountContext,
        local_id: &str,
    ) -> Result<Attempt, AppError> {
        let row: Attempt = serde_json::from_str(&value.to_json()).map_err(|_| corrupt())?;
        if row.schema != 1
            || row.environment != account.environment.as_str()
            || row.account_id != account.account_id.as_str()
            || row.local_id != local_id
            || row.gid.is_empty()
            || row.payload_sha256.len() != 64
            || !row.payload_sha256.bytes().all(|c| c.is_ascii_hexdigit())
        {
            return Err(corrupt());
        }
        match (&row.phase, &row.disposition) {
            (
                Phase::Completed,
                SendDispositionDto::Confirmed {
                    server_message_id, ..
                },
            ) if !server_message_id.trim().is_empty() => {}
            (Phase::Completed, SendDispositionDto::Rejected { code, .. }) if !code.is_empty() => {}
            (Phase::WriteStarted | Phase::Unknown, SendDispositionDto::Unknown) => {}
            _ => return Err(corrupt()),
        }
        Ok(row)
    }

    fn value(row: &Attempt) -> Result<JsonValue, AppError> {
        JsonValue::parse(&serde_json::to_string(row).map_err(|_| corrupt())?).map_err(|_| corrupt())
    }

    fn reserve(
        &self,
        account: &AccountContext,
        local_id: &str,
        payload: &SendPayload,
    ) -> Result<Reservation, AppError> {
        if local_id.is_empty() || payload.gid.is_empty() || payload.text.trim().is_empty() {
            return Err(AppError::new(
                "im.invalid_send",
                "outbound identity and text are required (nothing sent)",
            ));
        }
        if core_store::looks_secret_like(local_id) || core_store::looks_secret_like(&payload.gid) {
            return Err(AppError::new(
                "im.invalid_send",
                "invalid outbound identifier (nothing sent)",
            ));
        }
        let _writer = self.writer_lock()?;
        let ns = Namespace::from_context(account);
        let digest = payload_hash(payload)?;
        if let Some(current) = self.store.get(&ns, COLLECTION, local_id)? {
            let existing = Self::decode(&current, account, local_id)?;
            if existing.payload_sha256 != digest {
                return Err(AppError::new(
                    "im.intent_conflict",
                    "local_id already belongs to a different outbound payload (nothing sent)",
                ));
            }
            // No record, including write_started left by a crash, authorizes a
            // second dispatch. A terminal read is durable before it is exposed.
            if self.durability_barrier(&ns).is_err() {
                return Ok(Reservation::Existing(SendDispositionDto::Unknown));
            }
            return Ok(Reservation::Existing(existing.disposition));
        }
        let row = Attempt {
            schema: 1,
            environment: account.environment.as_str().into(),
            account_id: account.account_id.as_str().into(),
            local_id: local_id.into(),
            gid: payload.gid.clone(),
            creation_generation: account.session_generation,
            payload_sha256: digest,
            created_at_ms: now_ms(),
            completed_at_ms: None,
            phase: Phase::WriteStarted,
            disposition: SendDispositionDto::Unknown,
        };
        let mut tx = self.store.begin(&ns)?;
        tx.expect_unchanged(COLLECTION, local_id, None);
        tx.put(COLLECTION, local_id, Self::value(&row)?);
        self.store.commit(tx)?;
        self.durability_barrier(&ns)?;
        Ok(Reservation::New)
    }

    fn finish(
        &self,
        account: &AccountContext,
        local_id: &str,
        payload: &SendPayload,
        disposition: SendDispositionDto,
    ) -> Result<SendDispositionDto, AppError> {
        let _writer = self.writer_lock()?;
        let ns = Namespace::from_context(account);
        let current = self
            .store
            .get(&ns, COLLECTION, local_id)?
            .ok_or_else(corrupt)?;
        let mut row = Self::decode(&current, account, local_id)?;
        if row.payload_sha256 != payload_hash(payload)? {
            return Err(corrupt());
        }
        if row.phase == Phase::Completed {
            self.durability_barrier(&ns)?;
            return Ok(row.disposition);
        }
        let observed = match disposition {
            SendDispositionDto::Confirmed {
                ref server_message_id,
                ..
            } if server_message_id.trim().is_empty() => SendDispositionDto::Unknown,
            SendDispositionDto::Rejected { ref code, .. } if code.is_empty() => {
                SendDispositionDto::Unknown
            }
            valid => valid,
        };
        // SDK failure reasons may echo text, originals or other request data.
        // Keep the live result for this caller, but persist only a generic reason.
        row.disposition = match &observed {
            SendDispositionDto::Rejected { code, .. } => SendDispositionDto::Rejected {
                code: code.clone(),
                reason: GENERIC_REJECTION_REASON.into(),
            },
            other => other.clone(),
        };
        row.phase = if row.disposition == SendDispositionDto::Unknown {
            Phase::Unknown
        } else {
            Phase::Completed
        };
        row.completed_at_ms = Some(now_ms());
        let mut tx = self.store.begin(&ns)?;
        tx.expect_unchanged(COLLECTION, local_id, Some(current));
        tx.put(COLLECTION, local_id, Self::value(&row)?);
        self.store.commit(tx)?;
        self.durability_barrier(&ns)?;
        Ok(observed)
    }

    pub fn unknown_metadata(
        &self,
        account: &AccountContext,
    ) -> Result<Vec<UnknownAttemptMetadata>, AppError> {
        let _writer = self.writer_lock()?;
        self.store
            .list(&Namespace::from_context(account), COLLECTION)?
            .into_iter()
            .filter_map(|(key, value)| match Self::decode(&value, account, &key) {
                Ok(row) if row.phase != Phase::Completed => Some(Ok(UnknownAttemptMetadata {
                    environment: row.environment,
                    account_id: row.account_id,
                    local_id: row.local_id,
                    gid: row.gid,
                    creation_generation: row.creation_generation,
                    created_at_ms: row.created_at_ms,
                    write_started: true,
                    phase: if row.phase == Phase::WriteStarted {
                        "write_started"
                    } else {
                        "unknown"
                    }
                    .into(),
                })),
                Ok(_) => None,
                Err(error) => Some(Err(error)),
            })
            .collect()
    }
}

/// Actual host helper. Neither the host mutex nor the OS writer lock is held
/// across dispatch.await. Only the durable New reservation admits this closure.
pub async fn send_once<F, Fut>(
    journal: &Mutex<OutboundJournal>,
    account: &AccountContext,
    local_id: &str,
    payload: &SendPayload,
    dispatch: F,
) -> Result<SendDispositionDto, AppError>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<SendDispositionDto, AppError>>,
{
    let reservation = journal
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .reserve(account, local_id, payload)?;
    if let Reservation::Existing(saved) = reservation {
        return Ok(saved);
    }
    let observed = dispatch().await.unwrap_or(SendDispositionDto::Unknown);
    // A failed completion cannot erase the durable write_started safety fence.
    Ok(journal
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .finish(account, local_id, payload, observed)
        .unwrap_or(SendDispositionDto::Unknown))
}

#[cfg(test)]
mod tests {
    use super::*;
    use contracts::{AccountId, Environment};
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("vbk-outbound-test-{}", uuid::Uuid::new_v4())))
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn account(generation: u64) -> AccountContext {
        AccountContext::new(
            AccountId::new("synthetic-account"),
            Environment::named("test"),
            generation,
        )
    }
    fn payload() -> SendPayload {
        SendPayload {
            gid: "900719925474099312345".into(),
            text: "synthetic private payload".into(),
            original: Some("synthetic original".into()),
            quote_id: Some("9223372036854775806".into()),
        }
    }
    fn journal(root: &TempDir) -> Mutex<OutboundJournal> {
        Mutex::new(OutboundJournal::open(root.0.clone()).unwrap())
    }
    fn run<T>(future: impl Future<Output = T>) -> T {
        // Helpers perform real synchronous FileStore IO; the dispatch fixtures
        // resolve immediately, so no alternate persistence backend is involved.
        struct Noop;
        impl std::task::Wake for Noop {
            fn wake(self: std::sync::Arc<Self>) {}
        }
        let waker = std::task::Waker::from(std::sync::Arc::new(Noop));
        let mut cx = std::task::Context::from_waker(&waker);
        let mut future = std::pin::pin!(future);
        loop {
            if let std::task::Poll::Ready(value) = future.as_mut().poll(&mut cx) {
                return value;
            }
        }
    }

    #[test]
    fn write_started_is_on_disk_before_dispatch_and_crash_recovers_unknown() {
        use core_store::{Namespace, Store};
        let root = TempDir::new();
        let first = journal(&root);
        let crashed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run(send_once(
                &first,
                &account(1),
                "synthetic-local",
                &payload(),
                || async {
                    let entry = first
                        .lock()
                        .unwrap()
                        .store
                        .get(
                            &Namespace::from_context(&account(1)),
                            "outbound_attempts",
                            "synthetic-local",
                        )
                        .unwrap();
                    assert!(
                        entry.is_some(),
                        "write_started must exist before invoking the real dispatch seam"
                    );
                    panic!("synthetic crash after durable reservation");
                    #[allow(unreachable_code)]
                    Ok(SendDispositionDto::Unknown)
                },
            ))
        }));
        assert!(crashed.is_err());
        drop(first);
        let reopened = journal(&root);
        let calls = AtomicUsize::new(0);
        let result = run(send_once(
            &reopened,
            &account(2),
            "synthetic-local",
            &payload(),
            || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(SendDispositionDto::Unknown)
            },
        ))
        .unwrap();
        assert_eq!(result, SendDispositionDto::Unknown);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_real_store_failure_before_write_forbids_dispatch() {
        use core_store::{Namespace, Store};
        let root = TempDir::new();
        let journal = journal(&root);
        let calls = AtomicUsize::new(0);
        journal
            .lock()
            .unwrap()
            .store
            .logout_lock(&Namespace::from_context(&account(1)))
            .unwrap();
        assert!(run(send_once(
            &journal,
            &account(1),
            "synthetic-local",
            &payload(),
            || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(SendDispositionDto::Unknown)
            }
        ))
        .is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_real_store_failure_after_dispatch_returns_unknown_and_never_replays() {
        use core_store::{Namespace, Store};
        let root = TempDir::new();
        let journal = journal(&root);
        let calls = AtomicUsize::new(0);
        let result = run(send_once(
            &journal,
            &account(1),
            "synthetic-local",
            &payload(),
            || async {
                calls.fetch_add(1, Ordering::SeqCst);
                journal
                    .lock()
                    .unwrap()
                    .store
                    .logout_lock(&Namespace::from_context(&account(1)))
                    .unwrap();
                Ok(SendDispositionDto::Confirmed {
                    server_message_id: "synthetic-server".into(),
                    server_time_ms: 1700000000123,
                })
            },
        ))
        .unwrap();
        assert_eq!(result, SendDispositionDto::Unknown);
        assert_eq!(
            run(send_once(
                &journal,
                &account(2),
                "synthetic-local",
                &payload(),
                || async {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(SendDispositionDto::Unknown)
                }
            ))
            .unwrap(),
            SendDispositionDto::Unknown
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn unknown_survives_host_helper_reconstruction_and_generation_change_without_resend() {
        let root = TempDir::new();
        let calls = AtomicUsize::new(0);
        let first = journal(&root);
        assert_eq!(
            run(send_once(
                &first,
                &account(1),
                "synthetic-local",
                &payload(),
                || async {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(SendDispositionDto::Unknown)
                }
            ))
            .unwrap(),
            SendDispositionDto::Unknown
        );
        drop(first);
        let reopened = journal(&root);
        assert_eq!(
            run(send_once(
                &reopened,
                &account(99),
                "synthetic-local",
                &payload(),
                || async {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(SendDispositionDto::Unknown)
                }
            ))
            .unwrap(),
            SendDispositionDto::Unknown
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn same_key_different_payload_is_rejected_before_dispatch() {
        let root = TempDir::new();
        let journal = journal(&root);
        let calls = AtomicUsize::new(0);
        run(send_once(
            &journal,
            &account(1),
            "synthetic-local",
            &payload(),
            || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(SendDispositionDto::Unknown)
            },
        ))
        .unwrap();
        let mut changed = payload();
        changed.text = "different synthetic private payload".into();
        assert!(run(send_once(
            &journal,
            &account(1),
            "synthetic-local",
            &changed,
            || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(SendDispositionDto::Unknown)
            }
        ))
        .is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn confirmed_and_rejected_are_saved_before_return_and_replayed_after_reopen() {
        for outcome in [
            SendDispositionDto::Confirmed {
                server_message_id: "9223372036854775806".into(),
                server_time_ms: 1700000000123,
            },
            SendDispositionDto::Rejected {
                code: "7".into(),
                reason: "upstream rejected the send (details not persisted)".into(),
            },
        ] {
            let root = TempDir::new();
            let first = journal(&root);
            run(send_once(
                &first,
                &account(1),
                "synthetic-local",
                &payload(),
                || async { Ok(outcome.clone()) },
            ))
            .unwrap();
            drop(first);
            let reopened = journal(&root);
            let calls = AtomicUsize::new(0);
            let saved = run(send_once(
                &reopened,
                &account(2),
                "synthetic-local",
                &payload(),
                || async {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(SendDispositionDto::Unknown)
                },
            ))
            .unwrap();
            assert_eq!(saved, outcome);
            assert_eq!(calls.load(Ordering::SeqCst), 0);
        }
    }
    #[test]
    fn recovery_metadata_is_body_free_and_scoped_to_stable_identity() {
        let root = TempDir::new();
        let first = journal(&root);
        run(send_once(
            &first,
            &account(1),
            "synthetic-local",
            &payload(),
            || async { Ok(SendDispositionDto::Unknown) },
        ))
        .unwrap();
        let entries = first
            .lock()
            .unwrap()
            .unknown_metadata(&account(88))
            .unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].creation_generation, 1);
        assert_eq!(entries[0].phase, "unknown");
        assert_eq!(entries[0].gid, "900719925474099312345");
        let json = serde_json::to_string(&entries).unwrap();
        assert!(!json.contains(&payload().text));
        assert!(!json.contains(payload().original.as_ref().unwrap()));
        assert!(!json.contains("sha256"));
        let other = AccountContext::new(
            AccountId::new("another-account"),
            Environment::named("test"),
            1,
        );
        assert!(first
            .lock()
            .unwrap()
            .unknown_metadata(&other)
            .unwrap()
            .is_empty());
        let disk = std::fs::read_to_string(
            first
                .lock()
                .unwrap()
                .store
                .namespace_dir(&core_store::Namespace::from_context(&account(1)))
                .join("state.json"),
        )
        .unwrap();
        assert!(!disk.contains(&payload().text));
        assert!(!disk.contains(payload().original.as_ref().unwrap()));
        assert!(disk.contains("payload_sha256"));
    }

    #[test]
    fn scope_is_environment_and_account_not_generation_and_payload_covers_every_field() {
        let root = TempDir::new();
        let journal = journal(&root);
        let calls = AtomicUsize::new(0);
        run(send_once(
            &journal,
            &account(1),
            "synthetic-local",
            &payload(),
            || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(SendDispositionDto::Unknown)
            },
        ))
        .unwrap();
        for field in ["gid", "text", "original", "quote_id"] {
            let mut changed = payload();
            match field {
                "gid" => changed.gid = "other-gid".into(),
                "text" => changed.text = "other text".into(),
                "original" => changed.original = None,
                _ => changed.quote_id = Some("other-quote".into()),
            }
            assert!(run(send_once(
                &journal,
                &account(9),
                "synthetic-local",
                &changed,
                || async {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(SendDispositionDto::Unknown)
                }
            ))
            .is_err());
        }
        let other_account = AccountContext::new(
            AccountId::new("another-account"),
            Environment::named("test"),
            1,
        );
        let other_environment = AccountContext::new(
            AccountId::new("synthetic-account"),
            Environment::named("other-test"),
            1,
        );
        for context in [other_account, other_environment] {
            run(send_once(
                &journal,
                &context,
                "synthetic-local",
                &payload(),
                || async {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(SendDispositionDto::Unknown)
                },
            ))
            .unwrap();
        }
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn two_actual_file_store_instances_cannot_dispatch_the_same_intent_concurrently() {
        use std::sync::{mpsc, Arc};
        use std::time::Duration;
        let root = TempDir::new();
        let first_root = root.0.clone();
        let second_root = root.0.clone();
        let calls = Arc::new(AtomicUsize::new(0));
        let first_calls = calls.clone();
        let second_calls = calls.clone();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let first = std::thread::spawn(move || {
            let journal = Mutex::new(OutboundJournal::open(first_root).unwrap());
            run(send_once(
                &journal,
                &account(1),
                "synthetic-local",
                &payload(),
                || async {
                    first_calls.fetch_add(1, Ordering::SeqCst);
                    ready_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Ok(SendDispositionDto::Unknown)
                },
            ))
        });
        ready_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        let (second_tx, second_rx) = mpsc::channel();
        let second = std::thread::spawn(move || {
            let journal = Mutex::new(OutboundJournal::open(second_root).unwrap());
            let result = run(send_once(
                &journal,
                &account(7),
                "synthetic-local",
                &payload(),
                || async {
                    second_calls.fetch_add(1, Ordering::SeqCst);
                    Ok(SendDispositionDto::Unknown)
                },
            ));
            second_tx.send(result).unwrap();
        });
        let second_result = second_rx.recv_timeout(Duration::from_secs(3));
        release_tx.send(()).unwrap();
        assert_eq!(first.join().unwrap().unwrap(), SendDispositionDto::Unknown);
        second.join().unwrap();
        assert_eq!(second_result.unwrap().unwrap(), SendDispositionDto::Unknown);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn malformed_persistent_state_fails_closed_instead_of_resetting_and_resending() {
        let root = TempDir::new();
        let journal = journal(&root);
        let calls = AtomicUsize::new(0);
        run(send_once(
            &journal,
            &account(1),
            "synthetic-local",
            &payload(),
            || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(SendDispositionDto::Unknown)
            },
        ))
        .unwrap();
        let path = journal
            .lock()
            .unwrap()
            .store
            .namespace_dir(&core_store::Namespace::from_context(&account(1)))
            .join("state.json");
        std::fs::write(path, b"{partial synthetic document").unwrap();
        for _ in 0..2 {
            assert!(run(send_once(
                &journal,
                &account(2),
                "synthetic-local",
                &payload(),
                || async {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(SendDispositionDto::Unknown)
                }
            ))
            .is_err());
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn real_filesystem_failure_before_reservation_never_calls_dispatch() {
        let root = TempDir::new();
        let journal = journal(&root);
        let calls = AtomicUsize::new(0);
        std::fs::write(root.0.join("env"), b"synthetic filesystem obstruction").unwrap();
        assert!(run(send_once(
            &journal,
            &account(1),
            "synthetic-local",
            &payload(),
            || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(SendDispositionDto::Unknown)
            }
        ))
        .is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn real_filesystem_failure_after_dispatch_keeps_durable_reservation_and_recovery_does_not_resend(
    ) {
        let root = TempDir::new();
        let first = journal(&root);
        let calls = AtomicUsize::new(0);
        let ns = core_store::Namespace::from_context(&account(1));
        let namespace_dir = first.lock().unwrap().store.namespace_dir(&ns);
        let backup_dir = namespace_dir.with_extension("synthetic-unavailable");
        let result = run(send_once(
            &first,
            &account(1),
            "synthetic-local",
            &payload(),
            || async {
                calls.fetch_add(1, Ordering::SeqCst);
                std::fs::rename(&namespace_dir, &backup_dir).unwrap();
                std::fs::write(&namespace_dir, b"synthetic filesystem obstruction").unwrap();
                Ok(SendDispositionDto::Confirmed {
                    server_message_id: "synthetic-server".into(),
                    server_time_ms: 1700000000123,
                })
            },
        ))
        .unwrap();
        assert_eq!(result, SendDispositionDto::Unknown);
        drop(first);
        let reopened = journal(&root);
        assert!(run(send_once(
            &reopened,
            &account(2),
            "synthetic-local",
            &payload(),
            || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(SendDispositionDto::Unknown)
            }
        ))
        .is_err());
        std::fs::remove_file(&namespace_dir).unwrap();
        std::fs::rename(&backup_dir, &namespace_dir).unwrap();
        assert_eq!(
            run(send_once(
                &reopened,
                &account(3),
                "synthetic-local",
                &payload(),
                || async {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(SendDispositionDto::Unknown)
                }
            ))
            .unwrap(),
            SendDispositionDto::Unknown
        );
        let rows = reopened
            .lock()
            .unwrap()
            .unknown_metadata(&account(3))
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].phase, "write_started");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn rejected_reason_echoing_text_or_original_never_reaches_the_file_store() {
        for echoed in [payload().text, payload().original.unwrap()] {
            let root = TempDir::new();
            let first = journal(&root);
            let live = SendDispositionDto::Rejected {
                code: "7".into(),
                reason: echoed.clone(),
            };
            assert_eq!(
                run(send_once(
                    &first,
                    &account(1),
                    "synthetic-local",
                    &payload(),
                    || async { Ok(live.clone()) }
                ))
                .unwrap(),
                live
            );
            let path = first
                .lock()
                .unwrap()
                .store
                .namespace_dir(&core_store::Namespace::from_context(&account(1)))
                .join("state.json");
            let disk = std::fs::read_to_string(path).unwrap();
            assert!(
                !disk.contains(&payload().text),
                "journal must not persist a rejection's echoed outbound text"
            );
            assert!(
                !disk.contains(payload().original.as_ref().unwrap()),
                "journal must not persist a rejection's echoed original text"
            );
            drop(first);
            let reopened = journal(&root);
            let calls = AtomicUsize::new(0);
            let saved = run(send_once(
                &reopened,
                &account(2),
                "synthetic-local",
                &payload(),
                || async {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(SendDispositionDto::Unknown)
                },
            ))
            .unwrap();
            assert_eq!(
                saved,
                SendDispositionDto::Rejected {
                    code: "7".into(),
                    reason: "upstream rejected the send (details not persisted)".into()
                }
            );
            assert_eq!(calls.load(Ordering::SeqCst), 0);
        }
    }
}

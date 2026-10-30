//! Durable safety boundary for invite, transfer and finish; never a retry queue.
use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::future::Future;
use std::path::PathBuf;
use std::sync::Mutex;

use contracts::json::JsonValue;
use contracts::{AccountContext, AppError};
use core_store::{FileStore, Namespace, Store};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::adapter::display::{PeripheralWriteKindDto as Kind, UiPeripheralWriteDto as Outcome};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Invite,
    Transfer,
    Finish,
}

pub struct Intent {
    pub gid: String,
    pub action: Action,
    pub targets: Vec<String>,
    pub selection_token: String,
}

pub struct PeripheralJournal {
    store: FileStore,
}
const COLLECTION: &str = "peripheral_attempts";
const MAX_RELEASED_INTENTS: usize = 4096;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Phase {
    WriteStarted,
    Unknown,
    Accepted,
    Released,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Release {
    Confirmed,
    NotSubmitted,
}
#[derive(Serialize, Deserialize)]
struct Record {
    schema: u8,
    identity_sha256: String,
    gid: String,
    action: Action,
    attempt_id: String,
    intent_sha256: String,
    creation_generation: u64,
    phase: Phase,
    // Tombstones are body-free and never evicted. If the cap is reached,
    // admission fails closed rather than allowing an old token to run again.
    released: BTreeMap<String, Release>,
    // Tokens seen while another intent is unresolved remain non-dispatching
    // even if that first intent later confirms. true means accepted, not final.
    blocked: BTreeMap<String, bool>,
}
struct Ticket {
    key: String,
    intent_hash: String,
    attempt_id: String,
}
enum Reservation {
    New(Ticket),
    Existing(Outcome),
}
struct WriterLock(File);
impl Drop for WriterLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}
fn storage_error() -> AppError {
    AppError::new(
        "im.peripheral_journal_io",
        "durable peripheral storage failed; do not automatically resubmit",
    )
}
fn corrupt() -> AppError {
    AppError::new(
        "im.peripheral_journal_corrupt",
        "peripheral journal is invalid; no write is permitted",
    )
}
fn hash(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}
fn is_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|c| c.is_ascii_hexdigit())
}
fn unknown() -> Outcome {
    Outcome {
        kind: Kind::Unknown,
        confirmed: false,
        reason: Some(
            "prior peripheral submission is unresolved; read back and do not resubmit".into(),
        ),
    }
}
fn pending(accepted: bool) -> Outcome {
    if accepted {
        Outcome {
            kind: Kind::Accepted,
            confirmed: false,
            reason: Some("prior acceptance remains unconfirmed; do not resubmit".into()),
        }
    } else {
        unknown()
    }
}
fn released(kind: &Release) -> Outcome {
    Outcome {
        kind: match kind {
            Release::Confirmed => Kind::Confirmed,
            Release::NotSubmitted => Kind::NotSubmitted,
        },
        confirmed: matches!(kind, Release::Confirmed),
        reason: None,
    }
}

fn identity(intent: &Intent) -> Result<(String, String), AppError> {
    let mut targets: Vec<String> = intent
        .targets
        .iter()
        .map(|s| s.trim().to_lowercase())
        .collect();
    targets.sort();
    let invalid = intent.gid.trim().is_empty()
        || intent.selection_token.trim().is_empty()
        || core_store::looks_secret_like(&intent.gid)
        || core_store::looks_secret_like(&intent.selection_token)
        || targets
            .iter()
            .any(|s| s.is_empty() || core_store::looks_secret_like(s))
        || targets.windows(2).any(|pair| pair[0] == pair[1])
        || match intent.action {
            Action::Invite => targets.is_empty(),
            Action::Transfer => targets.len() != 1,
            Action::Finish => !targets.is_empty(),
        };
    if invalid {
        return Err(AppError::new(
            "im.invalid_peripheral_intent",
            "invalid peripheral intent (nothing submitted)",
        ));
    }
    // Uncertainty covers the whole room/action, not just one selected set:
    // Invite[A,B] may already have added A, so Invite[A] cannot be a new key.
    let barrier = serde_json::to_vec(&(&intent.gid, &intent.action)).map_err(|_| corrupt())?;
    // After a proven release, the same token with a different authorized
    // selection is a different intent; canonical equivalent targets replay.
    let intent_bytes =
        serde_json::to_vec(&(&intent.selection_token, targets)).map_err(|_| corrupt())?;
    Ok((hash(barrier), hash(intent_bytes)))
}
impl std::fmt::Debug for PeripheralJournal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PeripheralJournal").finish_non_exhaustive()
    }
}
impl PeripheralJournal {
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
            .map_err(|_| storage_error())?;
        FileExt::lock_exclusive(&file).map_err(|_| storage_error())?;
        Ok(WriterLock(file))
    }

    fn durability_barrier(&self, ns: &Namespace) -> Result<(), AppError> {
        let dir = self.store.namespace_dir(ns);
        File::open(dir.join("state.json"))
            .and_then(|f| f.sync_all())
            .map_err(|_| storage_error())?;
        for ancestor in dir.ancestors() {
            File::open(ancestor)
                .and_then(|f| f.sync_all())
                .map_err(|_| storage_error())?;
        }
        Ok(())
    }

    fn decode(value: &JsonValue, key: &str, intent: &Intent) -> Result<Record, AppError> {
        let row: Record = serde_json::from_str(&value.to_json()).map_err(|_| corrupt())?;
        if row.schema != 1
            || row.identity_sha256 != key
            || row.gid != intent.gid
            || row.action != intent.action
            || !is_hash(&row.identity_sha256)
            || !is_hash(&row.intent_sha256)
            || uuid::Uuid::parse_str(&row.attempt_id).is_err()
            || row.released.len() + row.blocked.len() > MAX_RELEASED_INTENTS
            || row.released.keys().any(|s| !is_hash(s))
            || row
                .blocked
                .keys()
                .any(|s| !is_hash(s) || row.released.contains_key(s))
            || row.blocked.contains_key(&row.intent_sha256)
            || ((row.phase == Phase::Released) != row.released.contains_key(&row.intent_sha256))
        {
            return Err(corrupt());
        }
        Ok(row)
    }

    fn value(row: &Record) -> Result<JsonValue, AppError> {
        JsonValue::parse(&serde_json::to_string(row).map_err(|_| corrupt())?).map_err(|_| corrupt())
    }

    fn reserve(&self, account: &AccountContext, intent: &Intent) -> Result<Reservation, AppError> {
        let (key, intent_hash) = identity(intent)?;
        let _writer = self.writer_lock()?;
        let ns = Namespace::from_context(account);
        let current = self.store.get(&ns, COLLECTION, &key)?;
        let mut history = BTreeMap::new();
        let mut blocked = BTreeMap::new();
        if let Some(value) = &current {
            let mut row = Self::decode(value, &key, intent)?;
            if self.durability_barrier(&ns).is_err() {
                return Ok(Reservation::Existing(unknown()));
            }
            if let Some(saved) = row.released.get(&intent_hash) {
                return Ok(Reservation::Existing(released(saved)));
            }
            if let Some(accepted) = row.blocked.get(&intent_hash) {
                return Ok(Reservation::Existing(pending(*accepted)));
            }
            if row.phase != Phase::Released {
                let accepted = row.phase == Phase::Accepted;
                if row.intent_sha256 != intent_hash {
                    if row.released.len() + row.blocked.len() >= MAX_RELEASED_INTENTS {
                        return Err(storage_error());
                    }
                    row.blocked.insert(intent_hash, accepted);
                    let mut tx = self.store.begin(&ns)?;
                    tx.expect_unchanged(COLLECTION, &key, current.clone());
                    tx.put(COLLECTION, &key, Self::value(&row)?);
                    self.store.commit(tx)?;
                    self.durability_barrier(&ns)?;
                }
                return Ok(Reservation::Existing(pending(accepted)));
            }
            blocked = row.blocked;
            history = row.released;
        }
        if history.len() + blocked.len() >= MAX_RELEASED_INTENTS {
            return Err(AppError::new(
                "im.peripheral_journal_full",
                "peripheral intent safety history is full; no write is permitted",
            ));
        }
        let attempt_id = uuid::Uuid::new_v4().to_string();
        let row = Record {
            schema: 1,
            identity_sha256: key.clone(),
            gid: intent.gid.clone(),
            action: intent.action.clone(),
            attempt_id: attempt_id.clone(),
            intent_sha256: intent_hash.clone(),
            creation_generation: account.session_generation,
            phase: Phase::WriteStarted,
            released: history,
            blocked,
        };
        let mut tx = self.store.begin(&ns)?;
        tx.expect_unchanged(COLLECTION, &key, current);
        tx.put(COLLECTION, &key, Self::value(&row)?);
        self.store.commit(tx)?;
        self.durability_barrier(&ns)?;
        Ok(Reservation::New(Ticket {
            key,
            intent_hash,
            attempt_id,
        }))
    }

    fn finish(
        &self,
        account: &AccountContext,
        intent: &Intent,
        ticket: &Ticket,
        observed: Outcome,
    ) -> Result<Outcome, AppError> {
        let _writer = self.writer_lock()?;
        let ns = Namespace::from_context(account);
        let current = self
            .store
            .get(&ns, COLLECTION, &ticket.key)?
            .ok_or_else(corrupt)?;
        let mut row = Self::decode(&current, &ticket.key, intent)?;
        if row.attempt_id != ticket.attempt_id
            || row.intent_sha256 != ticket.intent_hash
            || row.phase != Phase::WriteStarted
        {
            return Err(corrupt());
        }
        // No reason, response body, raw target, service key or selection token
        // is stored. Only a consistent explicit stage result can release.
        let observed = if observed.confirmed == (observed.kind == Kind::Confirmed) {
            observed
        } else {
            unknown()
        };
        row.phase = match observed.kind {
            Kind::Confirmed => {
                row.released
                    .insert(ticket.intent_hash.clone(), Release::Confirmed);
                Phase::Released
            }
            Kind::NotSubmitted => {
                row.released
                    .insert(ticket.intent_hash.clone(), Release::NotSubmitted);
                Phase::Released
            }
            Kind::Accepted => Phase::Accepted,
            Kind::Unknown => Phase::Unknown,
        };
        let mut tx = self.store.begin(&ns)?;
        tx.expect_unchanged(COLLECTION, &ticket.key, Some(current));
        tx.put(COLLECTION, &ticket.key, Self::value(&row)?);
        self.store.commit(tx)?;
        self.durability_barrier(&ns)?;
        Ok(observed)
    }
}

pub async fn dispatch_once<F, Fut>(
    journal: &Mutex<PeripheralJournal>,
    account: &AccountContext,
    intent: &Intent,
    dispatch: F,
) -> Result<Outcome, AppError>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<Outcome, AppError>>,
{
    let reservation = journal
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .reserve(account, intent)?;
    let ticket = match reservation {
        Reservation::Existing(saved) => return Ok(saved),
        Reservation::New(ticket) => ticket,
    };
    // The OS and Rust locks were released before awaiting the actual page RPC.
    // Even a pre-emit request exception is not trusted as not_submitted here.
    let observed = dispatch().await.unwrap_or_else(|_| unknown());
    Ok(journal
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .finish(account, intent, &ticket, observed)
        .unwrap_or_else(|_| unknown()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use contracts::{AccountId, Environment};
    use core_store::{Namespace, Store};
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("vbk-peripheral-test-{}", uuid::Uuid::new_v4())))
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
    fn intent(token: &str) -> Intent {
        Intent {
            gid: "900719925474099312345".into(),
            action: Action::Invite,
            targets: vec!["synthetic-target".into()],
            selection_token: token.into(),
        }
    }
    fn open(root: &TempDir) -> Mutex<PeripheralJournal> {
        Mutex::new(PeripheralJournal::open(root.0.clone()).unwrap())
    }
    fn outcome(kind: Kind) -> Outcome {
        Outcome {
            confirmed: kind == Kind::Confirmed,
            kind,
            reason: Some("synthetic private payload; Cookie: synthetic; signed URL".into()),
        }
    }
    fn run<T>(future: impl Future<Output = T>) -> T {
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
    fn unknown_and_accepted_survive_restart_new_rpc_token_and_generation_without_replay() {
        for kind in [Kind::Unknown, Kind::Accepted] {
            let root = TempDir::new();
            let first = open(&root);
            let calls = AtomicUsize::new(0);
            run(dispatch_once(
                &first,
                &account(1),
                &intent("first-token"),
                || async {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(outcome(kind.clone()))
                },
            ))
            .unwrap();
            drop(first);
            let reopened = open(&root);
            let result = run(dispatch_once(
                &reopened,
                &account(99),
                &intent("new-rpc-token"),
                || async {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(outcome(Kind::Confirmed))
                },
            ))
            .unwrap();
            assert!(result.kind == kind);
            assert!(!result.confirmed);
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            let disk = std::fs::read_to_string(
                reopened
                    .lock()
                    .unwrap()
                    .store
                    .namespace_dir(&Namespace::from_context(&account(1)))
                    .join("state.json"),
            )
            .unwrap();
            assert!(!disk.contains("synthetic private payload"));
            assert!(!disk.contains("Cookie:"));
            assert!(!disk.contains("first-token"));
            assert!(!disk.contains("synthetic-target"));
        }
    }

    #[test]
    fn write_started_is_durable_before_dispatch_and_crash_recovers_unknown() {
        let root = TempDir::new();
        let first = open(&root);
        let crashed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run(dispatch_once(
                &first,
                &account(1),
                &intent("crash-token"),
                || async {
                    let path = first
                        .lock()
                        .unwrap()
                        .store
                        .namespace_dir(&Namespace::from_context(&account(1)))
                        .join("state.json");
                    assert!(std::fs::read_to_string(path)
                        .unwrap()
                        .contains("write_started"));
                    panic!("synthetic crash after reservation");
                    #[allow(unreachable_code)]
                    Ok(outcome(Kind::Confirmed))
                },
            ))
        }));
        assert!(crashed.is_err());
        drop(first);
        let reopened = open(&root);
        let calls = AtomicUsize::new(0);
        let result = run(dispatch_once(
            &reopened,
            &account(2),
            &intent("after-crash"),
            || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(outcome(Kind::Confirmed))
            },
        ))
        .unwrap();
        assert!(result.kind == Kind::Unknown);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn two_real_file_store_instances_admit_one_dispatch_and_do_not_hold_lock_across_await() {
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
            let journal = Mutex::new(PeripheralJournal::open(first_root).unwrap());
            run(dispatch_once(
                &journal,
                &account(1),
                &intent("first"),
                || async {
                    first_calls.fetch_add(1, Ordering::SeqCst);
                    ready_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Ok(outcome(Kind::Unknown))
                },
            ))
        });
        ready_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        let (second_tx, second_rx) = mpsc::channel();
        let second = std::thread::spawn(move || {
            let journal = Mutex::new(PeripheralJournal::open(second_root).unwrap());
            let result = run(dispatch_once(
                &journal,
                &account(7),
                &intent("second"),
                || async {
                    second_calls.fetch_add(1, Ordering::SeqCst);
                    Ok(outcome(Kind::Unknown))
                },
            ));
            second_tx.send(result).unwrap();
        });
        let result = second_rx.recv_timeout(Duration::from_secs(3));
        release_tx.send(()).unwrap();
        first.join().unwrap().unwrap();
        second.join().unwrap();
        assert!(result.unwrap().unwrap().kind == Kind::Unknown);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn real_disk_failure_before_reservation_is_fail_closed() {
        let root = TempDir::new();
        let journal = open(&root);
        let calls = AtomicUsize::new(0);
        std::fs::write(root.0.join("env"), b"synthetic filesystem obstruction").unwrap();
        assert!(run(dispatch_once(
            &journal,
            &account(1),
            &intent("first"),
            || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(outcome(Kind::Confirmed))
            }
        ))
        .is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn completion_store_failure_returns_unknown_and_preserves_started_barrier() {
        let root = TempDir::new();
        let journal = open(&root);
        let calls = AtomicUsize::new(0);
        let result = run(dispatch_once(
            &journal,
            &account(1),
            &intent("first"),
            || async {
                calls.fetch_add(1, Ordering::SeqCst);
                journal
                    .lock()
                    .unwrap()
                    .store
                    .logout_lock(&Namespace::from_context(&account(1)))
                    .unwrap();
                Ok(outcome(Kind::Confirmed))
            },
        ))
        .unwrap();
        assert!(result.kind == Kind::Unknown);
        // A new token requires its own durable blocked-token tombstone. While
        // the namespace is still unwritable, fail closed without dispatch.
        assert!(run(dispatch_once(
            &journal,
            &account(2),
            &intent("while-locked"),
            || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(outcome(Kind::Confirmed))
            }
        ))
        .is_err());
        journal
            .lock()
            .unwrap()
            .store
            .unlock_after_reauth(&Namespace::from_context(&account(2)))
            .unwrap();
        let result = run(dispatch_once(
            &journal,
            &account(2),
            &intent("new-token"),
            || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(outcome(Kind::Confirmed))
            },
        ))
        .unwrap();
        assert!(result.kind == Kind::Unknown);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn confirmed_and_proven_not_submitted_release_only_new_explicit_intents_and_old_tokens_never_replay(
    ) {
        for kind in [Kind::Confirmed, Kind::NotSubmitted] {
            let root = TempDir::new();
            let first = open(&root);
            let calls = AtomicUsize::new(0);
            for token in ["a", "a", "b", "a", "b"] {
                let result = run(dispatch_once(
                    &first,
                    &account(1),
                    &intent(token),
                    || async {
                        calls.fetch_add(1, Ordering::SeqCst);
                        Ok(outcome(kind.clone()))
                    },
                ))
                .unwrap();
                assert!(result.kind == kind);
            }
            assert_eq!(calls.load(Ordering::SeqCst), 2);
            drop(first);
            let reopened = open(&root);
            run(dispatch_once(
                &reopened,
                &account(9),
                &intent("a"),
                || async {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(outcome(kind.clone()))
                },
            ))
            .unwrap();
            assert_eq!(calls.load(Ordering::SeqCst), 2);
            run(dispatch_once(
                &reopened,
                &account(9),
                &intent("c"),
                || async {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(outcome(kind.clone()))
                },
            ))
            .unwrap();
            assert_eq!(calls.load(Ordering::SeqCst), 3);
        }
    }

    #[test]
    fn exceptions_and_inconsistent_not_submitted_never_release_the_barrier() {
        for malformed in [false, true] {
            let root = TempDir::new();
            let journal = open(&root);
            let calls = AtomicUsize::new(0);
            let result = run(dispatch_once(
                &journal,
                &account(1),
                &intent("first"),
                || async {
                    calls.fetch_add(1, Ordering::SeqCst);
                    if malformed {
                        Ok(Outcome {
                            kind: Kind::NotSubmitted,
                            confirmed: true,
                            reason: None,
                        })
                    } else {
                        Err(AppError::new("adapter.failed", "synthetic exception"))
                    }
                },
            ))
            .unwrap();
            assert!(result.kind == Kind::Unknown);
            let result = run(dispatch_once(
                &journal,
                &account(2),
                &intent("second"),
                || async {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(outcome(Kind::Confirmed))
                },
            ))
            .unwrap();
            assert!(result.kind == Kind::Unknown);
            assert_eq!(calls.load(Ordering::SeqCst), 1);
        }
    }

    #[test]
    fn stable_key_normalizes_targets_and_isolates_namespace_room_and_action() {
        let root = TempDir::new();
        let journal = open(&root);
        let calls = AtomicUsize::new(0);
        let mut first = intent("a");
        first.targets = vec!["B".into(), "a".into()];
        run(dispatch_once(&journal, &account(1), &first, || async {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(outcome(Kind::Unknown))
        }))
        .unwrap();
        let mut same = intent("b");
        same.targets = vec![" A ".into(), "b".into()];
        run(dispatch_once(&journal, &account(9), &same, || async {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(outcome(Kind::Unknown))
        }))
        .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        for context in [
            AccountContext::new(AccountId::new("other"), Environment::named("test"), 1),
            AccountContext::new(
                AccountId::new("synthetic-account"),
                Environment::named("other"),
                1,
            ),
        ] {
            run(dispatch_once(&journal, &context, &same, || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(outcome(Kind::Unknown))
            }))
            .unwrap();
        }
        same.gid = "different-room".into();
        run(dispatch_once(&journal, &account(1), &same, || async {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(outcome(Kind::Unknown))
        }))
        .unwrap();
        same.action = Action::Transfer;
        same.targets = vec!["a".into()];
        run(dispatch_once(&journal, &account(1), &same, || async {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(outcome(Kind::Unknown))
        }))
        .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 5);
    }

    #[test]
    fn corrupt_persistent_state_never_resets_into_a_new_write() {
        let root = TempDir::new();
        let journal = open(&root);
        let calls = AtomicUsize::new(0);
        run(dispatch_once(
            &journal,
            &account(1),
            &intent("a"),
            || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(outcome(Kind::Unknown))
            },
        ))
        .unwrap();
        let path = journal
            .lock()
            .unwrap()
            .store
            .namespace_dir(&Namespace::from_context(&account(1)))
            .join("state.json");
        std::fs::write(path, b"{synthetic partial document").unwrap();
        for _ in 0..2 {
            assert!(run(dispatch_once(
                &journal,
                &account(1),
                &intent("b"),
                || async {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(outcome(Kind::Confirmed))
                }
            ))
            .is_err());
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_concurrent_token_blocked_as_unknown_never_becomes_a_new_intent_after_first_confirmation() {
        let root = TempDir::new();
        let first = open(&root);
        let second = open(&root);
        let calls = AtomicUsize::new(0);
        run(dispatch_once(
            &first,
            &account(1),
            &intent("first"),
            || async {
                calls.fetch_add(1, Ordering::SeqCst);
                let blocked = run(dispatch_once(
                    &second,
                    &account(1),
                    &intent("blocked-before-confirmation"),
                    || async {
                        calls.fetch_add(1, Ordering::SeqCst);
                        Ok(outcome(Kind::Confirmed))
                    },
                ))
                .unwrap();
                assert!(blocked.kind == Kind::Unknown);
                Ok(outcome(Kind::Confirmed))
            },
        ))
        .unwrap();
        drop(first);
        drop(second);
        let reopened = open(&root);
        let replay = run(dispatch_once(
            &reopened,
            &account(9),
            &intent("blocked-before-confirmation"),
            || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(outcome(Kind::Confirmed))
            },
        ))
        .unwrap();
        assert!(replay.kind == Kind::Unknown);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        run(dispatch_once(
            &reopened,
            &account(9),
            &intent("fresh-after-confirmation"),
            || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(outcome(Kind::Confirmed))
            },
        ))
        .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn uncertain_invite_blocks_subsets_overlaps_and_disjoint_retargets_after_reopen() {
        for kind in [Kind::Unknown, Kind::Accepted] {
            let root = TempDir::new();
            let first = open(&root);
            let calls = AtomicUsize::new(0);
            let mut initial = intent("initial-token");
            initial.targets = vec!["A".into(), "B".into()];
            run(dispatch_once(&first, &account(1), &initial, || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(outcome(kind.clone()))
            }))
            .unwrap();
            drop(first);
            let reopened = open(&root);
            for (index, targets) in [vec!["A"], vec!["A", "C"], vec!["C"]]
                .into_iter()
                .enumerate()
            {
                let mut next = intent(&format!("fresh-rpc-token-{index}"));
                next.targets = targets.into_iter().map(str::to_string).collect();
                let result = run(dispatch_once(&reopened, &account(9), &next, || async {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(outcome(Kind::Confirmed))
                }))
                .unwrap();
                assert!(
                    result.kind == kind,
                    "changed invite targets cannot clear an uncertain room/action barrier"
                );
                assert_eq!(calls.load(Ordering::SeqCst), 1);
            }
        }
    }

    #[test]
    fn uncertain_transfer_cannot_be_bypassed_by_selecting_another_target() {
        for kind in [Kind::Unknown, Kind::Accepted] {
            let root = TempDir::new();
            let first = open(&root);
            let calls = AtomicUsize::new(0);
            let mut initial = intent("initial-token");
            initial.action = Action::Transfer;
            initial.targets = vec!["A".into()];
            run(dispatch_once(&first, &account(1), &initial, || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(outcome(kind.clone()))
            }))
            .unwrap();
            drop(first);
            let reopened = open(&root);
            let mut next = intent("new-rpc-token");
            next.action = Action::Transfer;
            next.targets = vec!["B".into()];
            let result = run(dispatch_once(&reopened, &account(9), &next, || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(outcome(Kind::Confirmed))
            }))
            .unwrap();
            assert!(result.kind == kind);
            assert_eq!(calls.load(Ordering::SeqCst), 1);
        }
    }

    #[test]
    fn released_intent_hash_includes_canonical_targets_as_well_as_selection_token() {
        for kind in [Kind::Confirmed, Kind::NotSubmitted] {
            let root = TempDir::new();
            let journal = open(&root);
            let calls = AtomicUsize::new(0);
            for targets in [
                vec![" B ", "A"],
                vec!["a", "b"],
                vec!["A", "C"],
                vec!["b", "a"],
            ] {
                let mut next = intent("same-authorized-selection-token");
                next.targets = targets.into_iter().map(str::to_string).collect();
                let result = run(dispatch_once(&journal, &account(1), &next, || async {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(outcome(kind.clone()))
                }))
                .unwrap();
                assert!(result.kind == kind);
            }
            assert_eq!(calls.load(Ordering::SeqCst), 2, "same payload replays; changed selected targets form a distinct intent only after release");
        }
    }
}

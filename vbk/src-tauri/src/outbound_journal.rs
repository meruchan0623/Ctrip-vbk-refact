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
use core_im::retention::{prune_keys, RetentionEntry, RetentionPolicy};
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
    UploadStarted,
    Uploaded,
    WriteStarted,
    Unknown,
    Completed,
}

#[derive(Clone, Serialize, Deserialize)]
struct Attempt {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    media_kind: Option<String>,
    #[serde(default)]
    send_started: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    message_sha256: Option<String>,
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
    retention: RetentionPolicy,
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
/// The record was committed but the durability barrier after it failed. This
/// is its own code (media attachment contract v1): not `im.journal_io` (nothing
/// written) and not an `unknown` send. No further step is admitted by the call
/// that saw it; the committed row stays and later calls replay it.
fn barrier_failed() -> AppError {
    AppError::new(
        core_im::media_contract::codes::IM_JOURNAL_BARRIER_FAILED,
        "outbound record was committed but its durability barrier failed; nothing further is dispatched",
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

/// A confirmation without a server id or a rejection without a code is not
/// evidence of either: it is `Unknown`.
pub(crate) fn normalize(disposition: SendDispositionDto) -> SendDispositionDto {
    match disposition {
        SendDispositionDto::Confirmed {
            ref server_message_id,
            ..
        } if server_message_id.trim().is_empty() => SendDispositionDto::Unknown,
        SendDispositionDto::Rejected { ref code, .. } if code.is_empty() => {
            SendDispositionDto::Unknown
        }
        valid => valid,
    }
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
            retention: RetentionPolicy::default(),
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

    /// FileStore durably creates each missing ancestor before the next child.
    /// Recheck its strict file/directory barrier; unsupported sync fails closed.
    fn durability_barrier(&self, ns: &Namespace) -> Result<(), AppError> {
        self.store.sync_namespace(ns).map_err(|_| io_error())
    }

    /// Barrier for a row that is already committed (or already on disk): a
    /// failure is `im.journal_barrier_failed`, never a fabricated `Unknown`.
    fn committed_barrier(&self, ns: &Namespace) -> Result<(), AppError> {
        self.store.sync_namespace(ns).map_err(|_| barrier_failed())
    }

    /// Drop old completed rows (best effort, after a completed row is durable).
    /// `unknown`, in-flight and upload-stage rows are never selected, and a
    /// failure here can never change the disposition the caller already holds.
    fn prune_completed(&self, ns: &Namespace) {
        let Ok(rows) = self.store.list(ns, COLLECTION) else {
            return;
        };
        let entries: Vec<RetentionEntry> = rows
            .iter()
            .map(|(key, value)| RetentionEntry {
                key: key.clone(),
                completed_at_ms: serde_json::from_str::<Attempt>(&value.to_json())
                    .ok()
                    .filter(|row| row.phase == Phase::Completed)
                    .and_then(|row| row.completed_at_ms),
            })
            .collect();
        let doomed = prune_keys(&entries, now_ms(), self.retention);
        if doomed.is_empty() {
            return;
        }
        let Ok(mut tx) = self.store.begin(ns) else {
            return;
        };
        for key in &doomed {
            if let Some((_, value)) = rows.iter().find(|(k, _)| k == key) {
                tx.expect_unchanged(COLLECTION, key, Some(value.clone()));
                tx.delete(COLLECTION, key);
            }
        }
        if self.store.commit(tx).is_ok() {
            let _ = self.durability_barrier(ns);
        }
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
        if let Some(kind) = &row.media_kind {
            if !matches!(kind.as_str(), "image" | "file" | "video")
                || row.message_sha256.as_ref().map_or(false, |hash| {
                    hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit())
                })
                || (row.send_started && row.message_sha256.is_none())
                || (row.phase == Phase::UploadStarted
                    && (row.send_started || row.message_sha256.is_some()))
                || (row.phase == Phase::Uploaded
                    && (row.send_started || row.message_sha256.is_none()))
                || (matches!(row.phase, Phase::WriteStarted | Phase::Unknown) && !row.send_started)
                || (matches!(row.disposition, SendDispositionDto::Confirmed { .. })
                    && !row.send_started)
            {
                return Err(corrupt());
            }
        } else if row.message_sha256.is_some()
            || matches!(row.phase, Phase::UploadStarted | Phase::Uploaded)
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
            (Phase::UploadStarted | Phase::Uploaded, SendDispositionDto::Unknown)
                if row.media_kind.is_some() && !row.send_started => {}
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
        self.reserve_at(account, local_id, payload, None)
    }

    fn reserve_at(
        &self,
        account: &AccountContext,
        local_id: &str,
        payload: &SendPayload,
        media_kind: Option<String>,
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
            if existing.payload_sha256 != digest || existing.media_kind != media_kind {
                return Err(AppError::new(
                    "im.intent_conflict",
                    "local_id already belongs to a different outbound payload (nothing sent)",
                ));
            }
            // No record, including write_started left by a crash, authorizes a
            // second dispatch. A terminal read is durable before it is exposed.
            self.committed_barrier(&ns)?;
            return Ok(Reservation::Existing(existing.disposition));
        }
        let row = Attempt {
            phase: if media_kind.is_some() {
                Phase::UploadStarted
            } else {
                Phase::WriteStarted
            },
            send_started: media_kind.is_none(),
            media_kind,
            message_sha256: None,
            schema: 1,
            environment: account.environment.as_str().into(),
            account_id: account.account_id.as_str().into(),
            local_id: local_id.into(),
            gid: payload.gid.clone(),
            creation_generation: account.session_generation,
            payload_sha256: digest,
            created_at_ms: now_ms(),
            completed_at_ms: None,
            disposition: SendDispositionDto::Unknown,
        };
        let mut tx = self.store.begin(&ns)?;
        tx.expect_unchanged(COLLECTION, local_id, None);
        tx.put(COLLECTION, local_id, Self::value(&row)?);
        self.store.commit(tx)?;
        // The row is committed here. A barrier failure must not be reported as
        // a plain I/O failure (it would read as "nothing written") nor as an
        // unknown send; it gets its own code and admits no dispatch.
        self.committed_barrier(&ns)?;
        Ok(Reservation::New)
    }

    /// Shares the exact text local_id/CAS/OS-lock namespace. Payload is a
    /// canonical body-free manifest; it is hashed and never written verbatim.
    pub fn reserve_media(
        &self,
        account: &AccountContext,
        local_id: &str,
        payload: &SendPayload,
        kind: &str,
    ) -> Result<bool, AppError> {
        if !matches!(kind, "image" | "file" | "video") {
            return Err(corrupt());
        }
        Ok(matches!(
            self.reserve_at(account, local_id, payload, Some(kind.into()))?,
            Reservation::New
        ))
    }

    pub fn media_status(
        &self,
        account: &AccountContext,
        local_id: &str,
    ) -> Result<(String, bool, SendDispositionDto), AppError> {
        let _writer = self.writer_lock()?;
        let ns = Namespace::from_context(account);
        let value = self
            .store
            .get(&ns, COLLECTION, local_id)?
            .ok_or_else(corrupt)?;
        let row = Self::decode(&value, account, local_id)?;
        self.durability_barrier(&ns)?;
        let started = row.media_kind.is_none() || row.send_started;
        Ok((
            if started { "send" } else { "upload" }.into(),
            started,
            row.disposition,
        ))
    }

    /// Read-only replay precedes local byte staging/expiry checks. A duplicate
    /// intent cannot become a fresh "not submitted" result merely because its
    /// original attachment or page capability has since expired.
    pub fn replay_media(
        &self,
        account: &AccountContext,
        local_id: &str,
        gid: &str,
        payload: Option<&SendPayload>,
    ) -> Result<Option<(String, bool, SendDispositionDto, bool)>, AppError> {
        let _writer = self.writer_lock()?;
        let ns = Namespace::from_context(account);
        let Some(value) = self.store.get(&ns, COLLECTION, local_id)? else {
            return Ok(None);
        };
        let row = Self::decode(&value, account, local_id)?;
        if row.gid != gid
            || row.media_kind.is_none()
            || payload
                .map(payload_hash)
                .transpose()?
                .map_or(false, |hash| row.payload_sha256 != hash)
        {
            return Err(AppError::new(
                "im.intent_conflict",
                "local_id belongs to a different intent (nothing new submitted)",
            ));
        }
        self.durability_barrier(&ns)?;
        Ok(Some((
            if row.send_started { "send" } else { "upload" }.into(),
            row.send_started,
            row.disposition,
            payload.is_some(),
        )))
    }

    pub fn advance_media(
        &self,
        account: &AccountContext,
        local_id: &str,
        payload: &SendPayload,
        body: &str,
        start_send: bool,
    ) -> Result<(), AppError> {
        let _writer = self.writer_lock()?;
        let ns = Namespace::from_context(account);
        let value = self
            .store
            .get(&ns, COLLECTION, local_id)?
            .ok_or_else(corrupt)?;
        let mut row = Self::decode(&value, account, local_id)?;
        if row.media_kind.is_none()
            || row.payload_sha256 != payload_hash(payload)?
            || body.is_empty()
        {
            return Err(corrupt());
        }
        let digest = format!("{:x}", Sha256::digest(body.as_bytes()));
        if start_send {
            if row.phase != Phase::Uploaded || row.message_sha256.as_ref() != Some(&digest) {
                return Err(corrupt());
            }
            row.phase = Phase::WriteStarted;
            row.send_started = true;
        } else {
            if row.phase != Phase::UploadStarted {
                return Err(corrupt());
            }
            row.phase = Phase::Uploaded;
            row.message_sha256 = Some(digest);
        }
        let mut tx = self.store.begin(&ns)?;
        tx.expect_unchanged(COLLECTION, local_id, Some(value));
        tx.put(COLLECTION, local_id, Self::value(&row)?);
        self.store.commit(tx)?;
        self.committed_barrier(&ns)
    }

    pub fn finish_media(
        &self,
        account: &AccountContext,
        local_id: &str,
        payload: &SendPayload,
        disposition: SendDispositionDto,
    ) -> Result<SendDispositionDto, AppError> {
        self.finish(account, local_id, payload, disposition)
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
        if row.media_kind.is_some()
            && !row.send_started
            && !matches!(disposition, SendDispositionDto::Rejected { .. })
        {
            return Err(corrupt());
        }
        let observed = normalize(disposition);
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
        self.committed_barrier(&ns)?;
        if row.phase == Phase::Completed {
            self.prune_completed(&ns);
        }
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
                    write_started: row.media_kind.is_none() || row.send_started,
                    phase: match row.phase {
                        Phase::UploadStarted => "upload_started",
                        Phase::Uploaded => "uploaded",
                        Phase::WriteStarted => "write_started",
                        _ => "unknown",
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
    let held = normalize(observed.clone());
    let finished = journal
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .finish(account, local_id, payload, observed);
    Ok(match finished {
        Ok(saved) => saved,
        // The outcome row was committed; only the follow-up sync failed. The
        // caller holds the real outcome, so report it instead of degrading it
        // to Unknown. Any other failure (nothing committed) stays Unknown.
        Err(error) if error.code == core_im::media_contract::codes::IM_JOURNAL_BARRIER_FAILED => {
            held
        }
        Err(_) => SendDispositionDto::Unknown,
    })
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

    fn media_payload() -> SendPayload {
        SendPayload { gid: "synthetic-media-room".into(), text: r#"{"kind":"file","name":"PRIVATE_SYNTHETIC_NAME.pdf","size":22,"content_sha256":"synthetic-digest","target_sha256":"synthetic-target"}"#.into(), original: None, quote_id: None }
    }
    const MEDIA_BODY: &str = r#"{"btype":5,"file":{"filename":"PRIVATE_SYNTHETIC_NAME.pdf","url":"https://static.tripcdn.com/PRIVATE_SYNTHETIC_URL.pdf","size":22}}"#;

    #[test]
    fn media_upload_and_send_have_separate_durable_recovery_barriers_in_the_same_local_id_namespace(
    ) {
        let root = TempDir::new();
        let first = OutboundJournal::open(root.0.clone()).unwrap();
        assert!(first
            .reserve_media(&account(1), "media-local", &media_payload(), "file")
            .unwrap());
        let rows = first.unknown_metadata(&account(2)).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].phase, "upload_started");
        assert!(!rows[0].write_started);
        drop(first);
        let reopened = OutboundJournal::open(root.0.clone()).unwrap();
        assert!(
            !reopened
                .reserve_media(&account(2), "media-local", &media_payload(), "file")
                .unwrap(),
            "upload_started after a real FileStore reopen cannot admit another upload"
        );
        assert!(
            reopened
                .reserve(&account(2), "media-local", &payload())
                .is_err(),
            "text cannot bypass the media local_id reservation"
        );
        reopened
            .advance_media(
                &account(2),
                "media-local",
                &media_payload(),
                MEDIA_BODY,
                false,
            )
            .unwrap();
        assert_eq!(
            reopened.unknown_metadata(&account(3)).unwrap()[0].phase,
            "uploaded"
        );
        assert!(!reopened.unknown_metadata(&account(3)).unwrap()[0].write_started);
        assert!(reopened
            .advance_media(
                &account(3),
                "media-local",
                &media_payload(),
                "different payload",
                true
            )
            .is_err());
        reopened
            .advance_media(
                &account(3),
                "media-local",
                &media_payload(),
                MEDIA_BODY,
                true,
            )
            .unwrap();
        assert!(
            reopened
                .advance_media(
                    &account(3),
                    "media-local",
                    &media_payload(),
                    MEDIA_BODY,
                    true
                )
                .is_err(),
            "a persisted write_started can never admit another SDK dispatch"
        );
        drop(reopened);
        let restarted = OutboundJournal::open(root.0.clone()).unwrap();
        assert!(!restarted
            .reserve_media(&account(99), "media-local", &media_payload(), "file")
            .unwrap());
        let rows = restarted.unknown_metadata(&account(99)).unwrap();
        assert_eq!(rows[0].phase, "write_started");
        assert!(rows[0].write_started);
        let disk = std::fs::read_to_string(
            restarted
                .store
                .namespace_dir(&Namespace::from_context(&account(99)))
                .join("state.json"),
        )
        .unwrap();
        assert!(!disk.contains("PRIVATE_SYNTHETIC"));
        assert!(!disk.contains("static.tripcdn.com"));
    }

    #[test]
    fn media_all_manifest_fields_conflict_and_text_reservation_cannot_be_retyped_as_media() {
        let root = TempDir::new();
        let journal = OutboundJournal::open(root.0.clone()).unwrap();
        assert!(journal
            .reserve_media(&account(1), "media-local", &media_payload(), "file")
            .unwrap());
        for field in ["kind", "name", "size", "content_sha256", "target_sha256"] {
            let mut changed = media_payload();
            let mut value: serde_json::Value = serde_json::from_str(&changed.text).unwrap();
            value[field] = "changed".into();
            changed.text = value.to_string();
            assert!(
                journal
                    .reserve_media(&account(2), "media-local", &changed, "file")
                    .is_err(),
                "{field} must belong to the original intent"
            );
        }
        journal
            .reserve(&account(1), "text-local", &payload())
            .unwrap();
        assert!(journal
            .reserve_media(&account(1), "text-local", &media_payload(), "file")
            .is_err());
        journal
            .reserve(&account(1), "same-hash-text", &media_payload())
            .unwrap();
        assert!(journal
            .reserve_media(&account(1), "same-hash-text", &media_payload(), "file")
            .is_err());
        assert!(journal
            .reserve(&account(1), "media-local", &media_payload())
            .is_err());
    }

    #[test]
    fn media_replay_requires_original_manifest_or_explicit_metadata_only_and_preserves_prior_stage()
    {
        let root = TempDir::new();
        let journal = OutboundJournal::open(root.0.clone()).unwrap();
        journal
            .reserve_media(&account(1), "old-local", &media_payload(), "file")
            .unwrap();
        let (stage, started, d, verified) = journal
            .replay_media(&account(2), "old-local", &media_payload().gid, None)
            .unwrap()
            .unwrap();
        assert_eq!(stage, "upload");
        assert!(!started);
        assert!(!verified);
        assert_eq!(d, SendDispositionDto::Unknown);
        let mut current = media_payload();
        current.text.push_str(" different snapshot");
        assert!(journal
            .replay_media(&account(2), "old-local", &current.gid, Some(&current))
            .is_err());
        journal
            .advance_media(
                &account(1),
                "old-local",
                &media_payload(),
                MEDIA_BODY,
                false,
            )
            .unwrap();
        journal
            .advance_media(&account(1), "old-local", &media_payload(), MEDIA_BODY, true)
            .unwrap();
        journal
            .finish_media(
                &account(1),
                "old-local",
                &media_payload(),
                SendDispositionDto::Confirmed {
                    server_message_id: "old-server".into(),
                    server_time_ms: 1700000000999,
                },
            )
            .unwrap();
        let (_, started, d, verified) = journal
            .replay_media(&account(2), "old-local", &media_payload().gid, None)
            .unwrap()
            .unwrap();
        assert!(started);
        assert!(!verified);
        assert!(matches!(d, SendDispositionDto::Confirmed { .. }));
        assert!(
            journal
                .replay_media(
                    &account(2),
                    "old-local",
                    &media_payload().gid,
                    Some(&media_payload())
                )
                .unwrap()
                .unwrap()
                .3
        );
    }

    #[test]
    fn legacy_text_without_new_send_started_field_remains_a_started_unknown_not_a_media_upload() {
        let root = TempDir::new();
        let journal = OutboundJournal::open(root.0.clone()).unwrap();
        journal
            .reserve(&account(1), "legacy-local", &payload())
            .unwrap();
        let ns = Namespace::from_context(&account(1));
        let value = journal
            .store
            .get(&ns, COLLECTION, "legacy-local")
            .unwrap()
            .unwrap();
        let mut old: serde_json::Value = serde_json::from_str(&value.to_json()).unwrap();
        old.as_object_mut().unwrap().remove("send_started");
        let mut tx = journal.store.begin(&ns).unwrap();
        tx.put(
            COLLECTION,
            "legacy-local",
            JsonValue::parse(&old.to_string()).unwrap(),
        );
        journal.store.commit(tx).unwrap();
        drop(journal);
        let reopened = Mutex::new(OutboundJournal::open(root.0.clone()).unwrap());
        let calls = AtomicUsize::new(0);
        assert_eq!(
            run(send_once(
                &reopened,
                &account(99),
                "legacy-local",
                &payload(),
                || async {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(SendDispositionDto::Unknown)
                }
            ))
            .unwrap(),
            SendDispositionDto::Unknown
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let rows = reopened
            .lock()
            .unwrap()
            .unknown_metadata(&account(99))
            .unwrap();
        assert_eq!(rows[0].phase, "write_started");
        assert!(rows[0].write_started);
    }

    #[test]
    fn media_disk_failure_before_send_transition_preserves_uploaded_without_admitting_a_write() {
        let root = TempDir::new();
        let journal = OutboundJournal::open(root.0.clone()).unwrap();
        let ns = Namespace::from_context(&account(1));
        journal
            .reserve_media(&account(1), "media-local", &media_payload(), "file")
            .unwrap();
        journal
            .advance_media(
                &account(1),
                "media-local",
                &media_payload(),
                MEDIA_BODY,
                false,
            )
            .unwrap();
        journal.store.logout_lock(&ns).unwrap();
        assert!(journal
            .advance_media(
                &account(1),
                "media-local",
                &media_payload(),
                MEDIA_BODY,
                true
            )
            .is_err());
        let rows = journal.unknown_metadata(&account(2)).unwrap();
        assert_eq!(rows[0].phase, "uploaded");
        assert!(!rows[0].write_started);
        journal.store.unlock_after_reauth(&ns).unwrap();
        assert!(!journal
            .reserve_media(&account(3), "media-local", &media_payload(), "file")
            .unwrap());
    }

    #[test]
    fn media_confirmation_is_durable_and_terminal_replay_contains_no_resource_or_body() {
        let root = TempDir::new();
        let journal = OutboundJournal::open(root.0.clone()).unwrap();
        journal
            .reserve_media(&account(1), "media-local", &media_payload(), "file")
            .unwrap();
        journal
            .advance_media(
                &account(1),
                "media-local",
                &media_payload(),
                MEDIA_BODY,
                false,
            )
            .unwrap();
        journal
            .advance_media(
                &account(1),
                "media-local",
                &media_payload(),
                MEDIA_BODY,
                true,
            )
            .unwrap();
        let expected = SendDispositionDto::Confirmed {
            server_message_id: "900719925474099312345".into(),
            server_time_ms: 1700000000999,
        };
        assert_eq!(
            journal
                .finish_media(
                    &account(1),
                    "media-local",
                    &media_payload(),
                    expected.clone()
                )
                .unwrap(),
            expected
        );
        drop(journal);
        let reopened = OutboundJournal::open(root.0.clone()).unwrap();
        let (stage, started, result) = reopened.media_status(&account(2), "media-local").unwrap();
        assert_eq!(stage, "send");
        assert!(started);
        assert_eq!(result, expected);
        assert!(reopened.unknown_metadata(&account(2)).unwrap().is_empty());
    }

    #[test]
    fn media_upload_uploaded_and_sdk_barriers_survive_real_process_restarts_without_replay() {
        const ROOT: &str = "VBK_SYNTHETIC_MEDIA_RESTART_ROOT";
        const PHASE: &str = "VBK_SYNTHETIC_MEDIA_RESTART_PHASE";
        const MODE: &str = "VBK_SYNTHETIC_MEDIA_RESTART_MODE";
        if let Some(root) = std::env::var_os(ROOT) {
            use std::io::Write;
            let root = PathBuf::from(root);
            let phase = std::env::var(PHASE).unwrap();
            let seed = std::env::var(MODE).unwrap() == "seed";
            let journal = OutboundJournal::open(root.join("store")).unwrap();
            let is_new = journal
                .reserve_media(
                    &account(if seed { 1 } else { 99 }),
                    "media-local",
                    &media_payload(),
                    "file",
                )
                .unwrap();
            if is_new {
                let mut marker = OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(root.join("uploads"))
                    .unwrap();
                marker.write_all(b"one upload\n").unwrap();
                marker.sync_all().unwrap();
                if phase != "upload_started" {
                    journal
                        .advance_media(
                            &account(1),
                            "media-local",
                            &media_payload(),
                            MEDIA_BODY,
                            false,
                        )
                        .unwrap();
                }
                if phase == "write_started" {
                    journal
                        .advance_media(
                            &account(1),
                            "media-local",
                            &media_payload(),
                            MEDIA_BODY,
                            true,
                        )
                        .unwrap();
                }
            }
            assert_eq!(
                is_new, seed,
                "the restarted OS process cannot admit another upload or SDK call"
            );
            assert_eq!(
                std::fs::read_to_string(root.join("uploads")).unwrap(),
                "one upload\n"
            );
            let rows = journal.unknown_metadata(&account(99)).unwrap();
            assert_eq!(rows[0].phase, phase);
            assert_eq!(rows[0].write_started, phase == "write_started");
            return;
        }
        for phase in ["upload_started", "uploaded", "write_started"] {
            let root = TempDir::new();
            std::fs::create_dir_all(&root.0).unwrap();
            for mode in ["seed", "recover"] {
                let status = std::process::Command::new(std::env::current_exe().unwrap()).args(["--exact", "adapter::outbound_journal::tests::media_upload_uploaded_and_sdk_barriers_survive_real_process_restarts_without_replay", "--nocapture"]).env(ROOT, &root.0).env(PHASE, phase).env(MODE, mode).status().unwrap();
                assert!(status.success(), "media {phase}/{mode}: {status}");
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
    fn unknown_is_not_redispatched_after_a_real_process_restart() {
        const CHILD_ROOT: &str = "VBK_SYNTHETIC_JOURNAL_RESTART_ROOT";
        const CHILD_PHASE: &str = "VBK_SYNTHETIC_JOURNAL_RESTART_PHASE";
        if let Some(root) = std::env::var_os(CHILD_ROOT) {
            use std::io::Write;
            let root = PathBuf::from(root);
            let phase = std::env::var(CHILD_PHASE).unwrap();
            let journal = Mutex::new(OutboundJournal::open(root.join("store")).unwrap());
            let disposition = run(send_once(
                &journal,
                &account(if phase == "first" { 1 } else { 99 }),
                "synthetic-restart-local",
                &payload(),
                || async {
                    let mut marker = OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(root.join("dispatch-count"))
                        .unwrap();
                    marker.write_all(b"one dispatch\n").unwrap();
                    marker.sync_all().unwrap();
                    Ok(SendDispositionDto::Unknown)
                },
            ))
            .unwrap();
            assert_eq!(disposition, SendDispositionDto::Unknown);
            assert_eq!(
                std::fs::read_to_string(root.join("dispatch-count")).unwrap(),
                "one dispatch\n",
                "the second OS process must recover unknown without dispatch"
            );
            return;
        }

        let root = TempDir::new();
        std::fs::create_dir_all(&root.0).unwrap();
        for phase in ["first", "restarted"] {
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "adapter::outbound_journal::tests::unknown_is_not_redispatched_after_a_real_process_restart",
                    "--nocapture",
                ])
                .env(CHILD_ROOT, &root.0)
                .env(CHILD_PHASE, phase)
                .status()
                .unwrap();
            assert!(
                status.success(),
                "synthetic journal child {phase}: {status}"
            );
        }
        assert_eq!(
            std::fs::read_to_string(root.0.join("dispatch-count")).unwrap(),
            "one dispatch\n"
        );
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

    #[test]
    fn completed_rows_are_capped_but_unknown_rows_are_never_pruned() {
        use core_store::{Namespace, Store};
        let root = TempDir::new();
        let mut inner = OutboundJournal::open(root.0.clone()).unwrap();
        inner.retention = RetentionPolicy {
            window_ms: i64::MAX / 2,
            max_completed: 2,
        };
        let journal = Mutex::new(inner);
        let text = |n: usize| SendPayload {
            gid: "synthetic-room".into(),
            text: format!("synthetic text {n}"),
            original: None,
            quote_id: None,
        };
        let unknown = run(send_once(
            &journal,
            &account(1),
            "unknown-1",
            &text(0),
            || async { Ok(SendDispositionDto::Unknown) },
        ))
        .unwrap();
        assert_eq!(unknown, SendDispositionDto::Unknown);
        for n in 1..=4usize {
            let id = format!("done-{n}");
            run(send_once(&journal, &account(1), &id, &text(n), || async {
                Ok(SendDispositionDto::Confirmed {
                    server_message_id: format!("{n}"),
                    server_time_ms: 1,
                })
            }))
            .unwrap();
        }
        let guard = journal.lock().unwrap();
        let mut keys: Vec<String> = guard
            .store
            .list(&Namespace::from_context(&account(1)), COLLECTION)
            .unwrap()
            .into_iter()
            .map(|(key, _)| key)
            .collect();
        keys.sort();
        assert_eq!(keys, ["done-3", "done-4", "unknown-1"]);
        // The surviving unknown still blocks a replay.
        drop(guard);
        let calls = AtomicUsize::new(0);
        let again = run(send_once(
            &journal,
            &account(1),
            "unknown-1",
            &text(0),
            || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(SendDispositionDto::Unknown)
            },
        ))
        .unwrap();
        assert_eq!(again, SendDispositionDto::Unknown);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn barrier_failure_after_commit_has_its_own_code() {
        let error = barrier_failed();
        assert_eq!(error.code, "im.journal_barrier_failed");
        assert_ne!(error.code, io_error().code);
    }

    #[test]
    fn disposition_without_evidence_normalizes_to_unknown() {
        assert_eq!(
            normalize(SendDispositionDto::Confirmed {
                server_message_id: "  ".into(),
                server_time_ms: 1
            }),
            SendDispositionDto::Unknown
        );
        assert_eq!(
            normalize(SendDispositionDto::Rejected {
                code: String::new(),
                reason: "x".into()
            }),
            SendDispositionDto::Unknown
        );
    }
}

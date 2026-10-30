//! Quick-login credential commit protocol (plan §7, ACC-03, review F03).
//!
//! ```text
//!   prepare()      stage()           commit()
//! ──────────▶ Prepared ──▶ SecretStaged ──▶ IndexCommitted ──▶ (entry removed)
//!   journal      journal +            index switch (atomic) +
//!   written      secret in store      journal, THEN old revision deleted
//! ```
//!
//! * The **journal is non-secret** and is written before any secret.
//! * The secret lives only in an abstract [`SecretStore`] (system credential
//!   manager in production, [`MemorySecretStore`] in tests), addressed by a
//!   revisioned key. Nothing here ever logs or serializes its bytes.
//! * The **index** (`account_id → committed CredentialRef`) switches in one
//!   step; the old revision is deleted only after that.
//! * [`CredentialLedger::recover`] is run on restart **before** anything is
//!   published: an operation that did not reach `IndexCommitted` is rolled
//!   back (its staged secret is discarded, the previous revision stays
//!   effective); one that did reach it only needs its old revision cleaned
//!   up. Whether a "ready" event was ever emitted plays no role.
//! * Late updates (an old `Set-Cookie`) carry the revision they were based
//!   on; [`CredentialLedger::check_revision`] rejects anything older than
//!   the committed revision.
//!
//! The ledger (index + journal) is one document the host persists atomically
//! (`to_json` / `from_json`); in the SQLite design this is one transaction.

use std::collections::BTreeMap;
use std::fmt;

use contracts::json::JsonValue;
use contracts::{AccountId, AppError};

use crate::error::{codes, err};
use crate::ids::{random_hex16, ProfileId};

/// Opaque secret bytes. `Debug` is masked so a stray `{:?}` never prints a
/// ticket.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(Vec<u8>);

impl Secret {
    pub fn new(bytes: impl Into<Vec<u8>>) -> Self {
        Self(bytes.into())
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Raw bytes. Only a [`SecretStore`] implementation should call this.
    pub fn expose(&self) -> &[u8] {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Secret(<{} bytes masked>)", self.0.len())
    }
}

/// Monotonic revision of an account's quick-login credential.
pub type CredentialRevision = u64;

/// Non-secret reference to a committed credential entry.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CredentialRef {
    /// Store key, e.g. `ticket:<environment>:<account_id>:r<revision>`.
    pub key: String,
    pub revision: CredentialRevision,
}

/// Reference to a staged (not yet committed) entry.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct StagedRef {
    pub target: CredentialRef,
    /// Store-specific token so the store can find the staged item again
    /// after a restart.
    pub handle: String,
}

/// Abstract credential store. Implementations must never persist the
/// secret anywhere else (no plaintext fallback, no truncation).
pub trait SecretStore {
    /// Durably writes `secret` as a staged entry under `target`. Must not
    /// touch any other revision.
    fn stage(&mut self, target: &CredentialRef, secret: &Secret) -> Result<StagedRef, AppError>;
    /// Promotes a staged entry to a committed one (same key/revision).
    fn commit(&mut self, staged: &StagedRef) -> Result<(), AppError>;
    /// Removes a staged entry (or a committed entry that was never
    /// referenced by the index). Idempotent.
    fn discard(&mut self, staged: &StagedRef) -> Result<(), AppError>;
    /// Removes a committed entry. Idempotent.
    fn delete(&mut self, target: &CredentialRef) -> Result<(), AppError>;
    /// Whether a committed entry exists for `target`.
    fn contains(&self, target: &CredentialRef) -> bool;
}

/// In-memory store for tests and prototypes. Mirrors the Windows credential
/// manager's 2560-byte blob limit by default.
#[derive(Debug, Default)]
pub struct MemorySecretStore {
    staged: BTreeMap<String, Secret>,
    committed: BTreeMap<String, Secret>,
    max_bytes: Option<usize>,
    fail_next_stage: bool,
}

impl MemorySecretStore {
    pub fn new() -> Self {
        Self {
            max_bytes: Some(2560),
            ..Self::default()
        }
    }

    pub fn with_max_bytes(mut self, max: Option<usize>) -> Self {
        self.max_bytes = max;
        self
    }

    /// Fault injection: the next `stage` call fails with
    /// `account.credential_store`.
    pub fn fail_next_stage(&mut self) {
        self.fail_next_stage = true;
    }

    pub fn committed_keys(&self) -> Vec<String> {
        self.committed.keys().cloned().collect()
    }

    pub fn staged_keys(&self) -> Vec<String> {
        self.staged.keys().cloned().collect()
    }

    pub fn read_committed(&self, target: &CredentialRef) -> Option<&Secret> {
        self.committed.get(&target.key)
    }
}

impl SecretStore for MemorySecretStore {
    fn stage(&mut self, target: &CredentialRef, secret: &Secret) -> Result<StagedRef, AppError> {
        if self.fail_next_stage {
            self.fail_next_stage = false;
            return Err(err(
                codes::ACCOUNT_CREDENTIAL_STORE,
                "injected stage failure",
            ));
        }
        if let Some(max) = self.max_bytes {
            if secret.len() > max {
                return Err(err(
                    codes::ACCOUNT_CREDENTIAL_STORE,
                    format!(
                        "secret of {} bytes exceeds store limit {}",
                        secret.len(),
                        max
                    ),
                ));
            }
        }
        self.staged.insert(target.key.clone(), secret.clone());
        Ok(StagedRef {
            target: target.clone(),
            handle: target.key.clone(),
        })
    }

    fn commit(&mut self, staged: &StagedRef) -> Result<(), AppError> {
        match self.staged.remove(&staged.handle) {
            Some(secret) => {
                self.committed.insert(staged.target.key.clone(), secret);
                Ok(())
            }
            None if self.committed.contains_key(&staged.target.key) => Ok(()),
            None => Err(err(codes::ACCOUNT_CREDENTIAL_STORE, "staged entry missing")),
        }
    }

    fn discard(&mut self, staged: &StagedRef) -> Result<(), AppError> {
        self.staged.remove(&staged.handle);
        self.committed.remove(&staged.target.key);
        Ok(())
    }

    fn delete(&mut self, target: &CredentialRef) -> Result<(), AppError> {
        self.committed.remove(&target.key);
        Ok(())
    }

    fn contains(&self, target: &CredentialRef) -> bool {
        self.committed.contains_key(&target.key)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommitStage {
    Prepared,
    SecretStaged,
    IndexCommitted,
}

impl CommitStage {
    fn as_str(self) -> &'static str {
        match self {
            CommitStage::Prepared => "prepared",
            CommitStage::SecretStaged => "secret_staged",
            CommitStage::IndexCommitted => "index_committed",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        match s {
            "prepared" => Some(CommitStage::Prepared),
            "secret_staged" => Some(CommitStage::SecretStaged),
            "index_committed" => Some(CommitStage::IndexCommitted),
            _ => None,
        }
    }
}

/// Non-secret journal row (`CredentialCommitJournal` in ACC-03).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalEntry {
    pub operation_id: String,
    pub account_id: AccountId,
    pub profile_id: ProfileId,
    pub new_ref: CredentialRef,
    pub old_ref: Option<CredentialRef>,
    pub stage: CommitStage,
    pub staged: Option<StagedRef>,
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct CredentialJournal {
    entries: BTreeMap<String, JournalEntry>,
}

impl CredentialJournal {
    pub fn entries(&self) -> impl Iterator<Item = &JournalEntry> {
        self.entries.values()
    }

    pub fn get(&self, operation_id: &str) -> Option<&JournalEntry> {
        self.entries.get(operation_id)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// Outcome of [`CredentialLedger::recover`].
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RecoveryReport {
    /// Operations rolled back (never reached `IndexCommitted`).
    pub rolled_back: Vec<String>,
    /// Operations whose cleanup (old revision deletion) was completed.
    pub completed: Vec<String>,
    /// Accounts whose committed entry is missing from the store: the
    /// account must re-authenticate; it must not become online.
    pub missing_secret: Vec<AccountId>,
}

/// Index + journal. One instance per registry.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct CredentialLedger {
    index: BTreeMap<AccountId, CredentialRef>,
    journal: CredentialJournal,
    /// Highest revision ever prepared per account (so a rolled-back
    /// revision number is never reused).
    high_water: BTreeMap<AccountId, CredentialRevision>,
}

impl CredentialLedger {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn committed(&self, account_id: &AccountId) -> Option<&CredentialRef> {
        self.index.get(account_id)
    }

    pub fn journal(&self) -> &CredentialJournal {
        &self.journal
    }

    /// Rejects a candidate update that was produced against a revision
    /// older than the committed one (a late `Set-Cookie`).
    pub fn check_revision(
        &self,
        account_id: &AccountId,
        based_on: CredentialRevision,
    ) -> Result<(), AppError> {
        let current = self.index.get(account_id).map(|r| r.revision).unwrap_or(0);
        if based_on < current {
            return Err(err(
                codes::ACCOUNT_STALE_CREDENTIAL_REVISION,
                format!("update based on revision {based_on}, committed is {current}"),
            ));
        }
        Ok(())
    }

    fn next_revision(&self, account_id: &AccountId) -> CredentialRevision {
        let committed = self.index.get(account_id).map(|r| r.revision).unwrap_or(0);
        let high = self.high_water.get(account_id).copied().unwrap_or(0);
        committed.max(high) + 1
    }

    /// Step 1: writes the non-secret journal row. Nothing touches the
    /// secret store yet.
    pub fn prepare(
        &mut self,
        account_id: &AccountId,
        profile_id: &ProfileId,
        key_prefix: &str,
    ) -> JournalEntry {
        let revision = self.next_revision(account_id);
        self.high_water.insert(account_id.clone(), revision);
        let entry = JournalEntry {
            operation_id: format!("op_{}", random_hex16("op")),
            account_id: account_id.clone(),
            profile_id: profile_id.clone(),
            new_ref: CredentialRef {
                key: format!("{key_prefix}:r{revision}"),
                revision,
            },
            old_ref: self.index.get(account_id).cloned(),
            stage: CommitStage::Prepared,
            staged: None,
        };
        self.journal
            .entries
            .insert(entry.operation_id.clone(), entry.clone());
        entry
    }

    fn entry_mut(
        &mut self,
        operation_id: &str,
        expect: CommitStage,
    ) -> Result<&mut JournalEntry, AppError> {
        let entry = self
            .journal
            .entries
            .get_mut(operation_id)
            .ok_or_else(|| err(codes::ACCOUNT_CREDENTIAL_OPERATION, "unknown operation"))?;
        if entry.stage != expect {
            return Err(err(
                codes::ACCOUNT_CREDENTIAL_OPERATION,
                format!(
                    "operation is {} not {}",
                    entry.stage.as_str(),
                    expect.as_str()
                ),
            ));
        }
        Ok(entry)
    }

    /// Step 2: writes the secret under the new revision and records the
    /// staged reference in the journal. The old revision is untouched.
    pub fn stage(
        &mut self,
        operation_id: &str,
        store: &mut dyn SecretStore,
        secret: &Secret,
    ) -> Result<StagedRef, AppError> {
        let entry = self.entry_mut(operation_id, CommitStage::Prepared)?;
        let staged = store.stage(&entry.new_ref, secret)?;
        entry.staged = Some(staged.clone());
        entry.stage = CommitStage::SecretStaged;
        Ok(staged)
    }

    /// Step 3: promotes the secret, switches the index atomically, marks
    /// the journal row committed and only then deletes the old revision.
    pub fn commit(
        &mut self,
        operation_id: &str,
        store: &mut dyn SecretStore,
    ) -> Result<CredentialRef, AppError> {
        let entry = self.entry_mut(operation_id, CommitStage::SecretStaged)?;
        let staged = entry
            .staged
            .clone()
            .ok_or_else(|| err(codes::ACCOUNT_CREDENTIAL_OPERATION, "no staged reference"))?;
        store.commit(&staged)?;
        let (account_id, new_ref, old_ref) = (
            entry.account_id.clone(),
            entry.new_ref.clone(),
            entry.old_ref.clone(),
        );
        // Index switch + journal stage are one in-memory step (one SQLite
        // transaction in the real store).
        self.index.insert(account_id, new_ref.clone());
        if let Some(e) = self.journal.entries.get_mut(operation_id) {
            e.stage = CommitStage::IndexCommitted;
        }
        self.finish_committed(operation_id, old_ref.as_ref(), store);
        Ok(new_ref)
    }

    fn finish_committed(
        &mut self,
        operation_id: &str,
        old_ref: Option<&CredentialRef>,
        store: &mut dyn SecretStore,
    ) {
        let cleaned = match old_ref {
            Some(old) => store.delete(old).is_ok(),
            None => true,
        };
        if cleaned {
            self.journal.entries.remove(operation_id);
        }
        // Otherwise the IndexCommitted row stays and `recover` retries the
        // deletion on the next start.
    }

    /// Rolls back an operation that has not been committed.
    pub fn abort(
        &mut self,
        operation_id: &str,
        store: &mut dyn SecretStore,
    ) -> Result<(), AppError> {
        let entry = self
            .journal
            .entries
            .get(operation_id)
            .cloned()
            .ok_or_else(|| err(codes::ACCOUNT_CREDENTIAL_OPERATION, "unknown operation"))?;
        if entry.stage == CommitStage::IndexCommitted {
            return Err(err(
                codes::ACCOUNT_CREDENTIAL_OPERATION,
                "already committed",
            ));
        }
        if let Some(staged) = &entry.staged {
            store.discard(staged)?;
        }
        self.journal.entries.remove(operation_id);
        Ok(())
    }

    /// Restart resolution: decides every pending journal row from the
    /// committed index, never from whether `ready` was emitted.
    pub fn recover(&mut self, store: &mut dyn SecretStore) -> RecoveryReport {
        let mut report = RecoveryReport::default();
        let ops: Vec<JournalEntry> = self.journal.entries.values().cloned().collect();
        for entry in ops {
            match entry.stage {
                CommitStage::Prepared | CommitStage::SecretStaged => {
                    if let Some(staged) = &entry.staged {
                        let _ = store.discard(staged);
                    }
                    self.journal.entries.remove(&entry.operation_id);
                    report.rolled_back.push(entry.operation_id.clone());
                }
                CommitStage::IndexCommitted => {
                    // Index already points at new_ref (same transaction);
                    // make sure it really does, then finish cleanup.
                    self.index
                        .insert(entry.account_id.clone(), entry.new_ref.clone());
                    self.finish_committed(&entry.operation_id, entry.old_ref.as_ref(), store);
                    report.completed.push(entry.operation_id.clone());
                }
            }
        }
        for (account_id, cref) in &self.index {
            if !store.contains(cref) {
                report.missing_secret.push(account_id.clone());
            }
        }
        report
    }

    /// Drops the index entry (logout / forget). Returns the reference the
    /// host must delete from the store **after** the generation advanced.
    pub fn remove_account(&mut self, account_id: &AccountId) -> Option<CredentialRef> {
        self.index.remove(account_id)
    }

    pub fn to_json(&self) -> JsonValue {
        let mut index = JsonValue::object();
        for (acc, r) in &self.index {
            index.insert(acc.as_str(), cref_json(r));
        }
        let journal = self
            .journal
            .entries
            .values()
            .map(|e| {
                let mut o = JsonValue::object();
                o.insert("operation_id", JsonValue::string(&e.operation_id));
                o.insert("account_id", JsonValue::string(e.account_id.as_str()));
                o.insert("profile_id", JsonValue::string(e.profile_id.as_str()));
                o.insert("new_ref", cref_json(&e.new_ref));
                o.insert(
                    "old_ref",
                    e.old_ref.as_ref().map(cref_json).unwrap_or(JsonValue::Null),
                );
                o.insert("stage", JsonValue::string(e.stage.as_str()));
                o.insert(
                    "staged",
                    e.staged
                        .as_ref()
                        .map(|s| {
                            let mut so = JsonValue::object();
                            so.insert("target", cref_json(&s.target));
                            so.insert("handle", JsonValue::string(&s.handle));
                            so
                        })
                        .unwrap_or(JsonValue::Null),
                );
                o
            })
            .collect();
        let mut high = JsonValue::object();
        for (acc, rev) in &self.high_water {
            high.insert(acc.as_str(), JsonValue::number_from_i64(*rev as i64));
        }
        let mut doc = JsonValue::object();
        doc.insert("version", JsonValue::number_from_i64(1));
        doc.insert("index", index);
        doc.insert("journal", JsonValue::Array(journal));
        doc.insert("high_water", high);
        doc
    }

    pub fn from_json(doc: &JsonValue) -> Result<Self, AppError> {
        let corrupt = |m: &str| err(codes::ACCOUNT_RESTORE_CORRUPT, format!("ledger: {m}"));
        let mut ledger = Self::new();
        if let Some(index) = doc.get("index").and_then(JsonValue::as_object) {
            for (acc, v) in index {
                ledger.index.insert(
                    AccountId::new(acc.clone()),
                    cref_from_json(v).ok_or_else(|| corrupt("bad index ref"))?,
                );
            }
        }
        if let Some(high) = doc.get("high_water").and_then(JsonValue::as_object) {
            for (acc, v) in high {
                ledger.high_water.insert(
                    AccountId::new(acc.clone()),
                    v.as_i64().unwrap_or(0).max(0) as u64,
                );
            }
        }
        if let Some(rows) = doc.get("journal").and_then(JsonValue::as_array) {
            for row in rows {
                let s = |k: &str| {
                    row.get(k)
                        .and_then(JsonValue::as_str)
                        .map(str::to_string)
                        .ok_or_else(|| corrupt(&format!("journal missing {k}")))
                };
                let staged = match row.get("staged") {
                    Some(JsonValue::Object(_)) => {
                        let sv = row.get("staged").ok_or_else(|| corrupt("staged"))?;
                        Some(StagedRef {
                            target: sv
                                .get("target")
                                .and_then(cref_from_json)
                                .ok_or_else(|| corrupt("staged target"))?,
                            handle: sv
                                .get("handle")
                                .and_then(JsonValue::as_str)
                                .ok_or_else(|| corrupt("staged handle"))?
                                .to_string(),
                        })
                    }
                    _ => None,
                };
                let entry = JournalEntry {
                    operation_id: s("operation_id")?,
                    account_id: AccountId::new(s("account_id")?),
                    profile_id: ProfileId::new(s("profile_id")?),
                    new_ref: row
                        .get("new_ref")
                        .and_then(cref_from_json)
                        .ok_or_else(|| corrupt("new_ref"))?,
                    old_ref: row.get("old_ref").and_then(cref_from_json),
                    stage: CommitStage::parse(&s("stage")?).ok_or_else(|| corrupt("stage"))?,
                    staged,
                };
                ledger
                    .journal
                    .entries
                    .insert(entry.operation_id.clone(), entry);
            }
        }
        Ok(ledger)
    }
}

fn cref_json(r: &CredentialRef) -> JsonValue {
    let mut o = JsonValue::object();
    o.insert("key", JsonValue::string(&r.key));
    o.insert("revision", JsonValue::number_from_i64(r.revision as i64));
    o
}

fn cref_from_json(v: &JsonValue) -> Option<CredentialRef> {
    Some(CredentialRef {
        key: v.get("key")?.as_str()?.to_string(),
        revision: v.get("revision")?.as_i64()?.max(0) as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn acc() -> AccountId {
        AccountId::new("acc_test")
    }

    #[test]
    fn secret_debug_is_masked() {
        let s = Secret::new(b"PLACEHOLDER-TICKET".to_vec());
        let d = format!("{s:?}");
        assert!(!d.contains("PLACEHOLDER"));
        assert!(d.contains("masked"));
    }

    #[test]
    fn full_commit_cleans_old_revision_only_after_index_switch() {
        let mut store = MemorySecretStore::new();
        let mut ledger = CredentialLedger::new();
        let p = ProfileId::new("p_1");
        let op1 = ledger.prepare(&acc(), &p, "ticket:test:acc_test");
        assert_eq!(op1.stage, CommitStage::Prepared);
        assert!(
            store.staged_keys().is_empty(),
            "journal first, no secret yet"
        );
        ledger
            .stage(&op1.operation_id, &mut store, &Secret::new(b"v1".to_vec()))
            .expect("stage");
        let r1 = ledger
            .commit(&op1.operation_id, &mut store)
            .expect("commit");
        assert_eq!(r1.revision, 1);
        assert!(ledger.journal().is_empty());

        let op2 = ledger.prepare(&acc(), &p, "ticket:test:acc_test");
        ledger
            .stage(&op2.operation_id, &mut store, &Secret::new(b"v2".to_vec()))
            .expect("stage");
        assert!(
            store.contains(&r1),
            "old revision still present before commit"
        );
        let r2 = ledger
            .commit(&op2.operation_id, &mut store)
            .expect("commit");
        assert_eq!(r2.revision, 2);
        assert!(!store.contains(&r1), "old revision deleted after commit");
        assert_eq!(ledger.committed(&acc()), Some(&r2));
    }

    #[test]
    fn oversized_secret_is_rejected_not_truncated() {
        let mut store = MemorySecretStore::new();
        let mut ledger = CredentialLedger::new();
        let op = ledger.prepare(&acc(), &ProfileId::new("p"), "k");
        let big = Secret::new(vec![b'x'; 3000]);
        let e = ledger
            .stage(&op.operation_id, &mut store, &big)
            .expect_err("too large");
        assert!(e.is(codes::ACCOUNT_CREDENTIAL_STORE));
        assert!(store.staged_keys().is_empty());
        ledger.abort(&op.operation_id, &mut store).expect("abort");
        assert!(ledger.journal().is_empty());
    }

    #[test]
    fn ledger_json_round_trip_has_no_secret() {
        let mut store = MemorySecretStore::new();
        let mut ledger = CredentialLedger::new();
        let op = ledger.prepare(&acc(), &ProfileId::new("p"), "k");
        ledger
            .stage(
                &op.operation_id,
                &mut store,
                &Secret::new(b"SECRET-PLACEHOLDER".to_vec()),
            )
            .expect("stage");
        let text = ledger.to_json().to_json();
        assert!(!text.contains("SECRET-PLACEHOLDER"));
        let back =
            CredentialLedger::from_json(&JsonValue::parse(&text).expect("parse")).expect("restore");
        assert_eq!(back, ledger);
    }
}

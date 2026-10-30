//! Reminder (waiting round) state: the minimum the strong-alert window
//! needs to survive a restart (05-store: 身份代次、会话 ID、等待 round/version、
//! 可确认的起始消息与时间、已提醒版本和用户隐藏版本).
//!
//! Whatever is loaded after a restart is **待核对**: [`load_all`] returns a
//! [`PendingVerification`] that only yields the records once the caller
//! presents [`ReconcileEvidence`] (compensation and conversation read-back
//! complete). Popping or sounding before that is impossible by type.
//!
//! [`load_all`]: ReminderStateRepo::load_all

use contracts::json::JsonValue;
use contracts::AppError;

use super::{decode_err, json_opt_i64, json_opt_str, opt_bool, opt_i64, opt_str, req_i64, req_str};
use crate::error::{codes, err};
use crate::store::{Namespace, Store, Txn};

pub const COLLECTION: &str = "rounds";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoundRecord {
    pub gid: String,
    pub round_id: String,
    /// Increments on every change; a stale hide/ack cannot act on a newer
    /// round state.
    pub version: u64,
    pub start_message_id: Option<String>,
    pub start_time_ms: Option<i64>,
    pub start_confirmed: bool,
    /// Highest version the user has already been reminded about.
    pub reminded_version: u64,
    /// Version at which the user hid the round ("暂时隐藏").
    pub hidden_version: u64,
    pub snoozed_until_ms: Option<i64>,
}

impl RoundRecord {
    pub fn key(gid: &str, round_id: &str) -> String {
        format!("{gid}#{round_id}")
    }

    fn to_json(&self) -> JsonValue {
        let mut o = JsonValue::object();
        o.insert("gid", JsonValue::string(&self.gid));
        o.insert("round_id", JsonValue::string(&self.round_id));
        o.insert("version", JsonValue::number_from_i64(self.version as i64));
        o.insert("start_message_id", json_opt_str(&self.start_message_id));
        o.insert("start_time_ms", json_opt_i64(self.start_time_ms));
        o.insert("start_confirmed", JsonValue::Bool(self.start_confirmed));
        o.insert("reminded_version", JsonValue::number_from_i64(self.reminded_version as i64));
        o.insert("hidden_version", JsonValue::number_from_i64(self.hidden_version as i64));
        o.insert("snoozed_until_ms", json_opt_i64(self.snoozed_until_ms));
        o
    }

    fn from_json(key: &str, v: &JsonValue) -> Result<Self, AppError> {
        Ok(Self {
            gid: req_str(v, "gid", COLLECTION, key)?,
            round_id: req_str(v, "round_id", COLLECTION, key)?,
            version: req_i64(v, "version", COLLECTION, key)?.max(0) as u64,
            start_message_id: opt_str(v, "start_message_id"),
            start_time_ms: opt_i64(v, "start_time_ms"),
            start_confirmed: opt_bool(v, "start_confirmed").unwrap_or(false),
            reminded_version: opt_i64(v, "reminded_version").unwrap_or(0).max(0) as u64,
            hidden_version: opt_i64(v, "hidden_version").unwrap_or(0).max(0) as u64,
            snoozed_until_ms: opt_i64(v, "snoozed_until_ms"),
        })
    }
}

/// Proof that the restart reconciliation finished. Both flags must be true;
/// core-im sets them after compensation and the conversation read-back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReconcileEvidence {
    pub compensation_complete: bool,
    pub conversation_readback_complete: bool,
}

impl ReconcileEvidence {
    pub fn complete() -> Self {
        Self {
            compensation_complete: true,
            conversation_readback_complete: true,
        }
    }

    pub fn is_complete(&self) -> bool {
        self.compensation_complete && self.conversation_readback_complete
    }
}

/// Data loaded from disk that must be reconciled before use.
#[derive(Debug)]
pub struct PendingVerification<T> {
    inner: T,
    len: usize,
}

impl<T> PendingVerification<T> {
    pub(crate) fn new(inner: T, len: usize) -> Self {
        Self { inner, len }
    }

    /// Number of pending records (for diagnostics only).
    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Releases the data. Fails with `store.not_reconciled` unless the
    /// evidence is complete.
    pub fn reconcile(self, evidence: ReconcileEvidence) -> Result<T, AppError> {
        if !evidence.is_complete() {
            return Err(err(
                codes::STORE_NOT_RECONCILED,
                "restart data is pending verification; finish compensation and read-back first",
            ));
        }
        Ok(self.inner)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ReminderStateRepo;

impl ReminderStateRepo {
    pub fn put(txn: &mut Txn, record: &RoundRecord) {
        crate::assert_no_secret_like(&record.gid);
        crate::assert_no_secret_like(&record.round_id);
        txn.put(COLLECTION, &RoundRecord::key(&record.gid, &record.round_id), record.to_json());
    }

    pub fn remove(txn: &mut Txn, gid: &str, round_id: &str) {
        txn.delete(COLLECTION, &RoundRecord::key(gid, round_id));
    }

    pub fn get(store: &dyn Store, ns: &Namespace, gid: &str, round_id: &str) -> Result<Option<RoundRecord>, AppError> {
        let key = RoundRecord::key(gid, round_id);
        store
            .get(ns, COLLECTION, &key)?
            .map(|v| RoundRecord::from_json(&key, &v))
            .transpose()
    }

    /// Everything persisted for the namespace, wrapped as pending
    /// verification.
    pub fn load_all(store: &dyn Store, ns: &Namespace) -> Result<PendingVerification<Vec<RoundRecord>>, AppError> {
        let mut out = Vec::new();
        for (key, v) in store.list(ns, COLLECTION)? {
            let rec = RoundRecord::from_json(&key, &v)?;
            if RoundRecord::key(&rec.gid, &rec.round_id) != key {
                return Err(decode_err(COLLECTION, &key, "key does not match record"));
            }
            out.push(rec);
        }
        let len = out.len();
        Ok(PendingVerification::new(out, len))
    }
}

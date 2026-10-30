//! Send intents (plan §2 invariant 2, §7 "迟到回复证据", F08).
//!
//! An intent is persisted **before** the send and is immutable except for
//! its disposition. `Unknown` survives restarts untouched: there is no
//! "pending resend" state in this type at all, and loading never changes a
//! record. [`SendIntentRepo::unknown_intents`] exists for reconciliation
//! only.

use contracts::json::JsonValue;
use contracts::{AccountContext, AccountId, AppError, Environment, SendDisposition};

use super::{decode_err, json_opt_str, opt_str, req_i64, req_str};
use crate::error::{codes, err};
use crate::store::{Namespace, Store, Txn};

pub const COLLECTION: &str = "send_intents";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendIntentRecord {
    /// Stable local id chosen when the intent was created.
    pub local_id: String,
    pub gid: String,
    /// Context (with generation) the intent was created under.
    pub account: AccountContext,
    pub created_at_ms: i64,
    /// Waiting round frozen at send time (a late ACK may only close this
    /// round, never a newer one).
    pub frozen_round_id: Option<String>,
    /// Newest customer message id seen at send time: the reply boundary.
    pub customer_boundary_message_id: Option<String>,
    pub disposition: SendDisposition,
    /// Server message id once known (from `send_result` or read-back).
    pub server_message_id: Option<String>,
}

impl SendIntentRecord {
    pub fn new(local_id: impl Into<String>, gid: impl Into<String>, account: AccountContext, created_at_ms: i64) -> Self {
        Self {
            local_id: local_id.into(),
            gid: gid.into(),
            account,
            created_at_ms,
            frozen_round_id: None,
            customer_boundary_message_id: None,
            disposition: SendDisposition::Unknown,
            server_message_id: None,
        }
    }

    /// Unknown outcome: must be reconciled against server facts, never
    /// resent blindly.
    pub fn needs_reconciliation(&self) -> bool {
        matches!(self.disposition, SendDisposition::Unknown)
    }

    fn to_json(&self) -> JsonValue {
        let mut acc = JsonValue::object();
        acc.insert("account_id", JsonValue::string(self.account.account_id.as_str()));
        acc.insert("environment", JsonValue::string(self.account.environment.as_str()));
        acc.insert(
            "session_generation",
            JsonValue::number_from_i64(self.account.session_generation as i64),
        );
        let mut disp = JsonValue::object();
        match &self.disposition {
            SendDisposition::Confirmed {
                server_message_id,
                server_time_ms,
            } => {
                disp.insert("kind", JsonValue::string("confirmed"));
                disp.insert("server_message_id", JsonValue::string(server_message_id));
                disp.insert("server_time_ms", JsonValue::number_from_i64(*server_time_ms));
            }
            SendDisposition::Rejected { code, reason } => {
                disp.insert("kind", JsonValue::string("rejected"));
                disp.insert("code", JsonValue::string(code));
                disp.insert("reason", JsonValue::string(reason));
            }
            SendDisposition::Unknown => {
                disp.insert("kind", JsonValue::string("unknown"));
            }
        }
        let mut o = JsonValue::object();
        o.insert("local_id", JsonValue::string(&self.local_id));
        o.insert("gid", JsonValue::string(&self.gid));
        o.insert("account", acc);
        o.insert("created_at_ms", JsonValue::number_from_i64(self.created_at_ms));
        o.insert("frozen_round_id", json_opt_str(&self.frozen_round_id));
        o.insert(
            "customer_boundary_message_id",
            json_opt_str(&self.customer_boundary_message_id),
        );
        o.insert("disposition", disp);
        o.insert("server_message_id", json_opt_str(&self.server_message_id));
        o
    }

    fn from_json(key: &str, v: &JsonValue) -> Result<Self, AppError> {
        let acc = v
            .get("account")
            .ok_or_else(|| decode_err(COLLECTION, key, "missing account"))?;
        let account = AccountContext::new(
            AccountId::new(req_str(acc, "account_id", COLLECTION, key)?),
            Environment::named(req_str(acc, "environment", COLLECTION, key)?),
            req_i64(acc, "session_generation", COLLECTION, key)?.max(0) as u64,
        );
        let d = v
            .get("disposition")
            .ok_or_else(|| decode_err(COLLECTION, key, "missing disposition"))?;
        let disposition = match d.get("kind").and_then(JsonValue::as_str) {
            Some("confirmed") => SendDisposition::Confirmed {
                server_message_id: req_str(d, "server_message_id", COLLECTION, key)?,
                server_time_ms: req_i64(d, "server_time_ms", COLLECTION, key)?,
            },
            Some("rejected") => SendDisposition::Rejected {
                code: req_str(d, "code", COLLECTION, key)?,
                reason: req_str(d, "reason", COLLECTION, key)?,
            },
            // Anything unrecognised is treated as unknown: never as
            // confirmed, never as "retry".
            _ => SendDisposition::Unknown,
        };
        Ok(Self {
            local_id: req_str(v, "local_id", COLLECTION, key)?,
            gid: req_str(v, "gid", COLLECTION, key)?,
            account,
            created_at_ms: req_i64(v, "created_at_ms", COLLECTION, key)?,
            frozen_round_id: opt_str(v, "frozen_round_id"),
            customer_boundary_message_id: opt_str(v, "customer_boundary_message_id"),
            disposition,
            server_message_id: opt_str(v, "server_message_id"),
        })
    }
}

#[derive(Debug, Clone, Copy)]
pub struct SendIntentRepo;

impl SendIntentRepo {
    /// Persists a new intent. The record's namespace must match the
    /// transaction's.
    pub fn put(txn: &mut Txn, record: &SendIntentRecord) -> Result<(), AppError> {
        crate::assert_no_secret_like(&record.local_id);
        crate::assert_no_secret_like(&record.gid);
        if Namespace::from_context(&record.account) != *txn.namespace() {
            return Err(err(
                codes::STORE_TXN_MISMATCH,
                "intent belongs to another namespace",
            ));
        }
        txn.put(COLLECTION, &record.local_id, record.to_json());
        Ok(())
    }

    /// Applies send evidence to an existing intent (read-modify-write with
    /// a CAS guard). `Unknown` evidence never overwrites a definite one.
    pub fn apply_disposition(
        store: &dyn Store,
        txn: &mut Txn,
        local_id: &str,
        disposition: SendDisposition,
    ) -> Result<SendIntentRecord, AppError> {
        let ns = txn.namespace().clone();
        let current = store.get(&ns, COLLECTION, local_id)?;
        let mut rec = current
            .as_ref()
            .map(|v| SendIntentRecord::from_json(local_id, v))
            .transpose()?
            .ok_or_else(|| err(codes::STORE_CAS_CONFLICT, "intent does not exist"))?;
        if matches!(disposition, SendDisposition::Unknown) && !rec.needs_reconciliation() {
            return Ok(rec);
        }
        if let SendDisposition::Confirmed { server_message_id, .. } = &disposition {
            rec.server_message_id = Some(server_message_id.clone());
        }
        rec.disposition = disposition;
        txn.expect_unchanged(COLLECTION, local_id, current);
        txn.put(COLLECTION, local_id, rec.to_json());
        Ok(rec)
    }

    pub fn remove(txn: &mut Txn, local_id: &str) {
        txn.delete(COLLECTION, local_id);
    }

    pub fn get(store: &dyn Store, ns: &Namespace, local_id: &str) -> Result<Option<SendIntentRecord>, AppError> {
        store
            .get(ns, COLLECTION, local_id)?
            .map(|v| SendIntentRecord::from_json(local_id, &v))
            .transpose()
    }

    pub fn load_all(store: &dyn Store, ns: &Namespace) -> Result<Vec<SendIntentRecord>, AppError> {
        store
            .list(ns, COLLECTION)?
            .iter()
            .map(|(k, v)| SendIntentRecord::from_json(k, v))
            .collect()
    }

    /// Intents whose outcome is unknown, **for reconciliation only**. The
    /// records are returned as stored; nothing is marked for resend.
    pub fn unknown_intents(store: &dyn Store, ns: &Namespace) -> Result<Vec<SendIntentRecord>, AppError> {
        Ok(Self::load_all(store, ns)?
            .into_iter()
            .filter(SendIntentRecord::needs_reconciliation)
            .collect())
    }
}

//! Drafts with compare-and-set versions (plan §3 "DraftSnapshot / CAS"): a
//! late translation or screenshot result carrying an old
//! `expected_version` cannot overwrite newer input.

use contracts::json::JsonValue;
use contracts::AppError;

use super::{req_i64, req_str};
use crate::error::{codes, err};
use crate::store::{Namespace, Store, Txn};

pub const COLLECTION: &str = "drafts";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DraftRecord {
    pub gid: String,
    /// The agent's own unsent text (never a customer message body).
    pub text: String,
    /// 0 = no draft; increments on every save.
    pub version: u64,
}

impl DraftRecord {
    fn to_json(&self) -> JsonValue {
        let mut o = JsonValue::object();
        o.insert("gid", JsonValue::string(&self.gid));
        o.insert("text", JsonValue::string(&self.text));
        o.insert("version", JsonValue::number_from_i64(self.version as i64));
        o
    }

    fn from_json(key: &str, v: &JsonValue) -> Result<Self, AppError> {
        Ok(Self {
            gid: req_str(v, "gid", COLLECTION, key)?,
            text: req_str(v, "text", COLLECTION, key)?,
            version: req_i64(v, "version", COLLECTION, key)?.max(0) as u64,
        })
    }
}

#[derive(Debug, Clone, Copy)]
pub struct DraftRepo;

impl DraftRepo {
    pub fn load(
        store: &dyn Store,
        ns: &Namespace,
        gid: &str,
    ) -> Result<Option<DraftRecord>, AppError> {
        store
            .get(ns, COLLECTION, gid)?
            .map(|v| DraftRecord::from_json(gid, &v))
            .transpose()
    }

    /// Current version (0 when there is no draft).
    pub fn version(store: &dyn Store, ns: &Namespace, gid: &str) -> Result<u64, AppError> {
        Ok(Self::load(store, ns, gid)?.map(|d| d.version).unwrap_or(0))
    }

    /// CAS save: fails with `store.cas_conflict` unless the stored version
    /// equals `expected_version`. The conflict is checked now and again at
    /// commit. Returns the new version (`expected_version + 1`).
    pub fn save_draft(
        store: &dyn Store,
        txn: &mut Txn,
        gid: &str,
        text: &str,
        expected_version: u64,
    ) -> Result<u64, AppError> {
        crate::assert_no_secret_like(gid);
        let ns = txn.namespace().clone();
        let current = store.get(&ns, COLLECTION, gid)?;
        let current_version = current
            .as_ref()
            .map(|v| DraftRecord::from_json(gid, v))
            .transpose()?
            .map(|d| d.version)
            .unwrap_or(0);
        if current_version != expected_version {
            return Err(err(
                codes::STORE_CAS_CONFLICT,
                format!("draft version is {current_version}, expected {expected_version}"),
            ));
        }
        let new_version = expected_version + 1;
        txn.expect_unchanged(COLLECTION, gid, current);
        txn.put(
            COLLECTION,
            gid,
            DraftRecord {
                gid: gid.to_string(),
                text: text.to_string(),
                version: new_version,
            }
            .to_json(),
        );
        Ok(new_version)
    }

    /// Deletes a draft; CAS on `expected_version`.
    pub fn delete_draft(
        store: &dyn Store,
        txn: &mut Txn,
        gid: &str,
        expected_version: u64,
    ) -> Result<(), AppError> {
        let ns = txn.namespace().clone();
        let current = store.get(&ns, COLLECTION, gid)?;
        let current_version = current
            .as_ref()
            .map(|v| DraftRecord::from_json(gid, v))
            .transpose()?
            .map(|d| d.version)
            .unwrap_or(0);
        if current_version != expected_version {
            return Err(err(
                codes::STORE_CAS_CONFLICT,
                format!("draft version is {current_version}, expected {expected_version}"),
            ));
        }
        txn.expect_unchanged(COLLECTION, gid, current);
        txn.delete(COLLECTION, gid);
        Ok(())
    }

    pub fn load_all(store: &dyn Store, ns: &Namespace) -> Result<Vec<DraftRecord>, AppError> {
        store
            .list(ns, COLLECTION)?
            .iter()
            .map(|(k, v)| DraftRecord::from_json(k, v))
            .collect()
    }
}

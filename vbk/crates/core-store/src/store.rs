//! Namespace, transaction and the `Store` trait, plus the namespace state
//! shared by both backends.

use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

use contracts::json::JsonValue;
use contracts::{AccountContext, AccountId, AppError, Environment};

use crate::error::{codes, err};

/// `(environment, account_id)`: the persistent identity key.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Namespace {
    pub environment: Environment,
    pub account_id: AccountId,
}

impl Namespace {
    pub fn new(environment: Environment, account_id: AccountId) -> Self {
        Self {
            environment,
            account_id,
        }
    }

    /// The namespace of a context (generation is not part of it).
    pub fn from_context(ctx: &AccountContext) -> Self {
        Self::new(ctx.environment.clone(), ctx.account_id.clone())
    }

    /// `<environment>/<account_id>`.
    pub fn key(&self) -> String {
        format!("{}/{}", self.environment.as_str(), self.account_id.as_str())
    }
}

/// Fact returned by a successful commit. Only after holding one may the
/// caller publish a snapshot or a success event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommitFact {
    /// Namespace revision after the commit (monotonic per namespace).
    pub revision: u64,
    pub committed_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Write {
    Put {
        collection: String,
        key: String,
        value: JsonValue,
    },
    Delete {
        collection: String,
        key: String,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Expectation {
    pub collection: String,
    pub key: String,
    pub observed: Option<JsonValue>,
}

/// A pending transaction. Mutations are buffered; nothing reaches the
/// store (or any reader) until [`Store::commit`].
#[derive(Debug, Clone)]
pub struct Txn {
    ns: Namespace,
    store_tag: u64,
    base_revision: u64,
    writes: Vec<Write>,
    expectations: Vec<Expectation>,
}

impl Txn {
    pub(crate) fn new(ns: Namespace, store_tag: u64, base_revision: u64) -> Self {
        Self {
            ns,
            store_tag,
            base_revision,
            writes: Vec::new(),
            expectations: Vec::new(),
        }
    }

    pub fn namespace(&self) -> &Namespace {
        &self.ns
    }

    /// Namespace revision observed when the transaction began.
    pub fn base_revision(&self) -> u64 {
        self.base_revision
    }

    pub fn put(&mut self, collection: &str, key: &str, value: JsonValue) {
        crate::assert_no_secret_like(collection);
        crate::assert_no_secret_like(key);
        self.writes.push(Write::Put {
            collection: collection.to_string(),
            key: key.to_string(),
            value,
        });
    }

    pub fn delete(&mut self, collection: &str, key: &str) {
        self.writes.push(Write::Delete {
            collection: collection.to_string(),
            key: key.to_string(),
        });
    }

    /// Compare-and-set guard: the commit fails with `store.cas_conflict`
    /// unless the record still equals `observed` (`None` = absent).
    pub fn expect_unchanged(&mut self, collection: &str, key: &str, observed: Option<JsonValue>) {
        self.expectations.push(Expectation {
            collection: collection.to_string(),
            key: key.to_string(),
            observed,
        });
    }

    pub fn is_empty(&self) -> bool {
        self.writes.is_empty()
    }

    pub fn write_count(&self) -> usize {
        self.writes.len()
    }

    pub(crate) fn into_parts(
        self,
        store_tag: u64,
    ) -> Result<(Namespace, Vec<Write>, Vec<Expectation>), AppError> {
        if self.store_tag != store_tag {
            return Err(err(
                codes::STORE_TXN_MISMATCH,
                "transaction was begun on a different store",
            ));
        }
        Ok((self.ns, self.writes, self.expectations))
    }
}

/// Explicit-transaction key/document store, one document tree per
/// namespace. Collections are string-named maps of `key → JsonValue`.
pub trait Store {
    /// Starts a transaction. Fails with `store.locked` on a logout-locked
    /// namespace and `store.corrupt` on a quarantined one.
    fn begin(&self, ns: &Namespace) -> Result<Txn, AppError>;
    /// Applies the transaction atomically. Nothing is visible before this
    /// returns `Ok`.
    fn commit(&self, txn: Txn) -> Result<CommitFact, AppError>;
    fn get(
        &self,
        ns: &Namespace,
        collection: &str,
        key: &str,
    ) -> Result<Option<JsonValue>, AppError>;
    /// All records of a collection, sorted by key.
    fn list(&self, ns: &Namespace, collection: &str) -> Result<Vec<(String, JsonValue)>, AppError>;
    /// Last commit fact; `None` when the namespace was never committed.
    fn last_commit(&self, ns: &Namespace) -> Result<Option<CommitFact>, AppError>;
    /// Makes the namespace read-only until [`Store::unlock_after_reauth`].
    /// Data is kept.
    fn logout_lock(&self, ns: &Namespace) -> Result<(), AppError>;
    fn unlock_after_reauth(&self, ns: &Namespace) -> Result<(), AppError>;
    fn is_locked(&self, ns: &Namespace) -> Result<bool, AppError>;
}

/// In-memory image of one namespace document (shared by both backends).
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct NsState {
    pub revision: u64,
    pub committed_at_ms: i64,
    pub collections: BTreeMap<String, BTreeMap<String, JsonValue>>,
}

impl NsState {
    pub fn get(&self, collection: &str, key: &str) -> Option<&JsonValue> {
        self.collections.get(collection)?.get(key)
    }

    pub fn list(&self, collection: &str) -> Vec<(String, JsonValue)> {
        self.collections
            .get(collection)
            .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default()
    }

    pub fn last_commit(&self) -> Option<CommitFact> {
        (self.revision > 0).then_some(CommitFact {
            revision: self.revision,
            committed_at_ms: self.committed_at_ms,
        })
    }

    /// Validates expectations, then applies writes. All or nothing: the
    /// caller only persists / publishes the returned state on `Ok`.
    pub fn apply(
        &self,
        writes: &[Write],
        expectations: &[Expectation],
        now_ms: i64,
    ) -> Result<(NsState, CommitFact), AppError> {
        for e in expectations {
            let current = self.get(&e.collection, &e.key);
            if current != e.observed.as_ref() {
                return Err(err(
                    codes::STORE_CAS_CONFLICT,
                    format!("{}/{} changed since it was read", e.collection, e.key),
                ));
            }
        }
        let mut next = self.clone();
        for w in writes {
            match w {
                Write::Put {
                    collection,
                    key,
                    value,
                } => {
                    next.collections
                        .entry(collection.clone())
                        .or_default()
                        .insert(key.clone(), value.clone());
                }
                Write::Delete { collection, key } => {
                    if let Some(m) = next.collections.get_mut(collection) {
                        m.remove(key);
                        if m.is_empty() {
                            next.collections.remove(collection);
                        }
                    }
                }
            }
        }
        next.revision = self.revision + 1;
        next.committed_at_ms = now_ms;
        let fact = CommitFact {
            revision: next.revision,
            committed_at_ms: now_ms,
        };
        Ok((next, fact))
    }

    /// Document form with an identity block that readers verify.
    pub fn to_json(&self, ns: &Namespace) -> JsonValue {
        let mut meta = JsonValue::object();
        meta.insert("format", JsonValue::number_from_i64(1));
        meta.insert("environment", JsonValue::string(ns.environment.as_str()));
        meta.insert("account_id", JsonValue::string(ns.account_id.as_str()));
        meta.insert("revision", JsonValue::number_from_i64(self.revision as i64));
        meta.insert(
            "committed_at_ms",
            JsonValue::number_from_i64(self.committed_at_ms),
        );
        let mut collections = JsonValue::object();
        for (name, records) in &self.collections {
            let mut obj = JsonValue::object();
            for (k, v) in records {
                obj.insert(k.clone(), v.clone());
            }
            collections.insert(name.clone(), obj);
        }
        let mut doc = JsonValue::object();
        doc.insert("meta", meta);
        doc.insert("collections", collections);
        doc
    }

    /// Decodes a document and checks it belongs to `ns`. The error string
    /// is a non-sensitive reason for the quarantine marker.
    pub fn from_json(doc: &JsonValue, ns: &Namespace) -> Result<Self, String> {
        let meta = doc.get("meta").ok_or("missing meta")?;
        let env = meta
            .get("environment")
            .and_then(JsonValue::as_str)
            .ok_or("missing environment")?;
        let acc = meta
            .get("account_id")
            .and_then(JsonValue::as_str)
            .ok_or("missing account_id")?;
        if env != ns.environment.as_str() || acc != ns.account_id.as_str() {
            return Err("identity mismatch".to_string());
        }
        let revision = meta
            .get("revision")
            .and_then(JsonValue::as_i64)
            .ok_or("missing revision")?;
        if revision < 0 {
            return Err("negative revision".to_string());
        }
        let committed_at_ms = meta
            .get("committed_at_ms")
            .and_then(JsonValue::as_i64)
            .unwrap_or(0);
        let mut collections = BTreeMap::new();
        if let Some(cols) = doc.get("collections") {
            let cols = cols.as_object().ok_or("collections is not an object")?;
            for (name, records) in cols {
                let records = records.as_object().ok_or("collection is not an object")?;
                collections.insert(name.clone(), records.clone());
            }
        }
        Ok(Self {
            revision: revision as u64,
            committed_at_ms,
            collections,
        })
    }
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ns() -> Namespace {
        Namespace::new(Environment::named("t"), AccountId::new("acc_1"))
    }

    #[test]
    fn apply_is_all_or_nothing_and_document_round_trips() {
        let state = NsState::default();
        let writes = vec![Write::Put {
            collection: "c".into(),
            key: "k".into(),
            value: JsonValue::string("v"),
        }];
        let (next, fact) = state.apply(&writes, &[], 5).expect("apply");
        assert_eq!(fact.revision, 1);
        assert_eq!(next.get("c", "k"), Some(&JsonValue::string("v")));

        let bad = vec![Expectation {
            collection: "c".into(),
            key: "k".into(),
            observed: None,
        }];
        let e = next.apply(&writes, &bad, 6).expect_err("conflict");
        assert!(e.is(codes::STORE_CAS_CONFLICT));

        let doc = next.to_json(&ns());
        let back = NsState::from_json(&JsonValue::parse(&doc.to_json()).expect("parse"), &ns())
            .expect("decode");
        assert_eq!(back, next);
        let other = Namespace::new(Environment::named("t"), AccountId::new("acc_2"));
        assert_eq!(
            NsState::from_json(&doc, &other),
            Err("identity mismatch".to_string())
        );
    }
}

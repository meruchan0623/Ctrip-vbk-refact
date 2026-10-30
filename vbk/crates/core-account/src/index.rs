//! Stable, persistable identity index: `(environment, buid) → account_id`.
//!
//! Plan §7 "保留账号数据与重认领": `Forget` removes the active entry,
//! credentials and profile but keeps this **non-secret** index so that a
//! later re-auth of the same `(environment, buid)` re-associates the old
//! `account_id` (and therefore its drafts, rounds and unknown intents)
//! instead of minting a new id and orphaning them.
//!
//! The index also remembers the highest `session_generation` ever issued
//! per account so a restarted process never re-accepts a handle from a
//! previous run (archive §4.2.1).

use std::collections::BTreeMap;

use contracts::json::JsonValue;
use contracts::{AccountId, AppError, Environment};

use crate::error::{codes, err};
use crate::ids::{mint_account_id, Buid};

/// One index row. Contains no secret and no customer data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexEntry {
    pub environment: Environment,
    pub buid: Buid,
    pub account_id: AccountId,
    /// Highest generation ever issued for this account.
    pub last_generation: u64,
}

#[derive(Debug, Default, Clone)]
pub struct IdentityIndex {
    by_upstream: BTreeMap<(Environment, Buid), IndexEntry>,
    by_account: BTreeMap<AccountId, (Environment, Buid)>,
}

impl IdentityIndex {
    pub fn new() -> Self {
        Self::default()
    }

    /// Looks up or mints the account id for an upstream identity. A new
    /// row is created with `last_generation = 0`.
    pub fn resolve_or_mint(&mut self, environment: &Environment, buid: &Buid) -> &mut IndexEntry {
        let key = (environment.clone(), buid.clone());
        let by_account = &mut self.by_account;
        self.by_upstream.entry(key.clone()).or_insert_with(|| {
            let mut account_id = mint_account_id();
            while by_account.contains_key(&account_id) {
                account_id = mint_account_id();
            }
            by_account.insert(account_id.clone(), key);
            IndexEntry {
                environment: environment.clone(),
                buid: buid.clone(),
                account_id,
                last_generation: 0,
            }
        })
    }

    pub fn lookup(&self, environment: &Environment, buid: &Buid) -> Option<&IndexEntry> {
        self.by_upstream.get(&(environment.clone(), buid.clone()))
    }

    pub fn entry_for(&self, account_id: &AccountId) -> Option<&IndexEntry> {
        let key = self.by_account.get(account_id)?;
        self.by_upstream.get(key)
    }

    pub(crate) fn entry_for_mut(&mut self, account_id: &AccountId) -> Option<&mut IndexEntry> {
        let key = self.by_account.get(account_id)?.clone();
        self.by_upstream.get_mut(&key)
    }

    pub fn len(&self) -> usize {
        self.by_upstream.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_upstream.is_empty()
    }

    /// Non-secret JSON document for persistence.
    pub fn to_json(&self) -> JsonValue {
        let rows = self
            .by_upstream
            .values()
            .map(|e| {
                let mut o = JsonValue::object();
                o.insert("environment", JsonValue::string(e.environment.as_str()));
                o.insert("buid", JsonValue::string(e.buid.as_str()));
                o.insert("account_id", JsonValue::string(e.account_id.as_str()));
                o.insert(
                    "last_generation",
                    JsonValue::number_from_i64(e.last_generation as i64),
                );
                o
            })
            .collect();
        let mut doc = JsonValue::object();
        doc.insert("version", JsonValue::number_from_i64(1));
        doc.insert("entries", JsonValue::Array(rows));
        doc
    }

    pub fn from_json(doc: &JsonValue) -> Result<Self, AppError> {
        let entries = doc
            .get("entries")
            .and_then(JsonValue::as_array)
            .ok_or_else(|| err(codes::ACCOUNT_RESTORE_CORRUPT, "index: missing entries"))?;
        let mut idx = Self::new();
        for row in entries {
            let s = |k: &str| {
                row.get(k)
                    .and_then(JsonValue::as_str)
                    .map(str::to_string)
                    .ok_or_else(|| {
                        err(
                            codes::ACCOUNT_RESTORE_CORRUPT,
                            format!("index: missing {k}"),
                        )
                    })
            };
            let entry = IndexEntry {
                environment: Environment::named(s("environment")?),
                buid: Buid::new(s("buid")?),
                account_id: AccountId::new(s("account_id")?),
                last_generation: row
                    .get("last_generation")
                    .and_then(JsonValue::as_i64)
                    .unwrap_or(0)
                    .max(0) as u64,
            };
            if idx.by_account.contains_key(&entry.account_id) {
                return Err(err(
                    codes::ACCOUNT_RESTORE_CORRUPT,
                    "index: duplicate account_id",
                ));
            }
            let key = (entry.environment.clone(), entry.buid.clone());
            idx.by_account.insert(entry.account_id.clone(), key.clone());
            idx.by_upstream.insert(key, entry);
        }
        Ok(idx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_upstream_maps_to_same_id_and_round_trips() {
        let env = Environment::named("test");
        let mut idx = IdentityIndex::new();
        let a = idx
            .resolve_or_mint(&env, &Buid::new("buid-a"))
            .account_id
            .clone();
        let a2 = idx
            .resolve_or_mint(&env, &Buid::new("buid-a"))
            .account_id
            .clone();
        let b = idx
            .resolve_or_mint(&env, &Buid::new("buid-b"))
            .account_id
            .clone();
        assert_eq!(a, a2);
        assert_ne!(a, b);
        idx.entry_for_mut(&a).expect("entry").last_generation = 7;

        let doc = idx.to_json();
        let text = doc.to_json();
        assert!(!text.contains("ticket"));
        let back =
            IdentityIndex::from_json(&JsonValue::parse(&text).expect("parse")).expect("restore");
        assert_eq!(
            back.lookup(&env, &Buid::new("buid-a"))
                .map(|e| &e.account_id),
            Some(&a)
        );
        assert_eq!(back.entry_for(&a).map(|e| e.last_generation), Some(7));
        assert_eq!(back.len(), 2);
    }
}

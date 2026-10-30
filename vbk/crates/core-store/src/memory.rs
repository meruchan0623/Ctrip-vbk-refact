//! In-memory `Store` for tests and prototypes. Same semantics as
//! `FileStore` (explicit commit, logout lock, CAS) without the disk.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use contracts::json::JsonValue;
use contracts::AppError;

use crate::error::{codes, err};
use crate::store::{now_ms, CommitFact, Namespace, NsState, Store, Txn};

static TAG: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Default)]
struct Slot {
    state: NsState,
    locked: bool,
}

#[derive(Debug)]
pub struct MemoryStore {
    tag: u64,
    slots: Mutex<BTreeMap<Namespace, Slot>>,
}

impl Default for MemoryStore {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryStore {
    pub fn new() -> Self {
        Self {
            tag: TAG.fetch_add(1, Ordering::Relaxed),
            slots: Mutex::new(BTreeMap::new()),
        }
    }

    fn with<R>(&self, f: impl FnOnce(&mut BTreeMap<Namespace, Slot>) -> R) -> R {
        let mut guard = self.slots.lock().unwrap_or_else(|p| p.into_inner());
        f(&mut guard)
    }

    pub fn namespaces(&self) -> Vec<Namespace> {
        self.with(|m| m.keys().cloned().collect())
    }
}

impl Store for MemoryStore {
    fn begin(&self, ns: &Namespace) -> Result<Txn, AppError> {
        self.with(|m| {
            let slot = m.entry(ns.clone()).or_default();
            if slot.locked {
                return Err(err(codes::STORE_LOCKED, "namespace is logout-locked"));
            }
            Ok(Txn::new(ns.clone(), self.tag, slot.state.revision))
        })
    }

    fn commit(&self, txn: Txn) -> Result<CommitFact, AppError> {
        let (ns, writes, expectations) = txn.into_parts(self.tag)?;
        self.with(|m| {
            let slot = m.entry(ns).or_default();
            if slot.locked {
                return Err(err(codes::STORE_LOCKED, "namespace is logout-locked"));
            }
            let (next, fact) = slot.state.apply(&writes, &expectations, now_ms())?;
            slot.state = next;
            Ok(fact)
        })
    }

    fn get(&self, ns: &Namespace, collection: &str, key: &str) -> Result<Option<JsonValue>, AppError> {
        Ok(self.with(|m| m.get(ns).and_then(|s| s.state.get(collection, key).cloned())))
    }

    fn list(&self, ns: &Namespace, collection: &str) -> Result<Vec<(String, JsonValue)>, AppError> {
        Ok(self.with(|m| m.get(ns).map(|s| s.state.list(collection)).unwrap_or_default()))
    }

    fn last_commit(&self, ns: &Namespace) -> Result<Option<CommitFact>, AppError> {
        Ok(self.with(|m| m.get(ns).and_then(|s| s.state.last_commit())))
    }

    fn logout_lock(&self, ns: &Namespace) -> Result<(), AppError> {
        self.with(|m| m.entry(ns.clone()).or_default().locked = true);
        Ok(())
    }

    fn unlock_after_reauth(&self, ns: &Namespace) -> Result<(), AppError> {
        self.with(|m| {
            if let Some(s) = m.get_mut(ns) {
                s.locked = false;
            }
        });
        Ok(())
    }

    fn is_locked(&self, ns: &Namespace) -> Result<bool, AppError> {
        Ok(self.with(|m| m.get(ns).map(|s| s.locked).unwrap_or(false)))
    }
}

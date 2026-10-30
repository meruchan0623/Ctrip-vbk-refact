//! Local-only "置顶" (isTop) per conversation. The web side has no server
//! field for it, so this never syncs anywhere.

use contracts::json::JsonValue;
use contracts::AppError;

use crate::store::{Namespace, Store, Txn};

pub const COLLECTION: &str = "pinned";

#[derive(Debug, Clone, Copy)]
pub struct PinnedRepo;

impl PinnedRepo {
    pub fn set_pinned(txn: &mut Txn, gid: &str, pinned: bool) {
        crate::assert_no_secret_like(gid);
        if pinned {
            let mut o = JsonValue::object();
            o.insert("is_top", JsonValue::Bool(true));
            txn.put(COLLECTION, gid, o);
        } else {
            txn.delete(COLLECTION, gid);
        }
    }

    pub fn is_pinned(store: &dyn Store, ns: &Namespace, gid: &str) -> Result<bool, AppError> {
        Ok(store
            .get(ns, COLLECTION, gid)?
            .and_then(|v| v.get("is_top").and_then(JsonValue::as_bool))
            .unwrap_or(false))
    }

    /// Pinned gids, sorted.
    pub fn pinned_gids(store: &dyn Store, ns: &Namespace) -> Result<Vec<String>, AppError> {
        Ok(store
            .list(ns, COLLECTION)?
            .into_iter()
            .filter(|(_, v)| {
                v.get("is_top")
                    .and_then(JsonValue::as_bool)
                    .unwrap_or(false)
            })
            .map(|(k, _)| k)
            .collect())
    }
}

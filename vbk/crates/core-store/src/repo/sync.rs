//! Sync watermarks (plan §2 invariant 3, §7 "IM分页措辞").
//!
//! * conversation-list cursor: `last_update_time_ms` of the ~5 s increment
//! * compensation cursor: `last_message_timestamp_ms` of `getRecentMessages`
//! * per-gid history: `page_breakpoint_ms` (where the next page starts) and
//!   `complete_watermark_ms` (proven complete up to here) are **separate**
//!   fields. A page commit only moves the breakpoint; only
//!   [`SyncWatermarkRepo::prove_complete`] moves the complete watermark.

use contracts::json::JsonValue;
use contracts::AppError;

use super::{json_opt_i64, opt_i64};
use crate::store::{Namespace, Store, Txn};

pub const COLLECTION: &str = "sync";
const CONVERSATION_KEY: &str = "conversation_list";
const COMPENSATION_KEY: &str = "compensation";
const HISTORY_PREFIX: &str = "history:";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct HistoryWatermark {
    /// Oldest message time fetched so far (next page continues before it).
    pub page_breakpoint_ms: Option<i64>,
    /// History is proven complete from this time onwards.
    pub complete_watermark_ms: Option<i64>,
}

impl HistoryWatermark {
    fn to_json(self) -> JsonValue {
        let mut o = JsonValue::object();
        o.insert("page_breakpoint_ms", json_opt_i64(self.page_breakpoint_ms));
        o.insert(
            "complete_watermark_ms",
            json_opt_i64(self.complete_watermark_ms),
        );
        o
    }

    fn from_json(v: &JsonValue) -> Self {
        Self {
            page_breakpoint_ms: opt_i64(v, "page_breakpoint_ms"),
            complete_watermark_ms: opt_i64(v, "complete_watermark_ms"),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct SyncWatermarkRepo;

impl SyncWatermarkRepo {
    fn history_key(gid: &str) -> String {
        format!("{HISTORY_PREFIX}{gid}")
    }

    fn single(
        store: &dyn Store,
        ns: &Namespace,
        key: &str,
        field: &str,
    ) -> Result<Option<i64>, AppError> {
        Ok(store
            .get(ns, COLLECTION, key)?
            .and_then(|v| opt_i64(&v, field)))
    }

    fn put_single(txn: &mut Txn, key: &str, field: &str, ms: i64) {
        let mut o = JsonValue::object();
        o.insert(field, JsonValue::number_from_i64(ms));
        txn.put(COLLECTION, key, o);
    }

    pub fn conversation_cursor(store: &dyn Store, ns: &Namespace) -> Result<Option<i64>, AppError> {
        Self::single(store, ns, CONVERSATION_KEY, "last_update_time_ms")
    }

    pub fn set_conversation_cursor(txn: &mut Txn, last_update_time_ms: i64) {
        Self::put_single(
            txn,
            CONVERSATION_KEY,
            "last_update_time_ms",
            last_update_time_ms,
        );
    }

    pub fn compensation_cursor(store: &dyn Store, ns: &Namespace) -> Result<Option<i64>, AppError> {
        Self::single(store, ns, COMPENSATION_KEY, "last_message_timestamp_ms")
    }

    pub fn set_compensation_cursor(txn: &mut Txn, last_message_timestamp_ms: i64) {
        Self::put_single(
            txn,
            COMPENSATION_KEY,
            "last_message_timestamp_ms",
            last_message_timestamp_ms,
        );
    }

    pub fn history(
        store: &dyn Store,
        ns: &Namespace,
        gid: &str,
    ) -> Result<HistoryWatermark, AppError> {
        Ok(store
            .get(ns, COLLECTION, &Self::history_key(gid))?
            .map(|v| HistoryWatermark::from_json(&v))
            .unwrap_or_default())
    }

    /// A page was committed: records where the next page starts. The
    /// complete watermark is preserved untouched.
    pub fn set_page_breakpoint(
        store: &dyn Store,
        txn: &mut Txn,
        gid: &str,
        breakpoint_ms: i64,
    ) -> Result<HistoryWatermark, AppError> {
        crate::assert_no_secret_like(gid);
        let mut wm = Self::history(store, txn.namespace(), gid)?;
        wm.page_breakpoint_ms = Some(breakpoint_ms);
        txn.put(COLLECTION, &Self::history_key(gid), wm.to_json());
        Ok(wm)
    }

    /// The caller proved the pagination round terminated (server said no
    /// more / reached an existing complete range). Only this moves the
    /// complete watermark; the breakpoint is preserved.
    pub fn prove_complete(
        store: &dyn Store,
        txn: &mut Txn,
        gid: &str,
        complete_ms: i64,
    ) -> Result<HistoryWatermark, AppError> {
        crate::assert_no_secret_like(gid);
        let mut wm = Self::history(store, txn.namespace(), gid)?;
        wm.complete_watermark_ms = Some(complete_ms);
        txn.put(COLLECTION, &Self::history_key(gid), wm.to_json());
        Ok(wm)
    }

    pub fn clear_history(txn: &mut Txn, gid: &str) {
        txn.delete(COLLECTION, &Self::history_key(gid));
    }
}

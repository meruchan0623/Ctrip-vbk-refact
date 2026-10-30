//! Per-identity minimal persistent state (std-only).
//!
//! Design sources: `docs/dev/05-store.md`, plan §2 invariants 2/3/5/6, §7
//! ("IM分页措辞", "保留账号数据与重认领"), DAT-01/02 and review rows F07/F08.
//! The archived SQLite design is intentionally **not** rebuilt: this crate
//! stores only what the independent strong-alert window and the send /
//! sync bookkeeping need.
//!
//! Model:
//!
//! * A [`Namespace`] is `(environment, account_id)`. Every record lives in
//!   exactly one namespace; on disk each namespace is its own directory, so
//!   two accounts (or the same buid in two environments) never share a file.
//! * [`Store`] exposes explicit transactions: `begin → put/delete →
//!   commit`. Nothing is visible, and no success event may be published,
//!   before `commit` returned a [`CommitFact`].
//! * `logout_lock` makes a namespace read-only (not deleted) until re-auth
//!   unlocks it: drafts, unknown intents and rounds survive a logout.
//! * [`FileStore`] writes a namespace document through a temp file plus
//!   rename. A document that cannot be decoded is quarantined
//!   (`state.json.corrupt-<unix_ms>`) and reported as `store.corrupt`; it is
//!   never silently wiped. IO failures are `store.io`.
//! * Repositories are plain functions over `&dyn Store` (reads) and
//!   `&mut Txn` (writes): [`ReminderStateRepo`], [`SendIntentRepo`],
//!   [`SyncWatermarkRepo`], [`DraftRepo`], [`PinnedRepo`].
//!
//! **No credentials, ever.** This crate has no type for a cookie, ticket or
//! password, and [`assert_no_secret_like`] guards identifiers in debug
//! builds. Customer message bodies are not stored either (drafts are the
//! agent's own unsent text).

pub mod error;
pub mod file;
pub mod memory;
pub mod repo;
pub mod store;

pub use error::codes;
pub use file::FileStore;
pub use memory::MemoryStore;
pub use repo::draft::{DraftRecord, DraftRepo};
pub use repo::pinned::PinnedRepo;
pub use repo::reminder::{PendingVerification, ReconcileEvidence, ReminderStateRepo, RoundRecord};
pub use repo::send_intent::{SendIntentRecord, SendIntentRepo};
pub use repo::sync::{HistoryWatermark, SyncWatermarkRepo};
pub use store::{CommitFact, Namespace, Store, Txn};

/// Upstream message scope used in a record dedup key. A local display
/// sequence is deliberately not representable here: it is not a server
/// cursor.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum UpstreamScope<'a> {
    /// Server message id (`tid` / `msgId`).
    ServerMessage(&'a str),
    /// Stable local intent id, only while the server id is unknown.
    LocalIntent(&'a str),
}

/// Dedup key for any per-message record:
/// `<environment>/<account_id>/<gid>#m:<server_id>` or `…#l:<local_id>`.
/// Always includes the namespace so the same gid in two accounts never
/// collides.
pub fn record_dedup_key(ns: &Namespace, gid: &str, scope: UpstreamScope<'_>) -> String {
    match scope {
        UpstreamScope::ServerMessage(id) => format!("{}/{}#m:{}", ns.key(), gid, id),
        UpstreamScope::LocalIntent(id) => format!("{}/{}#l:{}", ns.key(), gid, id),
    }
}

/// Patterns that must never appear in anything this crate persists.
const SECRET_PATTERNS: [&str; 5] = ["bticket=", "vbkticket=", "Cookie:", "cookie:", "BDUID="];

/// True when `s` looks like it carries a login credential.
pub fn looks_secret_like(s: &str) -> bool {
    SECRET_PATTERNS.iter().any(|p| s.contains(p))
}

/// Debug-build guard: panics when `s` looks like a credential. Call it on
/// identifiers and keys before they are written. Released builds do not
/// pay for it; the invariant is enforced by the fixtures and tests.
#[track_caller]
pub fn assert_no_secret_like(s: &str) {
    debug_assert!(
        !looks_secret_like(s),
        "core-store must never persist credential-like data"
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use contracts::{AccountId, Environment};

    #[test]
    fn dedup_key_contains_namespace_and_upstream_scope() {
        let ns = Namespace::new(Environment::named("test"), AccountId::new("acc_1"));
        assert_eq!(
            record_dedup_key(&ns, "g1", UpstreamScope::ServerMessage("m1")),
            "test/acc_1/g1#m:m1"
        );
        assert_eq!(
            record_dedup_key(&ns, "g1", UpstreamScope::LocalIntent("l9")),
            "test/acc_1/g1#l:l9"
        );
        let other = Namespace::new(Environment::named("test"), AccountId::new("acc_2"));
        assert_ne!(
            record_dedup_key(&ns, "g1", UpstreamScope::ServerMessage("m1")),
            record_dedup_key(&other, "g1", UpstreamScope::ServerMessage("m1"))
        );
    }

    #[test]
    fn secret_like_detection() {
        assert!(looks_secret_like("bticket=PLACEHOLDER"));
        assert!(looks_secret_like("vbkticket=PLACEHOLDER"));
        assert!(looks_secret_like("Cookie: a=b"));
        assert!(!looks_secret_like("gid-123"));
        assert_no_secret_like("round-1");
    }

    #[test]
    #[should_panic(expected = "credential-like")]
    fn assert_rejects_ticket() {
        assert_no_secret_like("x; bticket=PLACEHOLDER");
    }
}

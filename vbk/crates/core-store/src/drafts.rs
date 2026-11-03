//! Draft book: the whole-account view the host's `im_draft_load` /
//! `im_draft_save` commands expose (plan I-09 / D10 "重启恢复").
//!
//! Contract (mirrors `ui/apps/main/draft-book.ts` `createIpcDraftPort`):
//!
//! * `load(ns)` → every stored draft of the namespace `(gid, text, version)`.
//! * `save(ns, gid, text, expected_version)` → the new version. Versions
//!   start at 0 (no draft), the first save returns 1, every later save
//!   `expected_version + 1`. Empty `text` deletes the draft and returns 0,
//!   so the next save of that conversation expects 0 again.
//! * A caller whose `expected_version` is not the stored version gets
//!   `store.cas_conflict` and nothing is written.
//!
//! The namespace document is shared with other collections (reminder
//! rounds, send intents …). A commit that lands between `begin` and `commit`
//! of a draft save makes the store report `store.cas_conflict` even when the
//! draft itself is untouched; the book re-reads the draft version and retries
//! a bounded number of times, so the caller only ever sees a conflict that is
//! really about *its* draft.
//!
//! Each `save` is one synchronous `Store::commit` (`FileStore` fsyncs). The
//! host must call it without holding its `Cores` lock
//! (`lock_order`: `DiskSync` is forbidden under `Cores`).

use contracts::AppError;

use crate::error::codes;
use crate::repo::draft::{DraftRecord, DraftRepo};
use crate::store::{Namespace, Store};

/// Attempts per `save` when the namespace revision moved under us.
const MAX_ATTEMPTS: u32 = 4;

#[derive(Debug, Clone, Copy)]
pub struct DraftBook;

impl DraftBook {
    /// Every draft of the namespace, sorted by gid.
    pub fn load(store: &dyn Store, ns: &Namespace) -> Result<Vec<DraftRecord>, AppError> {
        DraftRepo::load_all(store, ns)
    }

    /// CAS save (empty `text` = delete). Returns the stored version after
    /// the write: `expected_version + 1`, or 0 after a delete.
    pub fn save(
        store: &dyn Store,
        ns: &Namespace,
        gid: &str,
        text: &str,
        expected_version: u64,
    ) -> Result<u64, AppError> {
        crate::assert_no_secret_like(gid);
        let delete = text.is_empty();
        if delete && expected_version == 0 && DraftRepo::version(store, ns, gid)? == 0 {
            // Nothing stored, nothing to clear: no commit, no fsync.
            return Ok(0);
        }
        let mut attempt = 0;
        loop {
            attempt += 1;
            let mut txn = store.begin(ns)?;
            let version = if delete {
                DraftRepo::delete_draft(store, &mut txn, gid, expected_version)?;
                0
            } else {
                DraftRepo::save_draft(store, &mut txn, gid, text, expected_version)?
            };
            match store.commit(txn) {
                Ok(_) => return Ok(version),
                Err(e) if e.is(codes::STORE_CAS_CONFLICT) => {
                    // Namespace moved, or the draft itself moved: only the
                    // latter is the caller's conflict.
                    if DraftRepo::version(store, ns, gid)? != expected_version
                        || attempt >= MAX_ATTEMPTS
                    {
                        return Err(e);
                    }
                }
                Err(e) => return Err(e),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    use contracts::json::JsonValue;
    use contracts::{AccountId, Environment};

    use super::*;
    use crate::file::FileStore;
    use crate::memory::MemoryStore;
    use crate::store::{CommitFact, Txn};

    fn ns(acc: &str) -> Namespace {
        Namespace::new(Environment::named("prod"), AccountId::new(acc))
    }

    fn texts(store: &dyn Store, ns: &Namespace) -> Vec<(String, String, u64)> {
        DraftBook::load(store, ns)
            .expect("load")
            .into_iter()
            .map(|d| (d.gid, d.text, d.version))
            .collect()
    }

    #[test]
    fn first_save_is_version_one_and_versions_increment() {
        let store = MemoryStore::new();
        let a = ns("agent-A");
        assert!(texts(&store, &a).is_empty());
        assert_eq!(
            DraftBook::save(&store, &a, "1001", "hel", 0).expect("v1"),
            1
        );
        assert_eq!(
            DraftBook::save(&store, &a, "1001", "hello", 1).expect("v2"),
            2
        );
        assert_eq!(
            DraftBook::save(&store, &a, "1002", "other", 0).expect("v1"),
            1
        );
        assert_eq!(
            texts(&store, &a),
            vec![
                ("1001".into(), "hello".into(), 2),
                ("1002".into(), "other".into(), 1)
            ]
        );
    }

    #[test]
    fn stale_expected_version_is_a_cas_conflict_and_writes_nothing() {
        let store = MemoryStore::new();
        let a = ns("agent-A");
        DraftBook::save(&store, &a, "1001", "newer input", 0).expect("v1");
        let e = DraftBook::save(&store, &a, "1001", "late translation", 0).expect_err("stale");
        assert!(e.is(codes::STORE_CAS_CONFLICT));
        let e = DraftBook::save(&store, &a, "1001", "from the future", 5).expect_err("ahead");
        assert!(e.is(codes::STORE_CAS_CONFLICT));
        // A stale delete is refused too.
        let e = DraftBook::save(&store, &a, "1001", "", 0).expect_err("stale clear");
        assert!(e.is(codes::STORE_CAS_CONFLICT));
        assert_eq!(
            texts(&store, &a),
            vec![("1001".into(), "newer input".into(), 1)]
        );
    }

    #[test]
    fn empty_text_deletes_and_resets_the_version_to_zero() {
        let store = MemoryStore::new();
        let a = ns("agent-A");
        DraftBook::save(&store, &a, "1001", "x", 0).expect("v1");
        DraftBook::save(&store, &a, "1002", "keep", 0).expect("v1");
        assert_eq!(
            DraftBook::save(&store, &a, "1001", "", 1).expect("delete"),
            0
        );
        assert_eq!(texts(&store, &a), vec![("1002".into(), "keep".into(), 1)]);
        // After a delete the conversation starts over at 0 …
        assert_eq!(
            DraftBook::save(&store, &a, "1001", "again", 0).expect("v1"),
            1
        );
        // … and clearing what is not there is a no-op, not a conflict.
        let before = store.last_commit(&a).expect("fact");
        assert_eq!(DraftBook::save(&store, &a, "9999", "", 0).expect("noop"), 0);
        assert_eq!(store.last_commit(&a).expect("fact"), before);
    }

    #[test]
    fn drafts_never_leak_across_namespaces() {
        let store = MemoryStore::new();
        let a = ns("agent-A");
        let b = ns("agent-B");
        let a_uat = Namespace::new(Environment::named("uat"), AccountId::new("agent-A"));
        DraftBook::save(&store, &a, "1001", "for A", 0).expect("a");
        DraftBook::save(&store, &b, "1001", "for B", 0).expect("b");
        assert_eq!(texts(&store, &a), vec![("1001".into(), "for A".into(), 1)]);
        assert_eq!(texts(&store, &b), vec![("1001".into(), "for B".into(), 1)]);
        assert!(texts(&store, &a_uat).is_empty());
        // B's version does not count against A's CAS.
        assert_eq!(
            DraftBook::save(&store, &a, "1001", "A again", 1).expect("a2"),
            2
        );
        assert_eq!(texts(&store, &b), vec![("1001".into(), "for B".into(), 1)]);
    }

    static DIR_SEQ: AtomicU64 = AtomicU64::new(1);

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "core-store-drafts-{}-{}",
                std::process::id(),
                DIR_SEQ.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("temp dir");
            Self(dir)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn drafts_survive_a_restart_on_the_file_store() {
        let dir = TempDir::new();
        let a = ns("agent-A");
        {
            let store = FileStore::open(&dir.0).expect("open");
            DraftBook::save(&store, &a, "1001", "before restart", 0).expect("v1");
            DraftBook::save(&store, &a, "1001", "before restart, edited", 1).expect("v2");
            DraftBook::save(&store, &a, "1002", "gone", 0).expect("v1");
            DraftBook::save(&store, &a, "1002", "", 1).expect("deleted");
        }
        let store = FileStore::open(&dir.0).expect("reopen");
        assert_eq!(
            texts(&store, &a),
            vec![("1001".into(), "before restart, edited".into(), 2)]
        );
        // The version read back is the one the next writer must present.
        assert_eq!(
            DraftBook::save(&store, &a, "1001", "after restart", 2).expect("v3"),
            3
        );
        assert!(DraftBook::save(&store, &a, "1001", "stale", 1)
            .expect_err("stale")
            .is(codes::STORE_CAS_CONFLICT));
    }

    /// A store whose first commit is preceded by a foreign commit to the
    /// same namespace (another collection), as the reminder persistence
    /// thread would do.
    struct Interleaving<'a> {
        inner: &'a MemoryStore,
        foreign_commits_left: Cell<u32>,
    }

    impl Store for Interleaving<'_> {
        fn begin(&self, ns: &Namespace) -> Result<Txn, AppError> {
            self.inner.begin(ns)
        }
        fn commit(&self, txn: Txn) -> Result<CommitFact, AppError> {
            let left = self.foreign_commits_left.get();
            if left > 0 {
                self.foreign_commits_left.set(left - 1);
                let mut other = self.inner.begin(txn.namespace())?;
                other.put("rounds", "r1", JsonValue::string("foreign"));
                self.inner.commit(other)?;
            }
            self.inner.commit(txn)
        }
        fn get(
            &self,
            ns: &Namespace,
            collection: &str,
            key: &str,
        ) -> Result<Option<JsonValue>, AppError> {
            self.inner.get(ns, collection, key)
        }
        fn list(
            &self,
            ns: &Namespace,
            collection: &str,
        ) -> Result<Vec<(String, JsonValue)>, AppError> {
            self.inner.list(ns, collection)
        }
        fn last_commit(&self, ns: &Namespace) -> Result<Option<CommitFact>, AppError> {
            self.inner.last_commit(ns)
        }
        fn logout_lock(&self, ns: &Namespace) -> Result<(), AppError> {
            self.inner.logout_lock(ns)
        }
        fn unlock_after_reauth(&self, ns: &Namespace) -> Result<(), AppError> {
            self.inner.unlock_after_reauth(ns)
        }
        fn is_locked(&self, ns: &Namespace) -> Result<bool, AppError> {
            self.inner.is_locked(ns)
        }
    }

    #[test]
    fn a_foreign_commit_to_the_namespace_is_retried_not_reported() {
        let inner = MemoryStore::new();
        let a = ns("agent-A");
        let store = Interleaving {
            inner: &inner,
            foreign_commits_left: Cell::new(2),
        };
        assert_eq!(
            DraftBook::save(&store, &a, "1001", "typed", 0).expect("v1"),
            1
        );
        assert_eq!(store.foreign_commits_left.get(), 0);
        assert_eq!(texts(&inner, &a), vec![("1001".into(), "typed".into(), 1)]);
        assert_eq!(
            inner.get(&a, "rounds", "r1").expect("get"),
            Some(JsonValue::string("foreign"))
        );
    }

    #[test]
    fn an_endless_foreign_writer_eventually_surfaces_the_conflict() {
        let inner = MemoryStore::new();
        let a = ns("agent-A");
        let store = Interleaving {
            inner: &inner,
            foreign_commits_left: Cell::new(u32::MAX),
        };
        let e = DraftBook::save(&store, &a, "1001", "typed", 0).expect_err("gives up");
        assert!(e.is(codes::STORE_CAS_CONFLICT));
        assert_eq!(u32::MAX - store.foreign_commits_left.get(), MAX_ATTEMPTS);
        assert!(texts(&inner, &a).is_empty());
    }

    #[test]
    fn a_logout_locked_namespace_refuses_writes_but_still_loads() {
        let store = MemoryStore::new();
        let a = ns("agent-A");
        DraftBook::save(&store, &a, "1001", "kept", 0).expect("v1");
        store.logout_lock(&a).expect("lock");
        assert!(DraftBook::save(&store, &a, "1001", "more", 1)
            .expect_err("locked")
            .is(codes::STORE_LOCKED));
        assert_eq!(texts(&store, &a), vec![("1001".into(), "kept".into(), 1)]);
    }
}

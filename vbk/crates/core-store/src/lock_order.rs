//! Host lock order and a deadlock check that does not need the host (I-04b).
//!
//! The Tauri host cannot be compiled in every environment, so the *policy*
//! lives here as pure, tested code and the host adopts it.
//!
//! # Policy
//!
//! 1. **Total order.** Locks have a fixed [`LockId::rank`]. A thread may
//!    acquire a lock only if every lock it already holds has a **strictly
//!    lower** rank (this also forbids re-entrancy). With a total order, two
//!    threads can never wait for each other in a cycle.
//!
//!    | rank | lock | where |
//!    | ---- | ---- | ----- |
//!    | 10 | [`LockId::Login`] | `login.rs` `LoginState.inner` |
//!    | 20 | [`LockId::Cores`] | `state.rs` `HostState.cores` (includes the `PersistTracker`) |
//!    | 30 | [`LockId::Prefs`] | `prefs.rs` `Inner` and `pending` |
//!    | 40 | [`LockId::AdapterTables`] | `adapter.rs` display / pending / pinned / focus / receive |
//!    | 50 | [`LockId::Journals`] | outbound / peripheral journals |
//!    | 60 | [`LockId::Peripheral`] | clock anchors, shell attachments |
//!    | 70 | [`LockId::StoreCommit`] | `FileStore` per-namespace commit lock |
//!    | 80 | [`LockId::QueueInternal`] | `PersistQueue` receipt channel |
//!
//! 2. **No blocking work under a state lock.** [`BlockingOp::DiskSync`]
//!    (any `fsync`/`write_atomic`) is forbidden while holding `Login`,
//!    `Cores`, or `AdapterTables`; the journals, `Prefs`, and the store's own
//!    commit lock exist *to* serialise IO and are exempt. [`BlockingOp::Emit`]
//!    (a Tauri event emit, which can re-enter a command) is forbidden under
//!    **every** lock: snapshot under the lock, `drop`, then emit.
//!
//! 3. `Cores` is held only for in-memory work. Persistence is a snapshot
//!    taken under `Cores`, then `drop(cores)`, then a non-blocking enqueue on
//!    the `vbk-persist` thread ([`crate::queue`]).
//!
//! The ranks are a *declared* policy: the pure checker below is tested, but
//! every call site in the host still has to be audited against it.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum LockId {
    Login,
    Cores,
    Prefs,
    AdapterTables,
    Journals,
    Peripheral,
    StoreCommit,
    QueueInternal,
}

impl LockId {
    pub const ALL: [LockId; 8] = [
        LockId::Login,
        LockId::Cores,
        LockId::Prefs,
        LockId::AdapterTables,
        LockId::Journals,
        LockId::Peripheral,
        LockId::StoreCommit,
        LockId::QueueInternal,
    ];

    pub fn rank(self) -> u8 {
        match self {
            LockId::Login => 10,
            LockId::Cores => 20,
            LockId::Prefs => 30,
            LockId::AdapterTables => 40,
            LockId::Journals => 50,
            LockId::Peripheral => 60,
            LockId::StoreCommit => 70,
            LockId::QueueInternal => 80,
        }
    }

    /// May a thread holding this lock perform `op`?
    pub fn allows(self, op: BlockingOp) -> bool {
        match op {
            BlockingOp::Emit => false,
            BlockingOp::DiskSync => {
                !matches!(self, LockId::Login | LockId::Cores | LockId::AdapterTables)
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockingOp {
    /// `fsync`, `write_atomic`, `FileStore::commit`.
    DiskSync,
    /// Emitting a Tauri event / calling into a webview.
    Emit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Violation {
    /// Acquiring `acquiring` while holding an equal-or-higher-ranked lock.
    Order { held: LockId, acquiring: LockId },
    /// Blocking operation while holding a lock that forbids it.
    Blocking { held: LockId, op: BlockingOp },
}

/// Pure check: may a thread that holds `held` (any order) acquire `next`?
pub fn check_acquire(held: &[LockId], next: LockId) -> Result<(), Violation> {
    match held.iter().find(|h| h.rank() >= next.rank()) {
        Some(&h) => Err(Violation::Order {
            held: h,
            acquiring: next,
        }),
        None => Ok(()),
    }
}

/// Pure check: may a thread that holds `held` perform `op`?
pub fn check_blocking(held: &[LockId], op: BlockingOp) -> Result<(), Violation> {
    match held.iter().find(|h| !h.allows(op)) {
        Some(&h) => Err(Violation::Blocking { held: h, op }),
        None => Ok(()),
    }
}

thread_local! {
    static HELD: RefCell<Vec<LockId>> = const { RefCell::new(Vec::new()) };
}

/// Locks currently registered on this thread.
pub fn held_now() -> Vec<LockId> {
    HELD.with(|h| h.borrow().clone())
}

/// RAII registration of a held lock on the current thread. Create it right
/// after the real guard; drop it right before (or with) the real guard.
#[derive(Debug)]
pub struct HeldToken {
    id: LockId,
}

/// Registers `id` as held by this thread, or reports the violation (nothing
/// is registered then). Intended for `debug_assertions` builds of the host.
pub fn enter(id: LockId) -> Result<HeldToken, Violation> {
    HELD.with(|h| {
        let mut h = h.borrow_mut();
        check_acquire(&h, id)?;
        h.push(id);
        Ok(HeldToken { id })
    })
}

impl Drop for HeldToken {
    fn drop(&mut self) {
        HELD.with(|h| {
            let mut h = h.borrow_mut();
            if let Some(pos) = h.iter().rposition(|x| *x == self.id) {
                h.remove(pos);
            }
        });
    }
}

/// Asserts that this thread may perform `op` with the locks it holds.
pub fn assert_may_block(op: BlockingOp) -> Result<(), Violation> {
    HELD.with(|h| check_blocking(&h.borrow(), op))
}

/// Records "held X while acquiring Y" edges observed across threads and
/// reports a cycle, which is what a deadlock needs. Used by tests and by
/// debug builds that want a cross-thread view the per-thread rank check
/// cannot give (it only catches order violations against the declared
/// ranks, this catches any inconsistency among observed orders).
#[derive(Debug, Default)]
pub struct AcquisitionGraph {
    edges: BTreeMap<LockId, BTreeSet<LockId>>,
}

impl AcquisitionGraph {
    pub fn new() -> Self {
        Self::default()
    }

    /// A thread holding `held` acquired `next`.
    pub fn record(&mut self, held: &[LockId], next: LockId) {
        for &h in held {
            self.edges.entry(h).or_default().insert(next);
        }
    }

    /// A lock order cycle, if any (first lock repeated at the end).
    pub fn find_cycle(&self) -> Option<Vec<LockId>> {
        fn visit(
            g: &AcquisitionGraph,
            node: LockId,
            path: &mut Vec<LockId>,
            done: &mut BTreeSet<LockId>,
        ) -> Option<Vec<LockId>> {
            if let Some(pos) = path.iter().position(|n| *n == node) {
                let mut cycle = path[pos..].to_vec();
                cycle.push(node);
                return Some(cycle);
            }
            if done.contains(&node) {
                return None;
            }
            path.push(node);
            if let Some(next) = g.edges.get(&node) {
                for &n in next {
                    if let Some(c) = visit(g, n, path, done) {
                        return Some(c);
                    }
                }
            }
            path.pop();
            done.insert(node);
            None
        }
        let mut done = BTreeSet::new();
        for &start in self.edges.keys() {
            if let Some(c) = visit(self, start, &mut Vec::new(), &mut done) {
                return Some(c);
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn ranks_are_unique_and_all_covers_every_lock() {
        let ranks: BTreeSet<u8> = LockId::ALL.iter().map(|l| l.rank()).collect();
        assert_eq!(ranks.len(), LockId::ALL.len());
        let mut sorted = LockId::ALL.to_vec();
        sorted.sort_by_key(|l| l.rank());
        assert_eq!(sorted, LockId::ALL.to_vec(), "ALL is listed in rank order");
    }

    #[test]
    fn any_two_locks_have_exactly_one_legal_order() {
        for &a in &LockId::ALL {
            for &b in &LockId::ALL {
                let ab = check_acquire(&[a], b).is_ok();
                let ba = check_acquire(&[b], a).is_ok();
                if a == b {
                    assert!(!ab, "re-entrancy of {a:?} must be rejected");
                } else {
                    assert!(ab ^ ba, "{a:?}/{b:?}: exactly one order is legal");
                }
            }
        }
    }

    #[test]
    fn full_chain_is_legal_and_inversion_is_reported() {
        assert!(check_acquire(&[LockId::Login, LockId::Cores], LockId::StoreCommit).is_ok());
        assert_eq!(
            check_acquire(&[LockId::StoreCommit], LockId::Cores),
            Err(Violation::Order {
                held: LockId::StoreCommit,
                acquiring: LockId::Cores
            })
        );
    }

    #[test]
    fn cores_never_holds_disk_or_emit() {
        assert_eq!(
            check_blocking(&[LockId::Cores], BlockingOp::DiskSync),
            Err(Violation::Blocking {
                held: LockId::Cores,
                op: BlockingOp::DiskSync
            })
        );
        for &l in &LockId::ALL {
            assert!(
                check_blocking(&[l], BlockingOp::Emit).is_err(),
                "{l:?} must not emit"
            );
        }
        // Serialising locks exist to do IO.
        assert!(check_blocking(&[LockId::Journals], BlockingOp::DiskSync).is_ok());
        assert!(check_blocking(&[LockId::StoreCommit], BlockingOp::DiskSync).is_ok());
        assert!(check_blocking(&[], BlockingOp::Emit).is_ok());
    }

    #[test]
    fn thread_local_tracking_enforces_order_and_releases() {
        let cores = enter(LockId::Cores).unwrap();
        assert_eq!(held_now(), vec![LockId::Cores]);
        assert!(assert_may_block(BlockingOp::DiskSync).is_err());
        assert!(enter(LockId::Login).is_err(), "inversion rejected");
        assert_eq!(
            held_now(),
            vec![LockId::Cores],
            "rejected enter registers nothing"
        );
        let prefs = enter(LockId::Prefs).unwrap();
        drop(cores);
        assert_eq!(held_now(), vec![LockId::Prefs]);
        drop(prefs);
        assert!(held_now().is_empty());
        assert!(assert_may_block(BlockingOp::DiskSync).is_ok());
    }

    #[test]
    fn graph_detects_the_classic_ab_ba_deadlock() {
        let mut g = AcquisitionGraph::new();
        g.record(&[LockId::Cores], LockId::Prefs); // thread 1
        assert!(g.find_cycle().is_none());
        g.record(&[LockId::Prefs], LockId::Cores); // thread 2
        let cycle = g.find_cycle().expect("cycle");
        assert_eq!(cycle.first(), cycle.last());
        assert!(cycle.contains(&LockId::Cores) && cycle.contains(&LockId::Prefs));
    }

    #[test]
    fn graph_of_every_policy_conforming_schedule_is_acyclic() {
        // Every subset of locks acquired in rank order, as many threads would.
        let mut g = AcquisitionGraph::new();
        for mask in 0u32..(1 << LockId::ALL.len()) {
            let mut held: Vec<LockId> = Vec::new();
            for (i, &l) in LockId::ALL.iter().enumerate() {
                if mask & (1 << i) != 0 {
                    assert!(check_acquire(&held, l).is_ok());
                    g.record(&held, l);
                    held.push(l);
                }
            }
        }
        assert_eq!(g.find_cycle(), None);
    }

    #[test]
    fn real_threads_following_the_order_do_not_deadlock() {
        let cores = Arc::new(Mutex::new(0u32));
        let prefs = Arc::new(Mutex::new(0u32));
        let workers: Vec<_> = (0..4)
            .map(|_| {
                let (c, p) = (Arc::clone(&cores), Arc::clone(&prefs));
                std::thread::spawn(move || {
                    for _ in 0..2000 {
                        let t1 = enter(LockId::Cores).unwrap();
                        let mut c = c.lock().unwrap();
                        let t2 = enter(LockId::Prefs).unwrap();
                        let mut p = p.lock().unwrap();
                        *c += 1;
                        *p += 1;
                        drop(p);
                        drop(t2);
                        drop(c);
                        drop(t1);
                    }
                })
            })
            .collect();
        for w in workers {
            w.join().unwrap();
        }
        assert_eq!(*cores.lock().unwrap(), 8000);
    }
}

//! Test instrumentation for the durable write path (I-04a / I-25).
//!
//! Two independent facilities, both scoped to a **directory prefix** so that
//! parallel tests (each with its own temp root) never see each other:
//!
//! * [`FsyncProbe`] records every `fsync` that `file.rs` performs under the
//!   prefix together with the **thread name** that issued it. The host uses
//!   it to assert "zero fsyncs on the main thread while the Cores lock is
//!   held" and "every commit happens on `vbk-persist`".
//! * [`inject`] arms a **fail point** (before create / write / `sync_all` /
//!   `rename` / directory sync) with an action: a simulated process death
//!   ([`FaultAction::Crash`], leaves the temp file behind exactly as a dead
//!   process would), a real `abort()` ([`FaultAction::Abort`], for
//!   sub-process tests), or an injected IO error ([`FaultAction::Io`]) for
//!   fault model B (`ENOSPC` / `EACCES` / `EROFS`).
//!
//! Cost when nothing is armed: one relaxed atomic load per fail point.
//! Nothing here can be armed from outside the process; production code never
//! calls [`inject`] or [`FsyncProbe::start`].

use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

/// Where in `write_atomic` a fault can be armed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailPoint {
    /// Before the temp file is created (directory unwritable, `EACCES`).
    BeforeCreate,
    /// Before `write_all` (disk full, `ENOSPC`).
    BeforeWrite,
    /// After `write_all`, before `sync_all` (model A point 1).
    BeforeSyncAll,
    /// After `sync_all`, before `rename` (model A point 2).
    BeforeRename,
    /// After `rename`, before the directory `fsync` (model A point 3).
    BeforeSyncDir,
}

impl FailPoint {
    /// The three model-A points named by the plan.
    pub const MODEL_A: [FailPoint; 3] = [
        FailPoint::BeforeSyncAll,
        FailPoint::BeforeRename,
        FailPoint::BeforeSyncDir,
    ];
}

/// What an armed fail point does when reached.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FaultAction {
    /// Stop the write right here and skip all cleanup, as a killed process
    /// would. The caller sees an error (the "process" is alive only because
    /// the test needs it to be).
    Crash,
    /// `std::process::abort()`: for tests that run the writer in a child
    /// process and then reopen the store in the parent.
    Abort,
    /// Return an IO error with this kind (`label` names the errno it stands
    /// for, e.g. `"ENOSPC"`).
    Io(io::ErrorKind, &'static str),
}

/// Marker payload of the error produced by [`FaultAction::Crash`].
#[derive(Debug)]
pub struct InjectedCrash;

impl std::fmt::Display for InjectedCrash {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("injected process termination")
    }
}

impl std::error::Error for InjectedCrash {}

/// True when `e` came from [`FaultAction::Crash`].
pub fn is_injected_crash(e: &io::Error) -> bool {
    e.get_ref().is_some_and(|inner| inner.is::<InjectedCrash>())
}

/// Kind of a recorded `fsync`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FsyncKind {
    File,
    Directory,
}

/// One recorded `fsync`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FsyncEvent {
    /// `std::thread::current().name()`, `"<unnamed>"` when unnamed.
    pub thread: String,
    pub kind: FsyncKind,
    pub path: PathBuf,
}

struct FaultEntry {
    id: usize,
    prefix: PathBuf,
    point: FailPoint,
    action: FaultAction,
    /// Matching hits to let through before firing.
    skip: usize,
    /// Remaining firings (`None` = unlimited).
    remaining: Option<usize>,
}

struct ProbeEntry {
    id: usize,
    prefix: PathBuf,
    events: Arc<Mutex<Vec<FsyncEvent>>>,
}

#[derive(Default)]
struct Registry {
    next_id: usize,
    faults: Vec<FaultEntry>,
    probes: Vec<ProbeEntry>,
}

static ACTIVE: AtomicUsize = AtomicUsize::new(0);
static REGISTRY: Mutex<Registry> = Mutex::new(Registry {
    next_id: 1,
    faults: Vec::new(),
    probes: Vec::new(),
});

fn registry() -> MutexGuard<'static, Registry> {
    REGISTRY.lock().unwrap_or_else(|p| p.into_inner())
}

/// RAII handle of an armed fault; dropping it disarms the fault.
#[derive(Debug)]
pub struct FaultGuard {
    id: usize,
}

impl FaultGuard {
    /// True while the fault has not yet used up its firings.
    pub fn is_armed(&self) -> bool {
        registry().faults.iter().any(|f| f.id == self.id)
    }
}

impl Drop for FaultGuard {
    fn drop(&mut self) {
        let mut reg = registry();
        let before = reg.faults.len();
        reg.faults.retain(|f| f.id != self.id);
        if reg.faults.len() != before {
            ACTIVE.fetch_sub(1, Ordering::Relaxed);
        }
    }
}

/// Arms `action` at `point` for writes whose directory is under `prefix`.
/// The first `skip` matching hits pass; then it fires `times` times
/// (`None` = until the guard is dropped).
pub fn inject(
    prefix: &Path,
    point: FailPoint,
    action: FaultAction,
    skip: usize,
    times: Option<usize>,
) -> FaultGuard {
    let mut reg = registry();
    let id = reg.next_id;
    reg.next_id += 1;
    reg.faults.push(FaultEntry {
        id,
        prefix: prefix.to_path_buf(),
        point,
        action,
        skip,
        remaining: times,
    });
    ACTIVE.fetch_add(1, Ordering::Relaxed);
    FaultGuard { id }
}

/// Records every `fsync` performed under a directory prefix while alive.
#[derive(Debug)]
pub struct FsyncProbe {
    id: usize,
    events: Arc<Mutex<Vec<FsyncEvent>>>,
}

impl FsyncProbe {
    pub fn start(prefix: &Path) -> Self {
        let mut reg = registry();
        let id = reg.next_id;
        reg.next_id += 1;
        let events = Arc::new(Mutex::new(Vec::new()));
        reg.probes.push(ProbeEntry {
            id,
            prefix: prefix.to_path_buf(),
            events: Arc::clone(&events),
        });
        ACTIVE.fetch_add(1, Ordering::Relaxed);
        Self { id, events }
    }

    pub fn events(&self) -> Vec<FsyncEvent> {
        self.events
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    pub fn count(&self) -> usize {
        self.events.lock().unwrap_or_else(|p| p.into_inner()).len()
    }

    /// Number of recorded fsyncs issued by a thread with this name.
    pub fn count_on_thread(&self, name: &str) -> usize {
        self.events().iter().filter(|e| e.thread == name).count()
    }

    /// Number of recorded fsyncs issued by any thread **other** than `name`.
    pub fn count_off_thread(&self, name: &str) -> usize {
        self.count() - self.count_on_thread(name)
    }

    pub fn clear(&self) {
        self.events
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
    }
}

impl Drop for FsyncProbe {
    fn drop(&mut self) {
        let mut reg = registry();
        let before = reg.probes.len();
        reg.probes.retain(|p| p.id != self.id);
        if reg.probes.len() != before {
            ACTIVE.fetch_sub(1, Ordering::Relaxed);
        }
    }
}

/// Called by `file.rs` for every `fsync`.
pub(crate) fn record_fsync(path: &Path, kind: FsyncKind) {
    if ACTIVE.load(Ordering::Relaxed) == 0 {
        return;
    }
    let reg = registry();
    for probe in reg.probes.iter().filter(|p| path.starts_with(&p.prefix)) {
        let thread = std::thread::current()
            .name()
            .unwrap_or("<unnamed>")
            .to_string();
        probe
            .events
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(FsyncEvent {
                thread,
                kind,
                path: path.to_path_buf(),
            });
    }
}

/// Called by `file.rs` at each fail point.
pub(crate) fn check(dir: &Path, point: FailPoint) -> io::Result<()> {
    if ACTIVE.load(Ordering::Relaxed) == 0 {
        return Ok(());
    }
    let action = {
        let mut reg = registry();
        let mut fired = None;
        let mut exhausted = None;
        for f in reg.faults.iter_mut() {
            if f.point != point || !dir.starts_with(&f.prefix) {
                continue;
            }
            if f.skip > 0 {
                f.skip -= 1;
                continue;
            }
            fired = Some(f.action);
            if let Some(n) = f.remaining.as_mut() {
                *n -= 1;
                if *n == 0 {
                    exhausted = Some(f.id);
                }
            }
            break;
        }
        if let Some(id) = exhausted {
            reg.faults.retain(|f| f.id != id);
            ACTIVE.fetch_sub(1, Ordering::Relaxed);
        }
        fired
    };
    match action {
        None => Ok(()),
        Some(FaultAction::Crash) => Err(io::Error::other(InjectedCrash)),
        Some(FaultAction::Abort) => std::process::abort(),
        Some(FaultAction::Io(kind, label)) => {
            Err(io::Error::new(kind, format!("injected {label}")))
        }
    }
}

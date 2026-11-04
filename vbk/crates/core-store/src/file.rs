//! `FileStore`: one directory per namespace under a root, one JSON document
//! per namespace written via temp file + rename.
//!
//! Layout:
//!
//! ```text
//! <root>/env/<environment>/acc/<account_id>/
//!   state.json                     the committed document
//!   state.json.tmp-<hex>           in-flight write (ignored / cleaned up)
//!   quarantine/state.json.corrupt-<unix_ms>
//!                                  quarantined document (never deleted here;
//!                                  files from older builds sit directly in
//!                                  the namespace directory and still count)
//!   corrupt.acknowledged           JSON array of quarantine file names the
//!                                  host has acknowledged
//!   logout.lock                    marker: namespace is read-only
//! ```
//!
//! Path segments are sanitized (only `[A-Za-z0-9._-]`; anything else is
//! percent-encoded) so an environment name can never escape the root.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use contracts::json::JsonValue;
use contracts::AppError;

use crate::error::{codes, err, io_err};
use crate::hooks::{self, FailPoint, FsyncKind};
use crate::schema::{self, SchemaError};
use crate::store::{now_ms, CommitFact, Namespace, NsState, Store, Txn};

const STATE_FILE: &str = "state.json";
const TMP_PREFIX: &str = "state.json.tmp-";
const CORRUPT_PREFIX: &str = "state.json.corrupt-";
const ACK_FILE: &str = "corrupt.acknowledged";
const LOCK_FILE: &str = "logout.lock";
const QUARANTINE_DIR: &str = "quarantine";
const TOO_NEW_MARK: &str = "schema_too_new:";

static TAG: AtomicU64 = AtomicU64::new(1 << 32);
static TMP_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Optional host-provided namespace filesystem capability. Core remains std-only;
/// hosts can bind every operation to no-follow OS directory handles without
/// changing the persisted layout or the transaction/retention semantics.
/// Implementations must reject untrusted derived directory redirections.
pub trait NamespaceIo: std::fmt::Debug + Send + Sync {
    fn directory(&self, path: &Path, create: bool) -> io::Result<Box<dyn NamespaceDirectory>>;
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()>;
}

/// An already-bound directory. All names are single path components, and
/// operations must remain bound to this directory even if its path is replaced.
pub trait NamespaceDirectory {
    fn open_file(&self, name: &str, writable: bool) -> io::Result<fs::File>;
    fn create_new(&self, name: &str) -> io::Result<fs::File>;
    fn rename(&self, from: &str, to: &str) -> io::Result<()>;
    fn remove(&self, name: &str) -> io::Result<()>;
    fn names(&self) -> io::Result<Vec<String>>;
    fn sync(&self) -> io::Result<()>;
}

#[derive(Debug)]
pub struct FileStore {
    tag: u64,
    root: PathBuf,
    namespace_io: Option<Arc<dyn NamespaceIo>>,
    /// In-process write lock per namespace: `commit` is load -> apply -> save
    /// and must not interleave with another commit of the same namespace.
    commit_locks: Mutex<BTreeMap<Namespace, Arc<Mutex<()>>>>,
}

impl FileStore {
    /// Opens (creates) a store rooted at `root`.
    pub fn open(root: impl Into<PathBuf>) -> Result<Self, AppError> {
        let root = root.into();
        create_durable_dir_all(&root).map_err(|e| io_err("create root", &e))?;
        Ok(Self {
            tag: TAG.fetch_add(1, Ordering::Relaxed),
            root,
            namespace_io: None,
            commit_locks: Mutex::new(BTreeMap::new()),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Configure before publishing the store. Root creation stays in `open`;
    /// every subsequent namespace access uses this capability provider.
    pub fn with_namespace_io(mut self, provider: Arc<dyn NamespaceIo>) -> Self {
        self.namespace_io = Some(provider);
        self
    }

    fn read_text(&self, path: &Path) -> io::Result<String> {
        if let Some(provider) = &self.namespace_io {
            use std::io::Read;
            let (dir, name) = split_file(path)?;
            let mut text = String::new();
            provider
                .directory(dir, false)?
                .open_file(name, false)?
                .read_to_string(&mut text)?;
            Ok(text)
        } else {
            fs::read_to_string(path)
        }
    }
    fn remove_file(&self, path: &Path) -> io::Result<()> {
        if let Some(provider) = &self.namespace_io {
            let (dir, name) = split_file(path)?;
            provider.directory(dir, false)?.remove(name)
        } else {
            fs::remove_file(path)
        }
    }
    fn list_prefixed(&self, dir: &Path, prefix: &str) -> Result<Vec<String>, AppError> {
        if let Some(provider) = &self.namespace_io {
            match provider.directory(dir, false).and_then(|dir| dir.names()) {
                Ok(names) => Ok(names
                    .into_iter()
                    .filter(|name| name.starts_with(prefix))
                    .collect()),
                Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
                Err(e) => Err(io_err("list namespace", &e)),
            }
        } else {
            list_prefixed(dir, prefix)
        }
    }
    fn sync_dir(&self, path: &Path) -> io::Result<()> {
        if let Some(provider) = &self.namespace_io {
            hooks::record_fsync(path, FsyncKind::Directory);
            provider.directory(path, false)?.sync()
        } else {
            sync_directory(path)
        }
    }
    fn write(&self, dir: &Path, name: &str, bytes: &[u8]) -> Result<(), AppError> {
        if let Some(provider) = &self.namespace_io {
            let capability = provider
                .directory(dir, true)
                .map_err(|e| io_err("bind namespace", &e))?;
            write_atomic_bound(capability.as_ref(), dir, name, bytes)
        } else {
            write_atomic(dir, name, bytes)
        }
    }

    /// Revalidates the committed file and its directory before a host admits
    /// an irreversible action or exposes a replayed terminal result. Creation
    /// of the root and every namespace ancestor is already synced, in order,
    /// by `open` / `write_atomic`; unrelated ancestors need no write access.
    /// Every open or sync failure is returned to the caller, never downgraded.
    pub fn sync_namespace(&self, ns: &Namespace) -> Result<(), AppError> {
        let dir = self.namespace_dir(ns);
        let mut options = fs::OpenOptions::new();
        options.read(true);
        // FlushFileBuffers requires GENERIC_WRITE even when no bytes change.
        #[cfg(windows)]
        options.write(true);
        let state_path = dir.join(STATE_FILE);
        hooks::record_fsync(&state_path, FsyncKind::File);
        if let Some(provider) = &self.namespace_io {
            let capability = provider
                .directory(&dir, false)
                .map_err(|e| io_err("bind namespace", &e))?;
            capability
                .open_file(STATE_FILE, true)
                .and_then(|file| file.sync_all())
                .map_err(|e| io_err("sync state", &e))?;
            hooks::record_fsync(&dir, FsyncKind::Directory);
            capability
                .sync()
                .map_err(|e| io_err("sync namespace dir", &e))
        } else {
            options
                .open(&state_path)
                .and_then(|file| file.sync_all())
                .map_err(|e| io_err("sync state", &e))?;
            sync_directory(&dir).map_err(|e| io_err("sync namespace dir", &e))
        }
    }

    /// Directory of a namespace (exists only after the first commit/lock).
    pub fn namespace_dir(&self, ns: &Namespace) -> PathBuf {
        self.root
            .join("env")
            .join(safe_segment(ns.environment.as_str()))
            .join("acc")
            .join(safe_segment(ns.account_id.as_str()))
    }

    /// Quarantined document files of a namespace, oldest first.
    pub fn quarantined_files(&self, ns: &Namespace) -> Result<Vec<PathBuf>, AppError> {
        let dir = self.namespace_dir(ns);
        let mut found: Vec<(String, PathBuf)> = Vec::new();
        for base in [dir.clone(), dir.join(QUARANTINE_DIR)] {
            for name in self.list_prefixed(&base, CORRUPT_PREFIX)? {
                let path = base.join(&name);
                found.push((name, path));
            }
        }
        found.sort();
        Ok(found.into_iter().map(|(_, p)| p).collect())
    }

    /// Marks every current quarantine file as acknowledged so the
    /// namespace becomes usable again (starting empty). The quarantined
    /// files themselves are kept as evidence.
    pub fn acknowledge_corruption(&self, ns: &Namespace) -> Result<Vec<PathBuf>, AppError> {
        let dir = self.namespace_dir(ns);
        let mut acked = self.acknowledged(&dir)?;
        let files = self.quarantined_files(ns)?;
        for f in &files {
            if let Some(name) = f.file_name().and_then(|n| n.to_str()) {
                acked.insert(name.to_string());
            }
        }
        let doc = JsonValue::Array(acked.iter().map(JsonValue::string).collect());
        self.write(&dir, ACK_FILE, doc.to_json().as_bytes())?;
        Ok(files)
    }

    fn acknowledged(&self, dir: &Path) -> Result<BTreeSet<String>, AppError> {
        match self.read_text(&dir.join(ACK_FILE)) {
            Ok(text) => Ok(JsonValue::parse(&text)
                .ok()
                .and_then(|v| v.as_array().cloned())
                .unwrap_or_default()
                .iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(BTreeSet::new()),
            Err(e) => Err(io_err("read ack", &e)),
        }
    }

    fn unacknowledged_quarantine(&self, ns: &Namespace) -> Result<Vec<String>, AppError> {
        let dir = self.namespace_dir(ns);
        let acked = self.acknowledged(&dir)?;
        Ok(self
            .quarantined_files(ns)?
            .iter()
            .filter_map(|p| p.file_name().and_then(|n| n.to_str()).map(str::to_string))
            .filter(|n| !acked.contains(n))
            .collect())
    }

    /// Loads the committed document. A decode / identity failure moves the
    /// file to `state.json.corrupt-<unix_ms>` and returns `store.corrupt`.
    fn load(&self, ns: &Namespace) -> Result<NsState, AppError> {
        let pending = self.unacknowledged_quarantine(ns)?;
        if !pending.is_empty() {
            return Err(err(
                codes::STORE_CORRUPT,
                "namespace has unacknowledged quarantined data",
            )
            .with_detail(pending.join(",")));
        }
        let dir = self.namespace_dir(ns);
        let path = dir.join(STATE_FILE);
        let text = match self.read_text(&path) {
            Ok(t) => t,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(NsState::default()),
            Err(e) => return Err(io_err("read state", &e)),
        };
        let decoded = JsonValue::parse(&text)
            .map_err(|e| e.to_string())
            .and_then(|doc| match schema::migrate_to_current(doc) {
                Ok(doc) => NsState::from_json(&doc, ns),
                Err(SchemaError::TooNew { found, supported }) => {
                    Err(format!("{TOO_NEW_MARK}{found}>{supported}"))
                }
                Err(SchemaError::Malformed(why)) => Err(why.to_string()),
            });
        match decoded {
            Ok(state) => Ok(state),
            // A newer build wrote this document. Never quarantine or rewrite
            // it: the file stays exactly as found.
            Err(reason) if reason.starts_with(TOO_NEW_MARK) => Err(err(
                codes::STORE_SCHEMA_TOO_NEW,
                "state document was written by a newer version; left untouched",
            )
            .with_detail(reason.trim_start_matches(TOO_NEW_MARK).to_string())),
            Err(reason) => {
                let qdir = dir.join(QUARANTINE_DIR);
                let quarantine = qdir.join(format!("{CORRUPT_PREFIX}{}", now_ms()));
                if let Some(provider) = &self.namespace_io {
                    provider
                        .rename(&path, &quarantine)
                        .map_err(|e| io_err("quarantine", &e))?;
                } else {
                    create_durable_dir_all(&qdir).map_err(|e| io_err("create quarantine", &e))?;
                    fs::rename(&path, &quarantine).map_err(|e| io_err("quarantine", &e))?;
                }
                self.sync_dir(&dir)
                    .map_err(|e| io_err("sync quarantine", &e))?;
                self.sync_dir(&qdir)
                    .map_err(|e| io_err("sync quarantine", &e))?;
                Err(err(
                    codes::STORE_CORRUPT,
                    "state document could not be decoded; quarantined",
                )
                .with_detail(format!(
                    "{reason}; file={}",
                    quarantine
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("?")
                )))
            }
        }
    }

    fn save(&self, ns: &Namespace, state: &NsState) -> Result<(), AppError> {
        let dir = self.namespace_dir(ns);
        self.write(&dir, STATE_FILE, state.to_json(ns).to_json().as_bytes())?;
        // Best effort: drop temp files left by an interrupted earlier write.
        for stale in self.list_prefixed(&dir, TMP_PREFIX)? {
            let _ = self.remove_file(&dir.join(stale));
        }
        Ok(())
    }

    fn commit_lock(&self, ns: &Namespace) -> Arc<Mutex<()>> {
        let mut map = self.commit_locks.lock().unwrap_or_else(|p| p.into_inner());
        Arc::clone(map.entry(ns.clone()).or_default())
    }

    fn lock_path(&self, ns: &Namespace) -> PathBuf {
        self.namespace_dir(ns).join(LOCK_FILE)
    }
}

impl Store for FileStore {
    fn begin(&self, ns: &Namespace) -> Result<Txn, AppError> {
        if self.is_locked(ns)? {
            return Err(err(codes::STORE_LOCKED, "namespace is logout-locked"));
        }
        let state = self.load(ns)?;
        Ok(Txn::new(ns.clone(), self.tag, state.revision))
    }

    fn commit(&self, txn: Txn) -> Result<CommitFact, AppError> {
        let base_revision = txn.base_revision();
        let (ns, writes, expectations) = txn.into_parts(self.tag)?;
        if self.is_locked(&ns)? {
            return Err(err(codes::STORE_LOCKED, "namespace is logout-locked"));
        }
        let lock = self.commit_lock(&ns);
        let _held = lock.lock().unwrap_or_else(|p| p.into_inner());
        let current = self.load(&ns)?;
        // The transaction was built on `base_revision`; if another commit
        // landed since, its reads are stale (I-25: no silent last-writer-wins).
        if current.revision != base_revision {
            return Err(err(
                codes::STORE_CAS_CONFLICT,
                "namespace changed since the transaction began",
            ));
        }
        let (next, fact) = current.apply(&writes, &expectations, now_ms())?;
        self.save(&ns, &next)?;
        Ok(fact)
    }

    fn get(
        &self,
        ns: &Namespace,
        collection: &str,
        key: &str,
    ) -> Result<Option<JsonValue>, AppError> {
        Ok(self.load(ns)?.get(collection, key).cloned())
    }

    fn list(&self, ns: &Namespace, collection: &str) -> Result<Vec<(String, JsonValue)>, AppError> {
        Ok(self.load(ns)?.list(collection))
    }

    fn last_commit(&self, ns: &Namespace) -> Result<Option<CommitFact>, AppError> {
        Ok(self.load(ns)?.last_commit())
    }

    fn logout_lock(&self, ns: &Namespace) -> Result<(), AppError> {
        let dir = self.namespace_dir(ns);
        self.write(&dir, LOCK_FILE, b"logout-locked\n")
    }

    fn unlock_after_reauth(&self, ns: &Namespace) -> Result<(), AppError> {
        match self.remove_file(&self.lock_path(ns)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(io_err("remove lock", &e)),
        }
    }

    fn is_locked(&self, ns: &Namespace) -> Result<bool, AppError> {
        if let Some(provider) = &self.namespace_io {
            let path = self.lock_path(ns);
            let (dir, name) = split_file(&path).map_err(|e| io_err("lock path", &e))?;
            match provider
                .directory(dir, false)
                .and_then(|dir| dir.open_file(name, false))
            {
                Ok(_) => Ok(true),
                Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
                Err(e) => Err(io_err("read lock", &e)),
            }
        } else {
            Ok(self.lock_path(ns).exists())
        }
    }
}

fn split_file(path: &Path) -> io::Result<(&Path, &str)> {
    path.parent()
        .zip(path.file_name().and_then(|name| name.to_str()))
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid namespace filename"))
}

/// Uses the same fault boundaries and durability probes as the default writer,
/// but all actual I/O stays on the capability acquired before the first write.
fn write_atomic_bound(
    dir: &dyn NamespaceDirectory,
    path: &Path,
    name: &str,
    bytes: &[u8],
) -> Result<(), AppError> {
    let temporary = format!(
        "{TMP_PREFIX}{:x}-{:x}",
        std::process::id(),
        TMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let result = (|| -> io::Result<()> {
        hooks::check(path, FailPoint::BeforeCreate)?;
        let mut file = dir.create_new(&temporary)?;
        hooks::check(path, FailPoint::BeforeWrite)?;
        file.write_all(bytes)?;
        hooks::check(path, FailPoint::BeforeSyncAll)?;
        hooks::record_fsync(&path.join(&temporary), FsyncKind::File);
        file.sync_all()?;
        drop(file);
        hooks::check(path, FailPoint::BeforeRename)?;
        dir.rename(&temporary, name)?;
        hooks::check(path, FailPoint::BeforeSyncDir)?;
        hooks::record_fsync(path, FsyncKind::Directory);
        dir.sync()
    })();
    if let Err(error) = result {
        if !hooks::is_injected_crash(&error) {
            let _ = dir.remove(&temporary);
        }
        return Err(io_err("atomic write", &error));
    }
    Ok(())
}

/// Writes `bytes` to `dir/name` through a temp file, `fsync`, rename and a
/// directory `fsync`. The public durable-write primitive of the workspace:
/// everything that must survive power loss (document, lock marker, index,
/// pin table, preferences) goes through it. A reader sees the old or the new
/// content, never a prefix.
pub fn write_atomic(dir: &Path, name: &str, bytes: &[u8]) -> Result<(), AppError> {
    create_durable_dir_all(dir).map_err(|e| io_err("create namespace dir", &e))?;
    let tmp = dir.join(format!(
        "{TMP_PREFIX}{:x}-{:x}",
        std::process::id(),
        TMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| -> io::Result<()> {
        hooks::check(dir, FailPoint::BeforeCreate)?;
        let mut f = fs::File::create(&tmp)?;
        hooks::check(dir, FailPoint::BeforeWrite)?;
        f.write_all(bytes)?;
        hooks::check(dir, FailPoint::BeforeSyncAll)?;
        hooks::record_fsync(&tmp, FsyncKind::File);
        f.sync_all()?;
        drop(f);
        hooks::check(dir, FailPoint::BeforeRename)?;
        fs::rename(&tmp, dir.join(name))?;
        hooks::check(dir, FailPoint::BeforeSyncDir)?;
        // Replacing the directory entry is part of the durable commit. If the
        // filesystem cannot flush it, no caller may infer durable success.
        sync_directory(dir)?;
        Ok(())
    })();
    if let Err(e) = result {
        // A simulated process death leaves the temp file behind, as a real
        // one would; every other failure cleans up.
        if !hooks::is_injected_crash(&e) {
            let _ = fs::remove_file(&tmp);
        }
        return Err(io_err("atomic write", &e));
    }
    Ok(())
}

fn sync_directory(dir: &Path) -> io::Result<()> {
    hooks::record_fsync(dir, FsyncKind::Directory);
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // CreateFile requires BACKUP_SEMANTICS for a directory handle;
        // FlushFileBuffers requires GENERIC_WRITE. No privilege is enabled.
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
        options.write(true).custom_flags(FILE_FLAG_BACKUP_SEMANTICS);
    }
    options.open(dir)?.sync_all()
}

/// Complete the nearest existing ancestor's barrier, then sync each newly
/// created directory and its parent before creating any deeper child. This
/// also closes a previous failed or concurrent creator's last unsynced entry.
/// Unrelated ancestors above the existing ancestor's parent are untouched.
fn create_durable_dir_all(dir: &Path) -> io::Result<()> {
    let absolute = if dir.is_absolute() {
        dir.to_path_buf()
    } else {
        std::env::current_dir()?.join(dir)
    };
    let mut missing = Vec::new();
    let mut cursor = absolute.as_path();
    loop {
        match fs::metadata(cursor) {
            Ok(metadata) if metadata.is_dir() => break,
            Ok(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "not a directory",
                ))
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                missing.push(cursor.to_path_buf());
                cursor = cursor.parent().ok_or(e)?;
            }
            Err(e) => return Err(e),
        }
    }
    // An existing directory may have been created by a previous failed or
    // concurrent opener that has not synced its link in its own parent yet.
    sync_directory(cursor)?;
    if let Some(parent) = cursor.parent() {
        sync_directory(parent)?;
    }
    for path in missing.into_iter().rev() {
        match fs::create_dir(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists && path.is_dir() => {}
            Err(e) => return Err(e),
        }
        sync_directory(&path)?;
        if let Some(parent) = path.parent() {
            sync_directory(parent)?;
        }
    }
    Ok(())
}

fn list_prefixed(dir: &Path, prefix: &str) -> Result<Vec<String>, AppError> {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(io_err("read namespace dir", &e)),
    };
    let mut out = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| io_err("read dir entry", &e))?;
        if let Some(name) = entry.file_name().to_str() {
            if name.starts_with(prefix) {
                out.push(name.to_string());
            }
        }
    }
    Ok(out)
}

fn safe_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_' | b'-' => out.push(b as char),
            b'.' if !out.is_empty() => out.push('.'),
            _ => out.push_str(&format!("%{b:02x}")),
        }
    }
    if out.is_empty() {
        out.push('_');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segments_cannot_escape_root() {
        assert_eq!(safe_segment("production"), "production");
        // A leading dot is encoded, so "." / ".." can never be produced.
        assert_eq!(safe_segment("../x"), "%2e.%2fx");
        assert_eq!(safe_segment(".."), "%2e.");
        assert_eq!(safe_segment("a/b\\c"), "a%2fb%5cc");
        assert_eq!(safe_segment(""), "_");
        assert_eq!(safe_segment(".hidden"), "%2ehidden");
    }
}

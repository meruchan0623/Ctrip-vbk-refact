//! `FileStore`: one directory per namespace under a root, one JSON document
//! per namespace written via temp file + rename.
//!
//! Layout:
//!
//! ```text
//! <root>/env/<environment>/acc/<account_id>/
//!   state.json                     the committed document
//!   state.json.tmp-<hex>           in-flight write (ignored / cleaned up)
//!   state.json.corrupt-<unix_ms>   quarantined document (never deleted here)
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
use std::sync::{Arc, Mutex, OnceLock, Weak};

use contracts::json::JsonValue;
use contracts::AppError;

use crate::error::{codes, err, io_err};
use crate::store::{now_ms, CommitFact, Namespace, NsState, Store, Txn};

const STATE_FILE: &str = "state.json";
const TMP_PREFIX: &str = "state.json.tmp-";
const CORRUPT_PREFIX: &str = "state.json.corrupt-";
const ACK_FILE: &str = "corrupt.acknowledged";
const LOCK_FILE: &str = "logout.lock";

static TAG: AtomicU64 = AtomicU64::new(1 << 32);
static TMP_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone)]
pub struct FileStore {
    tag: u64,
    root: PathBuf,
    writer: Arc<Mutex<()>>,
}

impl FileStore {
    /// Opens (creates) a store rooted at `root`.
    pub fn open(root: impl Into<PathBuf>) -> Result<Self, AppError> {
        let root = root.into();
        create_durable_dir_all(&root).map_err(|e| io_err("create root", &e))?;
        let canonical_root = fs::canonicalize(&root).map_err(|e| io_err("canonicalize root", &e))?;
        // Separate handles opened on the same root share the CAS critical section.
        static WRITERS: OnceLock<Mutex<BTreeMap<PathBuf, Weak<Mutex<()>>>>> = OnceLock::new();
        let mut writers = WRITERS.get_or_init(Mutex::default).lock().unwrap_or_else(|p| p.into_inner());
        writers.retain(|_, writer| writer.strong_count() > 0);
        let writer = writers.get(&canonical_root).and_then(Weak::upgrade).unwrap_or_else(|| {
            let writer = Arc::new(Mutex::new(()));
            writers.insert(canonical_root, Arc::downgrade(&writer));
            writer
        });
        Ok(Self {
            writer,
            tag: TAG.fetch_add(1, Ordering::Relaxed),
            root,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
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
        options
            .open(dir.join(STATE_FILE))
            .and_then(|file| file.sync_all())
            .map_err(|e| io_err("sync state", &e))?;
        sync_directory(&dir).map_err(|e| io_err("sync namespace dir", &e))
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
        let mut names = list_prefixed(&dir, CORRUPT_PREFIX)?;
        names.sort();
        Ok(names.into_iter().map(|n| dir.join(n)).collect())
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
        write_atomic(&dir.join(ACK_FILE), doc.to_json().as_bytes())?;
        Ok(files)
    }

    fn acknowledged(&self, dir: &Path) -> Result<BTreeSet<String>, AppError> {
        match fs::read_to_string(dir.join(ACK_FILE)) {
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
        Ok(list_prefixed(&dir, CORRUPT_PREFIX)?
            .into_iter()
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
        let text = match fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(NsState::default()),
            Err(e) => return Err(io_err("read state", &e)),
        };
        if let Ok(doc) = JsonValue::parse(&text) {
            if let Some(version) = doc.get("meta").and_then(|m| m.get("schema_version")) {
                match version.as_i64() {
                    Some(v) if v > 1 => return Err(err(codes::STORE_SCHEMA_NEWER,
                        "state document requires a newer application; original preserved")),
                    Some(0 | 1) => {},
                    _ => return Err(err(codes::STORE_CORRUPT, "invalid schema version; original preserved")),
                }
            }
        }
        // Missing schema_version is the embedded v0 -> v1 migration: records
        // have identical representation; the next commit writes the v1 header.
        let decoded = JsonValue::parse(&text)
            .map_err(|e| e.to_string())
            .and_then(|doc| NsState::from_json(&doc, ns));
        match decoded {
            Ok(state) => Ok(state),
            Err(reason) => {
                let quarantine = dir.join(format!("{CORRUPT_PREFIX}{}", now_ms()));
                fs::rename(&path, &quarantine).map_err(|e| io_err("quarantine", &e))?;
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
        write_atomic(&dir.join(STATE_FILE), state.to_json(ns).to_json().as_bytes())?;
        // Best effort: drop temp files left by an interrupted earlier write.
        for stale in list_prefixed(&dir, TMP_PREFIX)? {
            let _ = fs::remove_file(dir.join(stale));
        }
        Ok(())
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
        let (ns, base_revision, writes, expectations) = txn.into_parts(self.tag)?;
        let _writer = self.writer.lock().unwrap_or_else(|p| p.into_inner());
        if self.is_locked(&ns)? {
            return Err(err(codes::STORE_LOCKED, "namespace is logout-locked"));
        }
        let current = self.load(&ns)?;
        if current.revision != base_revision {
            return Err(err(codes::STORE_CAS_CONFLICT, "namespace revision changed"));
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
        let _writer = self.writer.lock().unwrap_or_else(|p| p.into_inner());
        let dir = self.namespace_dir(ns);
        write_atomic(&dir.join(LOCK_FILE), b"logout-locked\n")
    }

    fn unlock_after_reauth(&self, ns: &Namespace) -> Result<(), AppError> {
        match fs::remove_file(self.lock_path(ns)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(io_err("remove lock", &e)),
        }
    }

    fn is_locked(&self, ns: &Namespace) -> Result<bool, AppError> {
        Ok(self.lock_path(ns).exists())
    }
}

/// Writes `bytes` to `dir/name` through a temp file, fsync and rename.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    write_atomic_observed(path, bytes, &mut |_| Ok(()))
}

/// Observable boundaries for deterministic filesystem-error / termination tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AtomicWriteStage { BeforeFileSync, BeforeRename, BeforeDirectorySync }

/// The observer runs on the writing thread. Returning an error injects an IO
/// failure; a process-termination harness can terminate at the same boundary.
pub fn write_atomic_observed(
    path: &Path, bytes: &[u8], observer: &mut dyn FnMut(AtomicWriteStage) -> io::Result<()>,
) -> Result<(), AppError> {
    let dir = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."));
    create_durable_dir_all(dir).map_err(|e| io_err("create namespace dir", &e))?;
    let tmp = dir.join(format!(
        "{TMP_PREFIX}{:x}-{:x}",
        std::process::id(),
        TMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| -> io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        observer(AtomicWriteStage::BeforeFileSync)?;
        f.sync_all()?;
        drop(f);
        observer(AtomicWriteStage::BeforeRename)?;
        fs::rename(&tmp, path)?;
        // Replacing the directory entry is part of the durable commit. If the
        // filesystem cannot flush it, no caller may infer durable success.
        observer(AtomicWriteStage::BeforeDirectorySync)?;
        sync_directory(dir)?;
        Ok(())
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(io_err("atomic write", &e));
    }
    Ok(())
}

fn sync_directory(dir: &Path) -> io::Result<()> {
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

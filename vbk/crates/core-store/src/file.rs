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

use std::collections::BTreeSet;
use std::fs;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

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

#[derive(Debug)]
pub struct FileStore {
    tag: u64,
    root: PathBuf,
}

impl FileStore {
    /// Opens (creates) a store rooted at `root`.
    pub fn open(root: impl Into<PathBuf>) -> Result<Self, AppError> {
        let root = root.into();
        fs::create_dir_all(&root).map_err(|e| io_err("create root", &e))?;
        Ok(Self {
            tag: TAG.fetch_add(1, Ordering::Relaxed),
            root,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
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
        write_atomic(&dir, ACK_FILE, doc.to_json().as_bytes())?;
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
        write_atomic(&dir, STATE_FILE, state.to_json(ns).to_json().as_bytes())?;
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
        let (ns, writes, expectations) = txn.into_parts(self.tag)?;
        if self.is_locked(&ns)? {
            return Err(err(codes::STORE_LOCKED, "namespace is logout-locked"));
        }
        let current = self.load(&ns)?;
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
        write_atomic(&dir, LOCK_FILE, b"logout-locked\n")
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
fn write_atomic(dir: &Path, name: &str, bytes: &[u8]) -> Result<(), AppError> {
    fs::create_dir_all(dir).map_err(|e| io_err("create namespace dir", &e))?;
    let tmp = dir.join(format!(
        "{TMP_PREFIX}{:x}-{:x}",
        std::process::id(),
        TMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| -> io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, dir.join(name))?;
        // Directory fsync is best effort (not supported everywhere).
        if let Ok(d) = fs::File::open(dir) {
            let _ = d.sync_all();
        }
        Ok(())
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(io_err("atomic write", &e));
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

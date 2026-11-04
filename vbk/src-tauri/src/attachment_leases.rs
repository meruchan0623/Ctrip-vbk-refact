//! Durable, account-isolated unsent attachments and draft references. The
//! existing outbound FileStore and OS writer lock own every metadata change;
//! immutable blobs are durable before any transaction can reference them.
//! Persisted leases are data, never authority to upload or resend.
#[cfg(test)]
use std::fs;
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Read,
    sync::Arc,
};

use contracts::{json::JsonValue, AccountContext, AppError};
use core_store::{FileStore, Namespace, Store, Txn};
use serde::{Deserialize, Serialize};

use crate::{
    adapter::outbound_journal::OutboundJournal,
    media_outbound::{self, AttachmentDto, AttachmentOwner, FrozenAttachment, MediaTarget},
};

const LEASES: &str = "attachment_leases";
const DRAFTS: &str = "attachment_drafts";
const MIGRATIONS: &str = "attachment_migrations";
const MIGRATION: &str = "legacy_text_drafts_v1";
const MAX_LEASES: usize = 128;
const MAX_BYTES: usize = 256 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
struct Lease {
    schema: u8,
    created_ms: i64,
    lease_id: String,
    environment: String,
    account_id: String,
    gid: String,
    name: String,
    kind: String,
    mime: String,
    size: usize,
    content_sha256: String,
    draft_refs: BTreeSet<String>,
    outbox_refs: BTreeSet<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Draft {
    gid: String,
    text: String,
    version: u64,
    lease_ids: Vec<String>,
    attachment_version: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LeaseState {
    Ready,
    Pending,
    Missing,
    Corrupt,
}

#[derive(Clone, Debug, Serialize)]
pub struct LeaseView {
    pub lease_id: String,
    pub name: String,
    pub kind: String,
    pub mime: String,
    pub size: usize,
    pub content_sha256: String,
    pub state: LeaseState,
}

#[derive(Clone, Debug, Serialize)]
pub struct DurableDraft {
    pub gid: String,
    pub text: String,
    pub version: u64,
    pub attachments: Vec<LeaseView>,
    pub attachment_version: u64,
}

fn corrupt() -> AppError {
    AppError::new(
        "media.lease_corrupt",
        "attachment lease metadata is invalid",
    )
}
fn io_error() -> AppError {
    AppError::new(
        "media.lease_io",
        "attachment storage could not be read or written",
    )
}
fn cas() -> AppError {
    AppError::new(
        "store.cas_conflict",
        "draft version changed; reload before saving",
    )
}
fn encode(value: &impl Serialize) -> Result<JsonValue, AppError> {
    JsonValue::parse(&serde_json::to_string(value).map_err(|_| corrupt())?).map_err(|_| corrupt())
}
fn valid_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok()
}
fn decode_lease(value: &JsonValue, account: &AccountContext, id: &str) -> Result<Lease, AppError> {
    let lease: Lease = serde_json::from_str(&value.to_json()).map_err(|_| corrupt())?;
    if lease.schema != 1
        || lease.lease_id != id
        || !valid_id(id)
        || lease.environment != account.environment.as_str()
        || lease.account_id != account.account_id.as_str()
        || lease.gid.is_empty()
        || core_store::looks_secret_like(&lease.gid)
        || lease.name.is_empty()
        || lease.name.len() > 512
        || lease
            .name
            .chars()
            .any(|c| c.is_control() || c == '/' || c == '\\')
        || lease.content_sha256.len() != 64
        || !lease
            .content_sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || lease.draft_refs.iter().any(|gid| gid != &lease.gid)
        || lease
            .outbox_refs
            .iter()
            .any(|id| id.is_empty() || core_store::looks_secret_like(id))
    {
        return Err(corrupt());
    }
    media_outbound::check_size(&lease.kind, lease.size as u64).map_err(|_| corrupt())?;
    Ok(lease)
}
fn read_lease(
    store: &FileStore,
    account: &AccountContext,
    id: &str,
) -> Result<(JsonValue, Lease), AppError> {
    if !valid_id(id) {
        return Err(corrupt());
    }
    let raw = store
        .get(&Namespace::from_context(account), LEASES, id)?
        .ok_or_else(corrupt)?;
    let lease = decode_lease(&raw, account, id)?;
    Ok((raw, lease))
}
fn read_draft(
    store: &FileStore,
    ns: &Namespace,
    gid: &str,
) -> Result<(Option<JsonValue>, Option<Draft>), AppError> {
    let raw = store.get(ns, DRAFTS, gid)?;
    let draft = raw
        .as_ref()
        .map(|value| decode_draft(value, gid))
        .transpose()?;
    Ok((raw, draft))
}
fn decode_draft(value: &JsonValue, gid: &str) -> Result<Draft, AppError> {
    let draft: Draft = serde_json::from_str(&value.to_json()).map_err(|_| corrupt())?;
    let unique: BTreeSet<_> = draft.lease_ids.iter().collect();
    if draft.gid != gid
        || unique.len() != draft.lease_ids.len()
        || draft.lease_ids.len() > 1
        || draft.lease_ids.iter().any(|id| !valid_id(id))
    {
        return Err(corrupt());
    }
    Ok(draft)
}
fn blob_dir(store: &FileStore, ns: &Namespace) -> std::path::PathBuf {
    store.namespace_dir(ns).join("attachment-blobs")
}
/// Platform file handles keep blob operations inside the account directory.
/// Namespace components are opened without following symlinks/reparse points;
/// Unix operations are relative to the pinned directory fd. Windows handles
/// deny FILE_SHARE_DELETE so checked ancestors cannot be renamed underneath us.
mod blob_files {
    use core_store::{FileStore, Namespace};
    use std::path::Path;
    #[cfg(windows)]
    use std::{fs, path::PathBuf};
    use std::{
        fs::{File, OpenOptions},
        io::{self, Write},
    };

    pub(super) struct Directory {
        #[cfg(unix)]
        file: File,
        #[cfg(windows)]
        path: PathBuf,
        #[cfg(windows)]
        _guards: Vec<File>,
    }
    fn invalid() -> io::Error {
        io::Error::new(io::ErrorKind::InvalidInput, "unsafe attachment blob path")
    }
    fn name(value: &str) -> io::Result<std::ffi::CString> {
        if value.is_empty()
            || value.contains('/')
            || value.contains('\\')
            || value == "."
            || value == ".."
        {
            return Err(invalid());
        }
        std::ffi::CString::new(value).map_err(|_| invalid())
    }
    #[cfg(unix)]
    fn owned(fd: libc::c_int) -> io::Result<File> {
        use std::os::fd::FromRawFd;
        if fd < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(unsafe { File::from_raw_fd(fd) })
        }
    }
    impl Directory {
        pub(super) fn open(store: &FileStore, ns: &Namespace, create: bool) -> io::Result<Self> {
            // The configured FileStore root is the trusted anchor. Only its
            // derived account namespace and blob children are attacker input.
            let root = store.root().canonicalize()?;
            let relative = super::blob_dir(store, ns)
                .strip_prefix(store.root())
                .map_err(|_| invalid())?
                .to_path_buf();
            Self::open_relative(&root, &relative, create)
        }
        pub(super) fn open_relative(
            root: &Path,
            relative: &Path,
            create: bool,
        ) -> io::Result<Self> {
            #[cfg(unix)]
            {
                use std::os::{fd::AsRawFd, unix::fs::OpenOptionsExt};
                let mut current = OpenOptions::new()
                    .read(true)
                    .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
                    .open(root)?;
                for component in relative.components() {
                    let std::path::Component::Normal(part) = component else {
                        return Err(invalid());
                    };
                    let part = name(part.to_str().ok_or_else(invalid)?)?;
                    let mut next = owned(unsafe {
                        libc::openat(
                            current.as_raw_fd(),
                            part.as_ptr(),
                            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                        )
                    });
                    if create
                        && next
                            .as_ref()
                            .is_err_and(|e| e.kind() == io::ErrorKind::NotFound)
                    {
                        let result =
                            unsafe { libc::mkdirat(current.as_raw_fd(), part.as_ptr(), 0o700) };
                        if result != 0
                            && io::Error::last_os_error().kind() != io::ErrorKind::AlreadyExists
                        {
                            return Err(io::Error::last_os_error());
                        }
                        next = owned(unsafe {
                            libc::openat(
                                current.as_raw_fd(),
                                part.as_ptr(),
                                libc::O_RDONLY
                                    | libc::O_DIRECTORY
                                    | libc::O_NOFOLLOW
                                    | libc::O_CLOEXEC,
                            )
                        });
                        next.as_ref()
                            .map_err(|e| io::Error::new(e.kind(), "open created blob directory"))?
                            .sync_all()?;
                        current.sync_all()?;
                    }
                    let next = next?;
                    if create {
                        next.sync_all()?;
                        current.sync_all()?;
                    }
                    current = next;
                }
                Ok(Self { file: current })
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
                fn pin(path: &Path) -> io::Result<File> {
                    let handle = OpenOptions::new()
                        .read(true)
                        .write(true)
                        .share_mode(3)
                        .custom_flags(0x02000000 | 0x00200000)
                        .open(path)?;
                    let metadata = handle.metadata()?;
                    if metadata.file_attributes() & 0x400 != 0 || !metadata.is_dir() {
                        return Err(invalid());
                    }
                    Ok(handle)
                }
                let mut guards = vec![pin(&root)?];
                let mut path = root.to_path_buf();
                for component in relative.components() {
                    let std::path::Component::Normal(part) = component else {
                        return Err(invalid());
                    };
                    path.push(part);
                    let next = match pin(&path) {
                        Err(e) if create && e.kind() == io::ErrorKind::NotFound => {
                            match fs::create_dir(&path) {
                                Ok(()) => {}
                                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                                Err(e) => return Err(e),
                            }
                            let handle = pin(&path)?;
                            handle.sync_all()?;
                            guards.last().ok_or_else(invalid)?.sync_all()?;
                            handle
                        }
                        result => result?,
                    };
                    guards.push(next);
                }
                Ok(Self {
                    path,
                    _guards: guards,
                })
            }
        }
        pub(super) fn read(&self, filename: &str) -> io::Result<File> {
            self.open_file(filename, false)
        }
        fn open_file(&self, filename: &str, writable: bool) -> io::Result<File> {
            let filename = name(filename)?;
            #[cfg(unix)]
            {
                use std::os::fd::AsRawFd;
                let file = owned(unsafe {
                    libc::openat(
                        self.file.as_raw_fd(),
                        filename.as_ptr(),
                        (if writable {
                            libc::O_RDWR
                        } else {
                            libc::O_RDONLY
                        }) | libc::O_NOFOLLOW
                            | libc::O_NONBLOCK
                            | libc::O_CLOEXEC,
                    )
                })?;
                if !file.metadata()?.is_file() {
                    return Err(invalid());
                }
                Ok(file)
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
                let file = OpenOptions::new()
                    .read(true)
                    .write(writable)
                    .share_mode(1)
                    .custom_flags(0x00200000)
                    .open(self.path.join(filename.to_str().map_err(|_| invalid())?))?;
                let metadata = file.metadata()?;
                if metadata.file_attributes() & 0x400 != 0 || !metadata.is_file() {
                    return Err(invalid());
                }
                Ok(file)
            }
        }
        pub(super) fn write_atomic(&self, filename: &str, bytes: &[u8]) -> io::Result<()> {
            let destination = name(filename)?;
            let temporary = name(&format!("state.json.tmp-{}", uuid::Uuid::new_v4()))?;
            #[cfg(unix)]
            {
                use std::os::fd::AsRawFd;
                let fd = self.file.as_raw_fd();
                let mut file = owned(unsafe {
                    libc::openat(
                        fd,
                        temporary.as_ptr(),
                        libc::O_WRONLY
                            | libc::O_CREAT
                            | libc::O_EXCL
                            | libc::O_NOFOLLOW
                            | libc::O_CLOEXEC,
                        0o600,
                    )
                })?;
                let result = (|| {
                    file.write_all(bytes)?;
                    file.sync_all()?;
                    if unsafe { libc::renameat(fd, temporary.as_ptr(), fd, destination.as_ptr()) }
                        != 0
                    {
                        return Err(io::Error::last_os_error());
                    }
                    self.file.sync_all()
                })();
                if result.is_err() {
                    unsafe {
                        libc::unlinkat(fd, temporary.as_ptr(), 0);
                    }
                }
                result
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                let temp_path = self.path.join(temporary.to_str().map_err(|_| invalid())?);
                let destination = self.path.join(destination.to_str().map_err(|_| invalid())?);
                let result = (|| {
                    let mut file = OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .share_mode(0)
                        .custom_flags(0x00200000)
                        .open(&temp_path)?;
                    file.write_all(bytes)?;
                    file.sync_all()?;
                    drop(file);
                    fs::rename(&temp_path, destination)?;
                    self._guards.last().ok_or_else(invalid)?.sync_all()
                })();
                if result.is_err() {
                    let _ = fs::remove_file(&temp_path);
                }
                result
            }
        }
        pub(super) fn rename_to(&self, from: &str, target: &Self, to: &str) -> io::Result<()> {
            let from = name(from)?;
            let to = name(to)?;
            #[cfg(unix)]
            {
                use std::os::fd::AsRawFd;
                if unsafe {
                    libc::renameat(
                        self.file.as_raw_fd(),
                        from.as_ptr(),
                        target.file.as_raw_fd(),
                        to.as_ptr(),
                    )
                } != 0
                {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            }
            #[cfg(windows)]
            {
                fs::rename(
                    self.path.join(from.to_str().map_err(|_| invalid())?),
                    target.path.join(to.to_str().map_err(|_| invalid())?),
                )
            }
        }
        pub(super) fn names(&self) -> io::Result<Vec<String>> {
            #[cfg(unix)]
            {
                use std::{ffi::CStr, os::fd::AsRawFd};
                let duplicate = unsafe { libc::dup(self.file.as_raw_fd()) };
                if duplicate < 0 {
                    return Err(io::Error::last_os_error());
                }
                let directory = unsafe { libc::fdopendir(duplicate) };
                if directory.is_null() {
                    unsafe {
                        libc::close(duplicate);
                    }
                    return Err(io::Error::last_os_error());
                }
                // fdopendir owns duplicate. The original descriptor's offset
                // is shared, so rewind each traversal before enumerating.
                unsafe {
                    libc::rewinddir(directory);
                }
                let mut names = Vec::new();
                loop {
                    let entry = unsafe { libc::readdir(directory) };
                    if entry.is_null() {
                        break;
                    }
                    let item = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }
                        .to_string_lossy()
                        .into_owned();
                    if item != "." && item != ".." {
                        names.push(item);
                    }
                }
                unsafe {
                    libc::closedir(directory);
                }
                Ok(names)
            }
            #[cfg(windows)]
            {
                fs::read_dir(&self.path)?
                    .map(|entry| Ok(entry?.file_name().to_string_lossy().into_owned()))
                    .collect()
            }
        }
        pub(super) fn remove(&self, filename: &str) -> io::Result<()> {
            let filename = name(filename)?;
            #[cfg(unix)]
            {
                use std::os::fd::AsRawFd;
                if unsafe { libc::unlinkat(self.file.as_raw_fd(), filename.as_ptr(), 0) } != 0 {
                    return Err(io::Error::last_os_error());
                }
                self.file.sync_all()
            }
            #[cfg(windows)]
            {
                fs::remove_file(self.path.join(filename.to_str().map_err(|_| invalid())?))?;
                self._guards.last().ok_or_else(invalid)?.sync_all()
            }
        }
    }
    impl core_store::file::NamespaceDirectory for Directory {
        fn open_file(&self, filename: &str, writable: bool) -> io::Result<File> {
            Directory::open_file(self, filename, writable)
        }
        fn create_new(&self, filename: &str) -> io::Result<File> {
            let filename = name(filename)?;
            #[cfg(unix)]
            {
                use std::os::fd::AsRawFd;
                owned(unsafe {
                    libc::openat(
                        self.file.as_raw_fd(),
                        filename.as_ptr(),
                        libc::O_WRONLY
                            | libc::O_CREAT
                            | libc::O_EXCL
                            | libc::O_NOFOLLOW
                            | libc::O_CLOEXEC,
                        0o600,
                    )
                })
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .share_mode(0)
                    .custom_flags(0x00200000)
                    .open(self.path.join(filename.to_str().map_err(|_| invalid())?))
            }
        }
        fn rename(&self, from: &str, to: &str) -> io::Result<()> {
            self.rename_to(from, self, to)
        }
        fn remove(&self, filename: &str) -> io::Result<()> {
            Directory::remove(self, filename)
        }
        fn names(&self) -> io::Result<Vec<String>> {
            Directory::names(self)
        }
        fn sync(&self) -> io::Result<()> {
            #[cfg(unix)]
            {
                self.file.sync_all()
            }
            #[cfg(windows)]
            {
                self._guards.last().ok_or_else(invalid)?.sync_all()
            }
        }
    }
}

/// Host namespace backend shared by outbound, main, and peripheral stores.
/// The trusted root boundary does not cover unrelated application files.
#[derive(Debug)]
pub(crate) struct SafeNamespaceIo {
    logical_root: std::path::PathBuf,
    trusted_root: std::path::PathBuf,
}
impl SafeNamespaceIo {
    pub(crate) fn new(root: &std::path::Path) -> Result<Self, AppError> {
        Ok(Self {
            logical_root: root.into(),
            trusted_root: root.canonicalize().map_err(|_| io_error())?,
        })
    }
    fn directory(
        &self,
        path: &std::path::Path,
        create: bool,
    ) -> std::io::Result<blob_files::Directory> {
        let relative = path.strip_prefix(&self.logical_root).map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "namespace outside store root",
            )
        })?;
        blob_files::Directory::open_relative(&self.trusted_root, relative, create)
    }
}
impl core_store::file::NamespaceIo for SafeNamespaceIo {
    fn directory(
        &self,
        path: &std::path::Path,
        create: bool,
    ) -> std::io::Result<Box<dyn core_store::file::NamespaceDirectory>> {
        Ok(Box::new(self.directory(path, create)?))
    }
    fn rename(&self, from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
        let split = |path: &std::path::Path| -> std::io::Result<(std::path::PathBuf, String)> {
            path.parent()
                .zip(path.file_name().and_then(|name| name.to_str()))
                .map(|(parent, name)| (parent.into(), name.into()))
                .ok_or_else(|| {
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        "invalid namespace filename",
                    )
                })
        };
        let (from_dir, from_name) = split(from)?;
        let (to_dir, to_name) = split(to)?;
        let source = self.directory(&from_dir, false)?;
        let target = self.directory(&to_dir, true)?;
        source.rename_to(&from_name, &target, &to_name)
    }
}

#[cfg(test)]
thread_local! { static VERIFIED_BLOB_BYTES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) }; }

fn summary_state(store: &FileStore, ns: &Namespace, lease: &Lease) -> LeaseState {
    if !lease.outbox_refs.is_empty() {
        return LeaseState::Pending;
    }
    match blob_files::Directory::open(store, ns, false)
        .and_then(|directory| directory.read(&lease.content_sha256))
        .and_then(|file| file.metadata())
    {
        Ok(metadata) if metadata.is_file() && metadata.len() == lease.size as u64 => {
            LeaseState::Ready
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => LeaseState::Missing,
        _ => LeaseState::Corrupt,
    }
}

fn draft_summary(
    store: &FileStore,
    account: &AccountContext,
    draft: Draft,
    mut lookup: impl FnMut(&str) -> Result<Lease, AppError>,
) -> Result<DurableDraft, AppError> {
    let ns = Namespace::from_context(account);
    let mut attachments = Vec::new();
    for id in draft.lease_ids {
        let lease = lookup(&id)?;
        if lease.gid != draft.gid || !lease.draft_refs.contains(&draft.gid) {
            return Err(corrupt());
        }
        let state = summary_state(store, &ns, &lease);
        attachments.push(LeaseView {
            lease_id: id,
            name: lease.name,
            kind: lease.kind,
            mime: lease.mime,
            size: lease.size,
            content_sha256: lease.content_sha256,
            state,
        });
    }
    Ok(DurableDraft {
        gid: draft.gid,
        text: draft.text,
        version: draft.version,
        attachments,
        attachment_version: draft.attachment_version,
    })
}

fn bytes(store: &FileStore, ns: &Namespace, lease: &Lease) -> Result<Vec<u8>, LeaseState> {
    let file = blob_files::Directory::open(store, ns, false)
        .and_then(|directory| directory.read(&lease.content_sha256))
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                LeaseState::Missing
            } else {
                LeaseState::Corrupt
            }
        })?;
    let meta = file.metadata().map_err(|_| LeaseState::Corrupt)?;
    if !meta.is_file() || meta.len() != lease.size as u64 {
        return Err(LeaseState::Corrupt);
    }
    let mut result = Vec::new();
    file.take(media_outbound::LOCAL_CAP as u64 + 1)
        .read_to_end(&mut result)
        .map_err(|_| LeaseState::Corrupt)?;
    #[cfg(test)]
    VERIFIED_BLOB_BYTES.with(|counter| counter.set(counter.get().saturating_add(result.len())));
    if result.len() != lease.size || media_outbound::sha256(&result) != lease.content_sha256 {
        return Err(LeaseState::Corrupt);
    }
    Ok(result)
}

impl OutboundJournal {
    /// No persistent token, sender identity or session generation is copied.
    pub fn persist_attachment(&self, attachment: &FrozenAttachment) -> Result<String, AppError> {
        let account: AccountContext = attachment.dto.owner.account.clone().into();
        attachment.validate(&account, &attachment.dto.owner.gid)?;
        let _writer = self.writer_lock()?;
        let ns = Namespace::from_context(&account);
        // Check logout/corruption before writing any new blob.
        self.store.begin(&ns)?;
        self.collect_stale_leases_locked(&account)?;
        let mut tx = self.store.begin(&ns)?;
        let id = attachment
            .dto
            .lease_id
            .clone()
            .unwrap_or_else(|| attachment.dto.attachment_id.clone());
        if !valid_id(&id) {
            return Err(corrupt());
        }
        let existing = self.store.get(&ns, LEASES, &id)?;
        if let Some(raw) = existing {
            let lease = decode_lease(&raw, &account, &id)?;
            verify_attachment(&lease, attachment)?;
            bytes(&self.store, &ns, &lease).map_err(|_| corrupt())?;
            self.committed_barrier(&ns)?;
            return Ok(id);
        }
        let leases = self.store.list(&ns, LEASES)?;
        let total_bytes = leases.iter().try_fold(0usize, |sum, (key, value)| {
            let lease = decode_lease(value, &account, key)?;
            sum.checked_add(lease.size).ok_or_else(corrupt)
        })?;
        // Include orphan and interrupted temp bytes in the quota, even while
        // their grace period protects a concurrent/failed registration.
        let directory =
            blob_files::Directory::open(&self.store, &ns, true).map_err(|_| io_error())?;
        let disk_bytes =
            directory
                .names()
                .map_err(|_| io_error())?
                .iter()
                .try_fold(0u64, |sum, name| {
                    let metadata = directory
                        .read(name)
                        .and_then(|file| file.metadata())
                        .map_err(|_| io_error())?;
                    Ok::<u64, AppError>(sum.saturating_add(metadata.len()))
                })?;
        if leases.len() >= MAX_LEASES
            || total_bytes.saturating_add(attachment.dto.size) > MAX_BYTES
            || disk_bytes.saturating_add(attachment.dto.size as u64) > MAX_BYTES as u64
        {
            return Err(AppError::new(
                "media.lease_capacity",
                "attachment storage is full; remove unused drafts first",
            ));
        }
        let lease = Lease {
            schema: 1,
            created_ms: media_outbound::now_ms(),
            lease_id: id.clone(),
            environment: account.environment.as_str().into(),
            account_id: account.account_id.as_str().into(),
            gid: attachment.dto.owner.gid.clone(),
            name: attachment.dto.name.clone(),
            kind: attachment.dto.kind.clone(),
            mime: attachment.dto.mime.clone(),
            size: attachment.dto.size,
            content_sha256: attachment.dto.content_sha256.clone(),
            draft_refs: BTreeSet::new(),
            outbox_refs: BTreeSet::new(),
        };
        // Same-account content-addressed bytes. A crash here leaves only an
        // orphan blob, never a draft or outbox pointing at uncommitted bytes.
        directory
            .write_atomic(&lease.content_sha256, &attachment.bytes)
            .map_err(|_| io_error())?;
        tx.expect_unchanged(LEASES, &id, None);
        tx.put(LEASES, &id, encode(&lease)?);
        self.store.commit(tx)?;
        self.committed_barrier(&ns)?;
        Ok(id)
    }

    /// Imports the legacy text store once. Source rows are never deleted or
    /// dual-written; target rows and marker are committed together. Locked or
    /// corrupt sources are errors, not a successful empty migration.
    fn migrate_drafts_locked(
        &self,
        account: &AccountContext,
        legacy: &dyn Store,
    ) -> Result<(), AppError> {
        let ns = Namespace::from_context(account);
        if let Some(marker) = self.store.get(&ns, MIGRATIONS, MIGRATION)? {
            if marker.as_str() != Some("complete") {
                return Err(corrupt());
            }
            self.committed_barrier(&ns)?;
            return Ok(());
        }
        if legacy.is_locked(&ns)? {
            return Err(AppError::new(
                "store.locked",
                "legacy draft source is logout-locked",
            ));
        }
        let before = legacy.last_commit(&ns)?;
        let drafts = core_store::DraftBook::load(legacy, &ns)?;
        if legacy.last_commit(&ns)? != before || legacy.is_locked(&ns)? {
            return Err(cas());
        }
        let mut tx = self.store.begin(&ns)?;
        tx.expect_unchanged(MIGRATIONS, MIGRATION, None);
        for old in drafts {
            if old.gid.is_empty() || core_store::looks_secret_like(&old.gid) || old.version == 0 {
                return Err(corrupt());
            }
            let (current, _) = read_draft(&self.store, &ns, &old.gid)?;
            tx.expect_unchanged(DRAFTS, &old.gid, current.clone());
            if current.is_none() {
                tx.put(
                    DRAFTS,
                    &old.gid,
                    encode(&Draft {
                        gid: old.gid.clone(),
                        text: old.text,
                        version: old.version,
                        lease_ids: vec![],
                        attachment_version: 0,
                    })?,
                );
            }
        }
        tx.put(MIGRATIONS, MIGRATION, JsonValue::string("complete"));
        self.store.commit(tx)?;
        self.committed_barrier(&ns)
    }

    /// Summary only: `ready` means the bound regular file exists at the
    /// expected length. Full content integrity is checked on restore and again
    /// before send reservation, never inferred from this UI summary.
    pub fn load_drafts(
        &self,
        account: &AccountContext,
        legacy: &dyn Store,
    ) -> Result<Vec<DurableDraft>, AppError> {
        let _writer = self.writer_lock()?;
        self.migrate_drafts_locked(account, legacy)?;
        let ns = Namespace::from_context(account);
        // Read each metadata collection once; do not reload the complete
        // namespace document separately for every attachment in the account.
        let leases: BTreeMap<String, JsonValue> =
            self.store.list(&ns, LEASES)?.into_iter().collect();
        self.store
            .list(&ns, DRAFTS)?
            .into_iter()
            .map(|(gid, raw)| {
                let draft = decode_draft(&raw, &gid)?;
                draft_summary(&self.store, account, draft, |id| {
                    decode_lease(leases.get(id).ok_or_else(corrupt)?, account, id)
                })
            })
            .collect()
    }

    /// Reads only the requested conversation after a field-level save.
    pub fn load_draft(
        &self,
        account: &AccountContext,
        gid: &str,
        legacy: &dyn Store,
    ) -> Result<Option<DurableDraft>, AppError> {
        validate_gid(gid)?;
        let _writer = self.writer_lock()?;
        self.migrate_drafts_locked(account, legacy)?;
        let (_, draft) = read_draft(&self.store, &Namespace::from_context(account), gid)?;
        draft
            .map(|draft| {
                draft_summary(&self.store, account, draft, |id| {
                    read_lease(&self.store, account, id).map(|(_, lease)| lease)
                })
            })
            .transpose()
    }

    /// Text CAS never replaces the attachment field or its revision.
    pub fn save_draft_text(
        &self,
        account: &AccountContext,
        gid: &str,
        text: &str,
        expected_version: u64,
        legacy: &dyn Store,
    ) -> Result<u64, AppError> {
        validate_gid(gid)?;
        let _writer = self.writer_lock()?;
        self.migrate_drafts_locked(account, legacy)?;
        let ns = Namespace::from_context(account);
        let mut tx = self.store.begin(&ns)?;
        let (raw, current) = read_draft(&self.store, &ns, gid)?;
        let mut draft = current.unwrap_or_else(|| empty_draft(gid));
        if draft.version != expected_version {
            return Err(cas());
        }
        draft.version = if text.is_empty() {
            0
        } else {
            expected_version.checked_add(1).ok_or_else(corrupt)?
        };
        draft.text = text.into();
        tx.expect_unchanged(DRAFTS, gid, raw);
        tx.put(DRAFTS, gid, encode(&draft)?);
        self.store.commit(tx)?;
        self.committed_barrier(&ns)?;
        Ok(draft.version)
    }

    /// Attachment CAS changes refs and the field together, preserving text.
    /// Clearing retains the revision tombstone so delayed work cannot win ABA.
    pub fn set_draft_attachment(
        &self,
        account: &AccountContext,
        gid: &str,
        lease_id: Option<&str>,
        expected_attachment_version: u64,
        legacy: &dyn Store,
    ) -> Result<u64, AppError> {
        validate_gid(gid)?;
        let _writer = self.writer_lock()?;
        self.migrate_drafts_locked(account, legacy)?;
        let ns = Namespace::from_context(account);
        let mut tx = self.store.begin(&ns)?;
        let (raw, current) = read_draft(&self.store, &ns, gid)?;
        let mut draft = current.unwrap_or_else(|| empty_draft(gid));
        if draft.attachment_version != expected_attachment_version {
            return Err(cas());
        }
        let wanted: BTreeSet<String> = lease_id.into_iter().map(str::to_string).collect();
        let previous: BTreeSet<String> = draft.lease_ids.iter().cloned().collect();
        for id in wanted.union(&previous) {
            let (raw, mut lease) = read_lease(&self.store, account, id)?;
            if lease.gid != gid {
                return Err(corrupt());
            }
            if wanted.contains(id) {
                // Never attach a newly selected missing/corrupt blob to a draft.
                // Existing broken refs remain removable through the same CAS.
                if !previous.contains(id) {
                    bytes(&self.store, &ns, &lease).map_err(|_| corrupt())?;
                }
                lease.draft_refs.insert(gid.into());
            } else {
                lease.draft_refs.remove(gid);
            }
            tx.expect_unchanged(LEASES, id, Some(raw));
            tx.put(LEASES, id, encode(&lease)?);
        }
        draft.lease_ids = wanted.into_iter().collect();
        draft.attachment_version = expected_attachment_version
            .checked_add(1)
            .ok_or_else(corrupt)?;
        tx.expect_unchanged(DRAFTS, gid, raw);
        tx.put(DRAFTS, gid, encode(&draft)?);
        self.store.commit(tx)?;
        self.committed_barrier(&ns)?;
        Ok(draft.attachment_version)
    }

    /// Collection runs under the same OS lock as draft/outbox changes. It
    /// removes only expired unreferenced leases; all unknown pins survive.
    fn collect_stale_leases_locked(&self, account: &AccountContext) -> Result<(), AppError> {
        let ns = Namespace::from_context(account);
        let now = media_outbound::now_ms();
        let rows = self.store.list(&ns, LEASES)?;
        let mut tx = self.store.begin(&ns)?;
        let mut removed = false;
        let mut live_hashes = BTreeSet::new();
        for (id, raw) in rows {
            let lease = decode_lease(&raw, account, &id)?;
            if lease.draft_refs.is_empty()
                && lease.outbox_refs.is_empty()
                && now.saturating_sub(lease.created_ms) > media_outbound::TTL_MS
            {
                tx.expect_unchanged(LEASES, &id, Some(raw));
                tx.delete(LEASES, &id);
                removed = true;
            } else {
                live_hashes.insert(lease.content_sha256);
            }
        }
        if removed {
            self.store.commit(tx)?;
            self.committed_barrier(&ns)?;
        }
        let directory = match blob_files::Directory::open(&self.store, &ns, false) {
            Ok(directory) => directory,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err(io_error()),
        };
        for name in directory.names().map_err(|_| io_error())? {
            if live_hashes.contains(&name) {
                continue;
            }
            let metadata = directory
                .read(&name)
                .and_then(|file| file.metadata())
                .map_err(|_| io_error())?;
            let expired = metadata
                .modified()
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age.as_millis() > media_outbound::TTL_MS as u128);
            if expired && (media_outbound::valid_hash(&name) || name.starts_with("state.json.tmp-"))
            {
                directory.remove(&name).map_err(|_| io_error())?;
            }
        }
        Ok(())
    }

    /// The caller must freshly authorize the current real page target before
    /// calling this. A lease cannot supply a target token or revive generation.
    pub fn restore_attachment(
        &self,
        account: &AccountContext,
        gid: &str,
        lease_id: &str,
        target: MediaTarget,
    ) -> Result<FrozenAttachment, AppError> {
        if target.target_token.is_empty()
            || target.sender_id.is_empty()
            || !media_outbound::valid_hash(&target.identity_sha256)
        {
            return Err(media_outbound::invalid());
        }
        let _writer = self.writer_lock()?;
        let ns = Namespace::from_context(account);
        if self.store.is_locked(&ns)? {
            return Err(AppError::new(
                "store.locked",
                "attachment namespace is logout-locked",
            ));
        }
        let (_, lease) = read_lease(&self.store, account, lease_id)?;
        if lease.gid != gid || !lease.draft_refs.contains(gid) {
            return Err(media_outbound::invalid());
        }
        if !lease.outbox_refs.is_empty() {
            return Err(pending());
        }
        let content = bytes(&self.store, &ns, &lease).map_err(|state| {
            AppError::new(
                if state == LeaseState::Missing {
                    "media.lease_missing"
                } else {
                    "media.lease_corrupt"
                },
                "attachment bytes are unavailable; select the file again",
            )
        })?;
        self.committed_barrier(&ns)?;
        Ok(FrozenAttachment {
            dto: AttachmentDto {
                preview_data_url: None,
                attachment_id: uuid::Uuid::new_v4().to_string(),
                lease_id: Some(lease_id.into()),
                name: lease.name,
                kind: lease.kind,
                mime: lease.mime,
                size: lease.size,
                content_sha256: lease.content_sha256,
                owner: AttachmentOwner {
                    account: account.into(),
                    gid: gid.into(),
                },
                supported: true,
            },
            bytes: Arc::new(content),
            target,
            created_ms: media_outbound::now_ms(),
        })
    }

    /// Explicit handle release may collect only unreferenced leases. Unknown
    /// attempts keep their outbox reference forever, including after restart.
    pub fn release_attachment(
        &self,
        account: &AccountContext,
        gid: &str,
        lease_id: &str,
    ) -> Result<(), AppError> {
        let _writer = self.writer_lock()?;
        let ns = Namespace::from_context(account);
        let Some(raw) = self.store.get(&ns, LEASES, lease_id)? else {
            return Ok(());
        };
        let lease = decode_lease(&raw, account, lease_id)?;
        if lease.gid != gid {
            return Err(media_outbound::invalid());
        }
        if !lease.draft_refs.is_empty() || !lease.outbox_refs.is_empty() {
            return Ok(());
        }
        let mut tx = self.store.begin(&ns)?;
        tx.expect_unchanged(LEASES, lease_id, Some(raw));
        tx.delete(LEASES, lease_id);
        self.store.commit(tx)?;
        self.committed_barrier(&ns)?;
        // Same content may be shared by another lease of this account.
        for (id, raw) in self.store.list(&ns, LEASES)? {
            if decode_lease(&raw, account, &id)?.content_sha256 == lease.content_sha256 {
                return Ok(());
            }
        }
        match blob_files::Directory::open(&self.store, &ns, false)
            .and_then(|directory| directory.remove(&lease.content_sha256))
        {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(io_error()),
        }
    }
}

fn validate_gid(gid: &str) -> Result<(), AppError> {
    if gid.is_empty() || core_store::looks_secret_like(gid) {
        Err(corrupt())
    } else {
        Ok(())
    }
}
fn empty_draft(gid: &str) -> Draft {
    Draft {
        gid: gid.into(),
        text: String::new(),
        version: 0,
        lease_ids: vec![],
        attachment_version: 0,
    }
}

fn verify_attachment(lease: &Lease, attachment: &FrozenAttachment) -> Result<(), AppError> {
    let dto = &attachment.dto;
    if lease.gid != dto.owner.gid
        || lease.name != dto.name
        || lease.kind != dto.kind
        || lease.mime != dto.mime
        || lease.size != dto.size
        || lease.content_sha256 != dto.content_sha256
    {
        return Err(corrupt());
    }
    Ok(())
}

pub(crate) fn capture_draft_version(
    store: &FileStore,
    account: &AccountContext,
    attachment: &FrozenAttachment,
) -> Result<Option<u64>, AppError> {
    attachment.validate(account, &attachment.dto.owner.gid)?;
    let id = attachment.dto.lease_id.as_deref().ok_or_else(corrupt)?;
    let (_, lease) = read_lease(store, account, id)?;
    verify_attachment(&lease, attachment)?;
    let (_, draft) = read_draft(store, &Namespace::from_context(account), &lease.gid)?;
    Ok(draft
        .filter(|draft| draft.lease_ids.iter().any(|value| value == id))
        .map(|draft| draft.attachment_version))
}

pub(crate) fn reserve_reference(
    store: &FileStore,
    tx: &mut Txn,
    account: &AccountContext,
    local_id: &str,
    attachment: &FrozenAttachment,
) -> Result<(), AppError> {
    let id = attachment.dto.lease_id.as_deref().ok_or_else(corrupt)?;
    let (raw, mut lease) = read_lease(store, account, id)?;
    verify_attachment(&lease, attachment)?;
    if !lease.outbox_refs.is_empty() {
        return Err(pending());
    }
    bytes(store, tx.namespace(), &lease).map_err(|_| corrupt())?;
    lease.outbox_refs.insert(local_id.into());
    tx.expect_unchanged(LEASES, id, Some(raw));
    tx.put(LEASES, id, encode(&lease)?);
    Ok(())
}

pub(crate) fn release_outbox_reference(
    store: &FileStore,
    tx: &mut Txn,
    account: &AccountContext,
    local_id: &str,
    lease_id: &str,
    confirmed_draft_version: Option<u64>,
) -> Result<(), AppError> {
    let (raw, mut lease) = read_lease(store, account, lease_id)?;
    if !lease.outbox_refs.remove(local_id) {
        return Err(corrupt());
    }
    if let Some(version) = confirmed_draft_version {
        let (draft_raw, draft) = read_draft(store, tx.namespace(), &lease.gid)?;
        if let Some(mut draft) = draft.filter(|draft| {
            draft.attachment_version == version && draft.lease_ids.as_slice() == [lease_id]
        }) {
            draft.lease_ids.clear();
            draft.attachment_version = draft
                .attachment_version
                .checked_add(1)
                .ok_or_else(corrupt)?;
            lease.draft_refs.remove(&lease.gid);
            tx.expect_unchanged(DRAFTS, &lease.gid, draft_raw);
            tx.put(DRAFTS, &lease.gid, encode(&draft)?);
        }
    }
    tx.expect_unchanged(LEASES, lease_id, Some(raw));
    tx.put(LEASES, lease_id, encode(&lease)?);
    Ok(())
}
fn pending() -> AppError {
    AppError::new(
        "media.lease_pending",
        "attachment has an unresolved outbound attempt; no second upload is authorized",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::SendDispositionDto;
    use contracts::{AccountId, Environment};
    use core_store::{
        hooks::{self, FailPoint, FaultAction},
        DraftBook,
    };

    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("vbk-lease-test-{}", uuid::Uuid::new_v4())))
        }
        fn journal(&self) -> OutboundJournal {
            OutboundJournal::open(self.0.join("outbound")).unwrap()
        }
        fn legacy(&self) -> FileStore {
            FileStore::open(self.0.join("legacy")).unwrap()
        }
        fn attachment(
            &self,
            journal: &OutboundJournal,
            account: &AccountContext,
        ) -> FrozenAttachment {
            let path = self.0.join("source.bin");
            fs::write(&path, b"synthetic immutable attachment").unwrap();
            let mut attachment =
                FrozenAttachment::read(&path, "file", account, "room", target()).unwrap();
            attachment.dto.lease_id = Some(journal.persist_attachment(&attachment).unwrap());
            attachment
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn account(generation: u64) -> AccountContext {
        AccountContext::new(
            AccountId::new("synthetic-account"),
            Environment::named("test"),
            generation,
        )
    }
    fn target() -> MediaTarget {
        MediaTarget {
            target_token: "never-persist-this-token".into(),
            identity_sha256: "a".repeat(64),
            sender_id: "sender".into(),
        }
    }

    #[test]
    fn restart_restores_bytes_with_fresh_generation_and_handle_without_persisted_authority() {
        let fixture = Fixture::new();
        let journal = fixture.journal();
        let legacy = fixture.legacy();
        let a = account(1);
        let frozen = fixture.attachment(&journal, &a);
        let id = frozen.dto.lease_id.clone().unwrap();
        journal
            .set_draft_attachment(&a, "room", Some(&id), 0, &legacy)
            .unwrap();
        journal
            .save_draft_text(&a, "room", "unsent", 0, &legacy)
            .unwrap();
        let manifest = fs::read_to_string(
            journal
                .store
                .namespace_dir(&Namespace::from_context(&a))
                .join("state.json"),
        )
        .unwrap();
        assert!(!manifest.contains("never-persist-this-token"));
        assert!(!manifest.contains("session_generation"));
        assert!(!manifest.contains("sender"));
        drop(journal);
        let journal = fixture.journal();
        let drafts = journal.load_drafts(&account(42), &legacy).unwrap();
        assert_eq!(drafts[0].text, "unsent");
        assert_eq!(drafts[0].attachments[0].state, LeaseState::Ready);
        let restored = journal
            .restore_attachment(&account(42), "room", &id, target())
            .unwrap();
        assert_ne!(restored.dto.attachment_id, frozen.dto.attachment_id);
        assert_eq!(restored.bytes, frozen.bytes);
        assert!(restored.validate(&account(42), "room").is_ok());
        assert!(restored.validate(&account(1), "room").is_err());
    }

    #[test]
    fn independent_cas_preserves_text_and_attachment_clear_tombstone_rejects_aba() {
        let f = Fixture::new();
        let j = f.journal();
        let legacy = f.legacy();
        let a = account(1);
        let frozen = f.attachment(&j, &a);
        let id = frozen.dto.lease_id.unwrap();
        assert_eq!(j.save_draft_text(&a, "room", "one", 0, &legacy).unwrap(), 1);
        assert_eq!(
            j.set_draft_attachment(&a, "room", Some(&id), 0, &legacy)
                .unwrap(),
            1
        );
        assert_eq!(j.save_draft_text(&a, "room", "two", 1, &legacy).unwrap(), 2);
        assert_eq!(
            j.set_draft_attachment(&a, "room", None, 1, &legacy)
                .unwrap(),
            2
        );
        assert_eq!(
            j.set_draft_attachment(&a, "room", Some(&id), 0, &legacy)
                .unwrap_err()
                .code,
            "store.cas_conflict"
        );
        assert_eq!(
            j.save_draft_text(&a, "room", "stale", 1, &legacy)
                .unwrap_err()
                .code,
            "store.cas_conflict"
        );
        let draft = &j.load_drafts(&a, &legacy).unwrap()[0];
        assert_eq!(draft.text, "two");
        assert!(draft.attachments.is_empty());
        assert_eq!(draft.attachment_version, 2);
    }

    #[test]
    fn missing_and_tampered_blobs_are_explicit_and_cannot_restore() {
        let f = Fixture::new();
        let j = f.journal();
        let legacy = f.legacy();
        let a = account(1);
        let frozen = f.attachment(&j, &a);
        let id = frozen.dto.lease_id.clone().unwrap();
        j.set_draft_attachment(&a, "room", Some(&id), 0, &legacy)
            .unwrap();
        let path =
            blob_dir(&j.store, &Namespace::from_context(&a)).join(&frozen.dto.content_sha256);
        fs::write(&path, vec![b'x'; frozen.dto.size]).unwrap();
        assert_eq!(
            j.load_drafts(&a, &legacy).unwrap()[0].attachments[0].state,
            LeaseState::Ready
        );
        assert_eq!(
            j.restore_attachment(&a, "room", &id, target())
                .err()
                .unwrap()
                .code,
            "media.lease_corrupt"
        );
        fs::remove_file(&path).unwrap();
        assert_eq!(
            j.load_drafts(&a, &legacy).unwrap()[0].attachments[0].state,
            LeaseState::Missing
        );
        assert_eq!(
            j.restore_attachment(&a, "room", &id, target())
                .err()
                .unwrap()
                .code,
            "media.lease_missing"
        );
        // User can still remove a broken attachment without losing text.
        j.set_draft_attachment(&a, "room", None, 1, &legacy)
            .unwrap();
    }

    #[test]
    fn account_environment_and_gid_isolation() {
        let f = Fixture::new();
        let j = f.journal();
        let legacy = f.legacy();
        let a = account(1);
        let frozen = f.attachment(&j, &a);
        let id = frozen.dto.lease_id.unwrap();
        j.set_draft_attachment(&a, "room", Some(&id), 0, &legacy)
            .unwrap();
        for other in [
            AccountContext::new(AccountId::new("other"), Environment::named("test"), 1),
            AccountContext::new(
                AccountId::new("synthetic-account"),
                Environment::named("other"),
                1,
            ),
        ] {
            assert!(j.load_drafts(&other, &legacy).unwrap().is_empty());
            assert!(j.restore_attachment(&other, "room", &id, target()).is_err());
            assert!(j
                .set_draft_attachment(&other, "room", Some(&id), 0, &legacy)
                .is_err());
        }
        assert!(j
            .restore_attachment(&a, "other-room", &id, target())
            .is_err());
    }

    #[test]
    fn unknown_attempt_pins_lease_across_restart_and_never_reserves_twice() {
        let f = Fixture::new();
        let j = f.journal();
        let legacy = f.legacy();
        let a = account(1);
        let frozen = f.attachment(&j, &a);
        let id = frozen.dto.lease_id.clone().unwrap();
        j.set_draft_attachment(&a, "room", Some(&id), 0, &legacy)
            .unwrap();
        assert!(j.reserve_media_attachment(&a, "intent", &frozen).unwrap());
        j.set_draft_attachment(&a, "room", None, 1, &legacy)
            .unwrap();
        j.release_attachment(&a, "room", &id).unwrap();
        drop(j);
        let j = f.journal();
        let (_, lease) = read_lease(&j.store, &account(9), &id).unwrap();
        assert!(lease.outbox_refs.contains("intent"));
        assert!(bytes(&j.store, &Namespace::from_context(&a), &lease).is_ok());
        assert!(!j
            .reserve_media(&account(9), "intent", &frozen.payload(), "file")
            .unwrap());
        assert_eq!(
            j.media_status(&account(9), "intent").unwrap().2,
            SendDispositionDto::Unknown
        );
    }

    #[test]
    fn terminal_release_is_atomic_and_keeps_draft_reference() {
        let f = Fixture::new();
        let j = f.journal();
        let legacy = f.legacy();
        let a = account(1);
        let frozen = f.attachment(&j, &a);
        let id = frozen.dto.lease_id.clone().unwrap();
        j.set_draft_attachment(&a, "room", Some(&id), 0, &legacy)
            .unwrap();
        j.reserve_media_attachment(&a, "rejected", &frozen).unwrap();
        j.finish_media(
            &a,
            "rejected",
            &frozen.payload(),
            SendDispositionDto::Rejected {
                code: "synthetic".into(),
                reason: "no".into(),
            },
        )
        .unwrap();
        let (_, lease) = read_lease(&j.store, &a, &id).unwrap();
        assert!(lease.outbox_refs.is_empty());
        assert!(lease.draft_refs.contains("room"));
        j.release_attachment(&a, "room", &id).unwrap();
        assert!(read_lease(&j.store, &a, &id).is_ok());
        j.set_draft_attachment(&a, "room", None, 1, &legacy)
            .unwrap();
        j.release_attachment(&a, "room", &id).unwrap();
        assert!(read_lease(&j.store, &a, &id).is_err());
    }

    #[test]
    fn migration_crashes_are_idempotent_and_never_touch_source() {
        for point in FailPoint::MODEL_A {
            let f = Fixture::new();
            let j = f.journal();
            let legacy = f.legacy();
            let a = account(1);
            let ns = Namespace::from_context(&a);
            DraftBook::save(&legacy, &ns, "room", "legacy", 0).unwrap();
            let original = fs::read(legacy.namespace_dir(&ns).join("state.json")).unwrap();
            let fault = hooks::inject(
                &j.store.namespace_dir(&ns),
                point,
                FaultAction::Crash,
                0,
                Some(1),
            );
            assert!(j.load_drafts(&a, &legacy).is_err());
            drop(fault);
            drop(j);
            let j = f.journal();
            assert_eq!(j.load_drafts(&a, &legacy).unwrap()[0].text, "legacy");
            j.save_draft_text(&a, "room", "new", 1, &legacy).unwrap();
            assert_eq!(j.load_drafts(&a, &legacy).unwrap()[0].text, "new");
            assert_eq!(
                fs::read(legacy.namespace_dir(&ns).join("state.json")).unwrap(),
                original
            );
        }
    }

    #[test]
    fn locked_or_corrupt_migration_source_is_never_marked_empty() {
        let f = Fixture::new();
        let j = f.journal();
        let legacy = f.legacy();
        let a = account(1);
        let ns = Namespace::from_context(&a);
        DraftBook::save(&legacy, &ns, "room", "legacy", 0).unwrap();
        legacy.logout_lock(&ns).unwrap();
        assert!(j.load_drafts(&a, &legacy).is_err());
        assert!(j.store.get(&ns, MIGRATIONS, MIGRATION).unwrap().is_none());
        legacy.unlock_after_reauth(&ns).unwrap();
        fs::write(legacy.namespace_dir(&ns).join("state.json"), b"broken").unwrap();
        assert!(j.load_drafts(&a, &legacy).is_err());
        assert!(j.store.get(&ns, MIGRATIONS, MIGRATION).unwrap().is_none());
    }

    #[test]
    fn reserve_crash_commits_attempt_and_pin_together_or_neither() {
        for point in FailPoint::MODEL_A {
            let f = Fixture::new();
            let j = f.journal();
            let a = account(1);
            let frozen = f.attachment(&j, &a);
            let id = frozen.dto.lease_id.clone().unwrap();
            let ns = Namespace::from_context(&a);
            let fault = hooks::inject(
                &j.store.namespace_dir(&ns),
                point,
                FaultAction::Crash,
                0,
                Some(1),
            );
            assert!(j.reserve_media_attachment(&a, "intent", &frozen).is_err());
            drop(fault);
            drop(j);
            let j = f.journal();
            let (_, lease) = read_lease(&j.store, &a, &id).unwrap();
            let exists = j
                .replay_media(&a, "intent", "room", Some(&frozen.payload()))
                .unwrap()
                .is_some();
            assert_eq!(lease.outbox_refs.contains("intent"), exists);
        }
    }
    fn start_send(j: &OutboundJournal, a: &AccountContext, frozen: &FrozenAttachment) {
        j.reserve_media_attachment(a, "confirmed", frozen).unwrap();
        j.advance_media(a, "confirmed", &frozen.payload(), "synthetic-body", false)
            .unwrap();
        j.advance_media(a, "confirmed", &frozen.payload(), "synthetic-body", true)
            .unwrap();
    }
    fn confirmed() -> SendDispositionDto {
        SendDispositionDto::Confirmed {
            server_message_id: "server-message".into(),
            server_time_ms: 1,
        }
    }

    #[test]
    fn pending_cannot_restore_or_upload_under_a_new_local_id() {
        let f = Fixture::new();
        let j = f.journal();
        let legacy = f.legacy();
        let a = account(1);
        let frozen = f.attachment(&j, &a);
        let id = frozen.dto.lease_id.clone().unwrap();
        j.set_draft_attachment(&a, "room", Some(&id), 0, &legacy)
            .unwrap();
        j.reserve_media_attachment(&a, "unknown", &frozen).unwrap();
        assert_eq!(
            j.load_drafts(&a, &legacy).unwrap()[0].attachments[0].state,
            LeaseState::Pending
        );
        assert_eq!(
            j.restore_attachment(&a, "room", &id, target())
                .err()
                .unwrap()
                .code,
            "media.lease_pending"
        );
        assert_eq!(
            j.reserve_media_attachment(&a, "new-local-id", &frozen)
                .unwrap_err()
                .code,
            "media.lease_pending"
        );
        assert!(j
            .replay_media(&a, "new-local-id", "room", None)
            .unwrap()
            .is_none());
    }

    #[test]
    fn confirmed_clears_only_the_captured_attachment_revision() {
        for changed in [false, true] {
            let f = Fixture::new();
            let j = f.journal();
            let legacy = f.legacy();
            let a = account(1);
            let frozen = f.attachment(&j, &a);
            let id = frozen.dto.lease_id.clone().unwrap();
            j.set_draft_attachment(&a, "room", Some(&id), 0, &legacy)
                .unwrap();
            j.save_draft_text(&a, "room", "keep text", 0, &legacy)
                .unwrap();
            start_send(&j, &a, &frozen);
            if changed {
                j.set_draft_attachment(&a, "room", Some(&id), 1, &legacy)
                    .unwrap();
            }
            j.finish_media(&a, "confirmed", &frozen.payload(), confirmed())
                .unwrap();
            let drafts = j.load_drafts(&a, &legacy).unwrap();
            let draft = &drafts[0];
            assert_eq!(draft.text, "keep text");
            assert_eq!(draft.attachment_version, 2);
            assert_eq!(draft.attachments.is_empty(), !changed);
            let (_, lease) = read_lease(&j.store, &a, &id).unwrap();
            assert!(lease.outbox_refs.is_empty());
            assert_eq!(lease.draft_refs.contains("room"), changed);
        }
    }

    #[test]
    fn completion_crash_keeps_outbox_and_draft_atomic() {
        for point in FailPoint::MODEL_A {
            let f = Fixture::new();
            let j = f.journal();
            let legacy = f.legacy();
            let a = account(1);
            let frozen = f.attachment(&j, &a);
            let id = frozen.dto.lease_id.clone().unwrap();
            j.set_draft_attachment(&a, "room", Some(&id), 0, &legacy)
                .unwrap();
            start_send(&j, &a, &frozen);
            let fault = hooks::inject(
                &j.store.namespace_dir(&Namespace::from_context(&a)),
                point,
                FaultAction::Crash,
                0,
                Some(1),
            );
            assert!(j
                .finish_media(&a, "confirmed", &frozen.payload(), confirmed())
                .is_err());
            drop(fault);
            drop(j);
            let j = f.journal();
            let completed = matches!(
                j.media_status(&a, "confirmed").unwrap().2,
                SendDispositionDto::Confirmed { .. }
            );
            let (_, lease) = read_lease(&j.store, &a, &id).unwrap();
            let draft = &j.load_drafts(&a, &legacy).unwrap()[0];
            assert_eq!(lease.outbox_refs.is_empty(), completed);
            assert_eq!(lease.draft_refs.is_empty(), completed);
            assert_eq!(draft.attachments.is_empty(), completed);
        }
    }

    #[test]
    fn expired_unreferenced_leases_are_collected_but_unknown_is_pinned() {
        let f = Fixture::new();
        let j = f.journal();
        let a = account(1);
        let ns = Namespace::from_context(&a);
        let first = f.attachment(&j, &a);
        let second = f.attachment(&j, &a);
        j.reserve_media_attachment(&a, "unknown", &second).unwrap();
        let mut tx = j.store.begin(&ns).unwrap();
        for frozen in [&first, &second] {
            let id = frozen.dto.lease_id.as_ref().unwrap();
            let (_, mut lease) = read_lease(&j.store, &a, id).unwrap();
            lease.created_ms = media_outbound::now_ms() - media_outbound::TTL_MS - 1;
            tx.put(LEASES, id, encode(&lease).unwrap());
        }
        j.store.commit(tx).unwrap();
        let _writer = j.writer_lock().unwrap();
        j.collect_stale_leases_locked(&a).unwrap();
        assert!(read_lease(&j.store, &a, first.dto.lease_id.as_ref().unwrap()).is_err());
        assert!(read_lease(&j.store, &a, second.dto.lease_id.as_ref().unwrap()).is_ok());
    }

    #[test]
    fn orphan_bytes_count_toward_capacity_without_deleting_referenced_data() {
        let f = Fixture::new();
        let j = f.journal();
        let a = account(1);
        let ns = Namespace::from_context(&a);
        let first = f.attachment(&j, &a);
        let orphan = blob_dir(&j.store, &ns).join("b".repeat(64));
        fs::File::create(orphan)
            .unwrap()
            .set_len(MAX_BYTES as u64)
            .unwrap();
        let path = f.0.join("source.bin");
        let second = FrozenAttachment::read(&path, "file", &a, "room", target()).unwrap();
        assert_eq!(
            j.persist_attachment(&second).unwrap_err().code,
            "media.lease_capacity"
        );
        assert!(read_lease(&j.store, &a, first.dto.lease_id.as_ref().unwrap()).is_ok());
    }
    #[cfg(unix)]
    #[test]
    fn same_bytes_symlink_and_replaced_blob_directory_are_refused() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        let j = f.journal();
        let legacy = f.legacy();
        let a = account(1);
        let ns = Namespace::from_context(&a);
        let frozen = f.attachment(&j, &a);
        let id = frozen.dto.lease_id.clone().unwrap();
        j.set_draft_attachment(&a, "room", Some(&id), 0, &legacy)
            .unwrap();
        let path = blob_dir(&j.store, &ns).join(&frozen.dto.content_sha256);
        let outside = f.0.join("outside");
        fs::create_dir(&outside).unwrap();
        let outside_blob = outside.join(&frozen.dto.content_sha256);
        fs::write(&outside_blob, frozen.bytes.as_slice()).unwrap();
        fs::remove_file(&path).unwrap();
        symlink(&outside_blob, &path).unwrap();
        assert_eq!(
            j.load_drafts(&a, &legacy).unwrap()[0].attachments[0].state,
            LeaseState::Corrupt
        );
        assert!(j.restore_attachment(&a, "room", &id, target()).is_err());
        fs::remove_file(path).unwrap();
        fs::remove_dir(blob_dir(&j.store, &ns)).unwrap();
        symlink(&outside, blob_dir(&j.store, &ns)).unwrap();
        assert!(j.restore_attachment(&a, "room", &id, target()).is_err());
        let other =
            FrozenAttachment::read(&f.0.join("source.bin"), "file", &a, "room", target()).unwrap();
        assert!(j.persist_attachment(&other).is_err());
        assert_eq!(fs::read(&outside_blob).unwrap(), frozen.bytes.as_slice());
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn pinned_directory_write_list_and_delete_do_not_follow_late_replacement() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        let j = f.journal();
        let a = account(1);
        let ns = Namespace::from_context(&a);
        let frozen = f.attachment(&j, &a);
        let directory = blob_files::Directory::open(&j.store, &ns, false).unwrap();
        let original = blob_dir(&j.store, &ns);
        let moved = original.with_file_name("pinned-original");
        fs::rename(&original, &moved).unwrap();
        let outside = f.0.join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join(&frozen.dto.content_sha256), b"must remain").unwrap();
        symlink(&outside, &original).unwrap();
        directory.write_atomic("new-blob", b"anchored").unwrap();
        assert!(directory.names().unwrap().contains(&"new-blob".to_string()));
        directory.remove(&frozen.dto.content_sha256).unwrap();
        assert_eq!(fs::read(moved.join("new-blob")).unwrap(), b"anchored");
        assert_eq!(
            fs::read(outside.join(&frozen.dto.content_sha256)).unwrap(),
            b"must remain"
        );
        assert!(!outside.join("new-blob").exists());
    }
    #[test]
    fn migration_process_abort_reopens_atomically_at_each_durability_boundary() {
        const CHILD_ROOT: &str = "VBK_LEASE_MIGRATION_CHILD_ROOT";
        const CHILD_POINT: &str = "VBK_LEASE_MIGRATION_CHILD_POINT";
        if let Ok(root) = std::env::var(CHILD_ROOT) {
            let fixture = Fixture(root.into());
            let journal = fixture.journal();
            let legacy = fixture.legacy();
            let point = match std::env::var(CHILD_POINT).unwrap().as_str() {
                "0" => FailPoint::BeforeSyncAll,
                "1" => FailPoint::BeforeRename,
                "2" => FailPoint::BeforeSyncDir,
                _ => panic!("invalid crash test point"),
            };
            let _fault = hooks::inject(
                &journal
                    .store
                    .namespace_dir(&Namespace::from_context(&account(1))),
                point,
                FaultAction::Abort,
                0,
                Some(1),
            );
            let _ = journal.load_drafts(&account(1), &legacy);
            panic!("abort hook did not fire");
        }
        for index in 0..3 {
            let fixture = Fixture::new();
            let legacy = fixture.legacy();
            let a = account(1);
            let ns = Namespace::from_context(&a);
            DraftBook::save(&legacy, &ns, "room", "durable legacy text", 0).unwrap();
            let before = fs::read(legacy.namespace_dir(&ns).join("state.json")).unwrap();
            let result = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "attachment_leases::tests::migration_process_abort_reopens_atomically_at_each_durability_boundary", "--nocapture"])
                .env(CHILD_ROOT, &fixture.0).env(CHILD_POINT, index.to_string()).output().unwrap();
            assert!(
                !result.status.success(),
                "child must abort at the injected durability boundary"
            );
            #[cfg(unix)]
            {
                use std::os::unix::process::ExitStatusExt;
                assert_eq!(result.status.signal(), Some(libc::SIGABRT));
            }
            let journal = fixture.journal();
            assert_eq!(
                journal.load_drafts(&a, &legacy).unwrap()[0].text,
                "durable legacy text"
            );
            journal
                .save_draft_text(&a, "room", "after recovery", 1, &legacy)
                .unwrap();
            assert_eq!(
                journal.load_drafts(&a, &legacy).unwrap()[0].text,
                "after recovery"
            );
            assert_eq!(
                fs::read(legacy.namespace_dir(&ns).join("state.json")).unwrap(),
                before
            );
        }
    }
    #[cfg(unix)]
    #[test]
    fn metadata_namespace_symlink_cannot_read_write_lock_or_ack_outside_store() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let journal = fixture.journal();
        let legacy = fixture.legacy();
        let a = account(1);
        let ns = Namespace::from_context(&a);
        DraftBook::save(&legacy, &ns, "room", "legacy text", 0).unwrap();
        let namespace = journal.store.namespace_dir(&ns);
        fs::create_dir_all(namespace.parent().unwrap()).unwrap();
        let outside = fixture.0.join("outside");
        fs::create_dir(&outside).unwrap();
        symlink(&outside, &namespace).unwrap();
        assert!(journal.load_drafts(&a, &legacy).is_err());
        assert!(journal.store.get(&ns, MIGRATIONS, MIGRATION).is_err());
        assert!(journal.store.logout_lock(&ns).is_err());
        assert!(journal.store.unlock_after_reauth(&ns).is_err());
        assert!(journal.store.acknowledge_corruption(&ns).is_err());
        assert!(journal.store.sync_namespace(&ns).is_err());
        assert_eq!(fs::read_dir(outside).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn metadata_bound_commit_read_and_remove_survive_namespace_path_replacement() {
        use core_store::file::{NamespaceDirectory, NamespaceIo};
        use std::{
            io,
            path::{Path, PathBuf},
            sync::atomic::{AtomicBool, Ordering},
        };
        #[derive(Debug)]
        struct ReplacingProvider {
            inner: SafeNamespaceIo,
            namespace: PathBuf,
            moved: PathBuf,
            outside: PathBuf,
            armed: AtomicBool,
        }
        impl NamespaceIo for ReplacingProvider {
            fn directory(
                &self,
                path: &Path,
                create: bool,
            ) -> io::Result<Box<dyn NamespaceDirectory>> {
                let capability = NamespaceIo::directory(&self.inner, path, create)?;
                if create && path == self.namespace && self.armed.swap(false, Ordering::SeqCst) {
                    fs::rename(&self.namespace, &self.moved)?;
                    std::os::unix::fs::symlink(&self.outside, &self.namespace)?;
                }
                Ok(capability)
            }
            fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
                NamespaceIo::rename(&self.inner, from, to)
            }
        }
        let fixture = Fixture::new();
        let journal = fixture.journal();
        let a = account(1);
        let ns = Namespace::from_context(&a);
        DraftBook::save(&journal.store, &ns, "room", "old", 0).unwrap();
        let namespace = journal.store.namespace_dir(&ns);
        let moved = namespace.with_file_name("moved-original");
        let outside = fixture.0.join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("state.json"), b"external sentinel").unwrap();
        let provider = ReplacingProvider {
            inner: SafeNamespaceIo::new(journal.store.root()).unwrap(),
            namespace: namespace.clone(),
            moved: moved.clone(),
            outside: outside.clone(),
            armed: AtomicBool::new(true),
        };
        let bound = NamespaceIo::directory(&provider.inner, &namespace, false).unwrap();
        let store = FileStore::open(journal.store.root())
            .unwrap()
            .with_namespace_io(Arc::new(provider));
        // The actual atomic commit remains in the original directory. Its
        // post-commit cleanup refuses the substituted path and reports error.
        assert!(DraftBook::save(&store, &ns, "room", "new", 1).is_err());
        let mut stored = String::new();
        bound
            .open_file("state.json", false)
            .unwrap()
            .read_to_string(&mut stored)
            .unwrap();
        assert!(stored.contains("new"));
        assert_eq!(
            fs::read(outside.join("state.json")).unwrap(),
            b"external sentinel"
        );
        bound.remove("state.json").unwrap();
        assert!(!moved.join("state.json").exists());
        assert!(outside.join("state.json").exists());
    }

    #[cfg(unix)]
    #[test]
    fn metadata_quarantine_and_leaf_markers_cannot_redirect_io() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let journal = fixture.journal();
        let a = account(1);
        let ns = Namespace::from_context(&a);
        DraftBook::save(&journal.store, &ns, "room", "original", 0).unwrap();
        let namespace = journal.store.namespace_dir(&ns);
        let outside = fixture.0.join("outside");
        fs::create_dir(&outside).unwrap();
        symlink(&outside, namespace.join("quarantine")).unwrap();
        fs::write(namespace.join("state.json"), b"corrupt").unwrap();
        assert!(journal.store.get(&ns, "drafts", "room").is_err());
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
        fs::remove_file(namespace.join("quarantine")).unwrap();
        assert!(journal.store.get(&ns, "drafts", "room").is_err());
        assert_eq!(journal.store.quarantined_files(&ns).unwrap().len(), 1);
        journal.store.acknowledge_corruption(&ns).unwrap();
        journal.store.logout_lock(&ns).unwrap();
        journal.store.unlock_after_reauth(&ns).unwrap();
        let sentinel = outside.join("sentinel");
        fs::write(&sentinel, b"external sentinel").unwrap();
        symlink(&sentinel, namespace.join("logout.lock")).unwrap();
        assert!(journal.store.is_locked(&ns).is_err());
        journal.store.unlock_after_reauth(&ns).unwrap();
        assert_eq!(fs::read(&sentinel).unwrap(), b"external sentinel");
    }

    #[test]
    fn command_start_baseline_preserves_edits_during_async_staging() {
        for initially_selected in [false, true] {
            let fixture = Fixture::new();
            let journal = fixture.journal();
            let legacy = fixture.legacy();
            let a = account(1);
            let frozen = fixture.attachment(&journal, &a);
            let lease_id = frozen.dto.lease_id.clone().unwrap();
            let initial_version = if initially_selected {
                journal
                    .set_draft_attachment(&a, "room", Some(&lease_id), 0, &legacy)
                    .unwrap()
            } else {
                0
            };
            let captured = journal.capture_media_draft_version(&a, &frozen).unwrap();
            assert_eq!(captured, initially_selected.then_some(initial_version));
            let newer_version = journal
                .set_draft_attachment(&a, "room", Some(&lease_id), initial_version, &legacy)
                .unwrap();
            journal
                .reserve_media_attachment_captured(&a, "confirmed", &frozen, captured)
                .unwrap();
            journal
                .advance_media(&a, "confirmed", &frozen.payload(), "body", false)
                .unwrap();
            journal
                .advance_media(&a, "confirmed", &frozen.payload(), "body", true)
                .unwrap();
            journal
                .finish_media(&a, "confirmed", &frozen.payload(), confirmed())
                .unwrap();
            let drafts = journal.load_drafts(&a, &legacy).unwrap();
            assert_eq!(drafts[0].attachment_version, newer_version);
            assert_eq!(drafts[0].attachments.len(), 1);
        }
    }
    #[test]
    fn sixty_four_four_mib_summaries_read_zero_blob_bytes_and_single_gid_isolated() {
        let fixture = Fixture::new();
        let journal = fixture.journal();
        let legacy = fixture.legacy();
        let account = account(1);
        let ns = Namespace::from_context(&account);
        let content = vec![0u8; 4 * 1024 * 1024];
        let hash = media_outbound::sha256(&content);
        let directory = blob_files::Directory::open(&journal.store, &ns, true).unwrap();
        directory.write_atomic(&hash, &content).unwrap();
        let mut transaction = journal.store.begin(&ns).unwrap();
        transaction.put(MIGRATIONS, MIGRATION, JsonValue::string("complete"));
        let mut selected_lease = String::new();
        for index in 0..64 {
            let gid = format!("room-{index}");
            let id = uuid::Uuid::new_v4().to_string();
            if index == 0 {
                selected_lease = id.clone();
            }
            let lease = Lease {
                schema: 1,
                created_ms: media_outbound::now_ms(),
                lease_id: id.clone(),
                environment: account.environment.as_str().into(),
                account_id: account.account_id.as_str().into(),
                gid: gid.clone(),
                name: "four-mib.bin".into(),
                kind: "file".into(),
                mime: "application/octet-stream".into(),
                size: content.len(),
                content_sha256: hash.clone(),
                draft_refs: [gid.clone()].into_iter().collect(),
                outbox_refs: BTreeSet::new(),
            };
            transaction.put(LEASES, &id, encode(&lease).unwrap());
            transaction.put(
                DRAFTS,
                &gid,
                encode(&Draft {
                    gid: gid.clone(),
                    text: String::new(),
                    version: 0,
                    lease_ids: vec![id],
                    attachment_version: 1,
                })
                .unwrap(),
            );
        }
        journal.store.commit(transaction).unwrap();
        VERIFIED_BLOB_BYTES.with(|counter| counter.set(0));
        let started = std::time::Instant::now();
        let drafts = journal.load_drafts(&account, &legacy).unwrap();
        let all_elapsed = started.elapsed();
        assert_eq!(drafts.len(), 64);
        assert!(drafts
            .iter()
            .all(|draft| draft.attachments[0].state == LeaseState::Ready));
        assert_eq!(VERIFIED_BLOB_BYTES.with(|counter| counter.get()), 0);
        let started = std::time::Instant::now();
        let selected = journal
            .load_draft(&account, "room-0", &legacy)
            .unwrap()
            .unwrap();
        let one_elapsed = started.elapsed();
        assert_eq!(selected.attachments[0].lease_id, selected_lease);
        assert_eq!(VERIFIED_BLOB_BYTES.with(|counter| counter.get()), 0);
        eprintln!(
            "64x4MiB summary: all={all_elapsed:?}, single={one_elapsed:?}, verified_blob_bytes=0"
        );
        journal
            .restore_attachment(&account, "room-0", &selected_lease, target())
            .unwrap();
        assert_eq!(
            VERIFIED_BLOB_BYTES.with(|counter| counter.get()),
            content.len()
        );
        // A broken unrelated lease must not affect the single-gid response.
        let mut transaction = journal.store.begin(&ns).unwrap();
        transaction.put(
            DRAFTS,
            "broken",
            JsonValue::string("corrupt unrelated draft"),
        );
        journal.store.commit(transaction).unwrap();
        assert!(journal
            .load_draft(&account, "room-0", &legacy)
            .unwrap()
            .is_some());
    }
}

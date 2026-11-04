//! Local Rust-panic observation, not a general crash detector or recovery claim.
//! Native aborts, process kills and power loss do not reliably run a Rust hook.
//! One fixed-size file holds current/previous-run observations; a second fixed
//! empty file leases the writer slot for the process lifetime. No payload,
//! location, backtrace, identifier, timestamp or user-provided text is stored.
use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::{self, Read},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

const DIRECTORY: &str = "crash-recovery";
const FILE_NAME: &str = "rust-panic.marker";
const TEMPLATE: &[u8; 39] = b"VBK_RUST_PANIC_V1\ncurrent=0\nprevious=u\n";
const CURRENT: usize = b"VBK_RUST_PANIC_V1\ncurrent=".len();
const PREVIOUS: usize = b"VBK_RUST_PANIC_V1\ncurrent=0\nprevious=".len();
static INSTALLED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StartupStatus {
    /// True only when the immediately preceding marked run observed a Rust
    /// panic. False also includes unknown/unobserved exits, not just clean ones.
    pub previous_panic: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Record {
    current: bool,
    previous: Option<bool>,
}
impl Record {
    fn parse(bytes: &[u8]) -> io::Result<Self> {
        if bytes.len() != TEMPLATE.len() {
            return Err(unavailable());
        }
        let current = match bytes[CURRENT] {
            b'0' => false,
            b'1' => true,
            _ => return Err(unavailable()),
        };
        let previous = match bytes[PREVIOUS] {
            b'0' => Some(false),
            b'1' => Some(true),
            b'u' => None,
            _ => return Err(unavailable()),
        };
        let mut expected = *TEMPLATE;
        expected[CURRENT] = bytes[CURRENT];
        expected[PREVIOUS] = bytes[PREVIOUS];
        if bytes != expected {
            return Err(unavailable());
        }
        Ok(Self { current, previous })
    }
    fn bytes(self) -> [u8; TEMPLATE.len()] {
        let mut bytes = *TEMPLATE;
        bytes[CURRENT] = if self.current { b'1' } else { b'0' };
        bytes[PREVIOUS] = match self.previous {
            Some(true) => b'1',
            Some(false) => b'0',
            None => b'u',
        };
        bytes
    }
    fn diagnostic(self) -> String {
        // Reconstruct from strict enum/bool values; never export raw file data.
        format!(
            "schema=rust_panic_observation_v1\ncurrent_run_rust_panic={}\nprevious_run_rust_panic={}\nscope=rust_panic_hook_only\nnative_abort_and_process_kill=not_observed\n",
            if self.current { "observed" } else { "not_observed" },
            match self.previous { Some(true) => "observed", Some(false) => "not_observed", None => "unknown" }
        )
    }
}
fn unavailable() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "crash marker unavailable")
}
fn no_link(meta: &Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return false;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return false;
        } // reparse point/junction
    }
    true
}
fn safe_directory(path: &Path) -> io::Result<()> {
    if !path.is_absolute() {
        return Err(unavailable());
    }
    for ancestor in path.ancestors() {
        let meta = fs::symlink_metadata(ancestor)?;
        if !meta.is_dir() || !no_link(&meta) {
            return Err(unavailable());
        }
    }
    Ok(())
}
fn private_directory(data_dir: &Path, create: bool) -> io::Result<PathBuf> {
    safe_directory(data_dir)?;
    let path = data_dir.join(DIRECTORY);
    if create {
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        match builder.create(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
    }
    safe_directory(&path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if fs::symlink_metadata(&path)?.permissions().mode() & 0o077 != 0 {
            return Err(unavailable());
        }
    }
    // Windows inherits the user's app-data ACL; the directory is never put in
    // a shared temp location. Reparse points are rejected above and on open.
    Ok(path)
}
fn options(write: bool) -> OpenOptions {
    let mut options = OpenOptions::new();
    options.read(true).write(write);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        #[cfg(target_os = "macos")]
        const FLAGS: i32 = 0x100 | 0x4; // O_NOFOLLOW | O_NONBLOCK
        #[cfg(target_os = "linux")]
        const FLAGS: i32 = 0x20000 | 0x800;
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        const FLAGS: i32 = 0;
        options.mode(0o600).custom_flags(FLAGS);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
        options.share_mode(1 | 2); // no delete/rename sharing while the hook owns this file
    }
    options
}
fn regular_private(file: &File) -> io::Result<()> {
    let meta = file.metadata()?;
    if !meta.is_file() || !no_link(&meta) {
        return Err(unavailable());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.nlink() != 1 || meta.mode() & 0o077 != 0 {
            return Err(unavailable());
        }
    }
    Ok(())
}
fn verify_marker_location(file: &File, path: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_file() || !no_link(&meta) {
        return Err(unavailable());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let opened = file.metadata()?;
        if (opened.dev(), opened.ino()) != (meta.dev(), meta.ino()) {
            return Err(unavailable());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
        #[link(name = "kernel32")]
        extern "system" {
            fn GetFinalPathNameByHandleW(
                handle: *mut std::ffi::c_void,
                path: *mut u16,
                length: u32,
                flags: u32,
            ) -> u32;
        }
        let mut buffer = vec![0u16; 32768];
        // SAFETY: File owns a live handle and buffer has the declared writable
        // UTF-16 capacity. This bounded check runs at startup/export, not in hook.
        let length = unsafe {
            GetFinalPathNameByHandleW(
                file.as_raw_handle(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                0,
            )
        };
        if length == 0 || length as usize >= buffer.len() {
            return Err(unavailable());
        }
        buffer.truncate(length as usize);
        let opened = PathBuf::from(std::ffi::OsString::from_wide(&buffer));
        if opened != fs::canonicalize(path)? {
            return Err(unavailable());
        }
    }
    Ok(())
}
fn read_record(file: &File) -> io::Result<Record> {
    regular_private(file)?;
    if file.metadata()?.len() != TEMPLATE.len() as u64 {
        return Err(unavailable());
    }
    let mut bytes = Vec::with_capacity(TEMPLATE.len() + 1);
    file.take(TEMPLATE.len() as u64 + 1)
        .read_to_end(&mut bytes)?;
    Record::parse(&bytes)
}
fn write_at(file: &File, bytes: &[u8], offset: u64) -> io::Result<usize> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileExt;
        file.write_at(bytes, offset)
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileExt;
        file.seek_write(bytes, offset)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (file, bytes, offset);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "crash markers unsupported",
        ))
    }
}
fn write_record(file: &File, record: Record) -> io::Result<()> {
    let bytes = record.bytes();
    let mut offset = 0;
    // Bounded by the fixed record size even when writes are partial.
    while offset < bytes.len() {
        let n = write_at(file, &bytes[offset..], offset as u64)?;
        if n == 0 {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "crash marker write failed",
            ));
        }
        offset += n;
    }
    file.sync_data()
}
struct MarkerWriter {
    file: File,
    recorded: AtomicBool,
    // Never lock inside the panic hook. A separate file keeps Windows' mandatory
    // byte-range locks away from the marker read by user-requested diagnostics.
    _lease: Option<File>,
}
impl MarkerWriter {
    fn record_panic(&self) {
        if self.recorded.swap(true, Ordering::Relaxed) {
            return;
        }
        // No allocation, formatting, payload access, application locks or path
        // lookup. The pre-opened descriptor cannot be redirected by a symlink.
        // An I/O error is ignored, never logged or turned into another panic.
        if write_at(&self.file, b"1", CURRENT as u64).ok() == Some(1) {
            let _ = self.file.sync_data();
        }
    }
}
fn writer_lease(data_dir: &Path, dir: &Path) -> io::Result<File> {
    let path = dir.join("writer.lock");
    let file = match options(true).create_new(true).open(&path) {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
            let meta = fs::symlink_metadata(&path)?;
            if !meta.is_file() || !no_link(&meta) {
                return Err(unavailable());
            }
            options(true).open(&path)?
        }
        Err(e) => return Err(e),
    };
    regular_private(&file)?;
    if file.metadata()?.len() != 0 {
        return Err(unavailable());
    }
    private_directory(data_dir, false)?;
    verify_marker_location(&file, &path)?;
    fs2::FileExt::try_lock_exclusive(&file)?;
    Ok(file)
}
fn prepare(data_dir: &Path) -> io::Result<(MarkerWriter, StartupStatus)> {
    let dir = private_directory(data_dir, true)?;
    let lease = writer_lease(data_dir, &dir)?;
    let path = dir.join(FILE_NAME);
    let (file, previous) = match options(true).create_new(true).open(&path) {
        Ok(file) => (file, None),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
            let meta = fs::symlink_metadata(&path)?;
            if !meta.is_file() || !no_link(&meta) {
                return Err(unavailable());
            }
            let file = options(true).open(&path)?;
            let record = read_record(&file)?;
            (file, Some(record.current))
        }
        Err(e) => return Err(e),
    };
    regular_private(&file)?;
    // Recheck the directory before writing. Fixed-position writes neither
    // truncate nor rename files, and existing content must parse exactly.
    private_directory(data_dir, false)?;
    verify_marker_location(&file, &path)?;
    write_record(
        &file,
        Record {
            current: false,
            previous,
        },
    )?;
    Ok((
        MarkerWriter {
            file,
            recorded: AtomicBool::new(false),
            _lease: Some(lease),
        },
        StartupStatus {
            previous_panic: previous == Some(true),
        },
    ))
}

/// Call once, early in app setup, after its app-data directory exists.
/// Failure is nonfatal; log only a fixed message. Replaces (does not chain) the
/// old hook because it may log payloads/backtraces or take poisoned app locks.
/// Export does not clear this file. On startup, current becomes previous;
/// absence of a Rust panic observation never proves a clean process exit.
pub fn install(data_dir: &Path) -> io::Result<StartupStatus> {
    if std::thread::panicking() {
        return Err(unavailable());
    }
    if INSTALLED
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "crash hook already installed",
        ));
    }
    let (writer, status) = match prepare(data_dir) {
        Ok(prepared) => prepared,
        Err(e) => {
            INSTALLED.store(false, Ordering::Release);
            return Err(e);
        }
    };
    std::panic::set_hook(Box::new(move |_info| writer.record_panic()));
    Ok(status)
}

/// User-requested diagnostics only. All bytes must match the fixed schema;
/// callers should omit corrupt/unavailable markers, never copy raw contents.
pub(crate) fn diagnostic_metadata(data_dir: &Path) -> io::Result<Option<String>> {
    let dir = match private_directory(data_dir, false) {
        Ok(dir) => dir,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let path = dir.join(FILE_NAME);
    let meta = match fs::symlink_metadata(&path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    if !meta.is_file() || !no_link(&meta) {
        return Err(unavailable());
    }
    let file = options(false).open(&path)?;
    let record = read_record(&file)?;
    private_directory(data_dir, false)?;
    verify_marker_location(&file, &path)?;
    Ok(Some(record.diagnostic()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            // macOS /var is itself a symlink; resolve the OS-selected temp root
            // before creating our fixture, never normalize untrusted markers.
            let path = std::env::temp_dir()
                .canonicalize()
                .unwrap()
                .join(format!("vbk-crash-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn marker(&self) -> PathBuf {
            self.0.join(DIRECTORY).join(FILE_NAME)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn fixed_schema_is_strict_and_cannot_carry_payloads() {
        for current in [false, true] {
            for previous in [None, Some(false), Some(true)] {
                let record = Record { current, previous };
                assert_eq!(Record::parse(&record.bytes()).unwrap(), record);
                let text = record.diagnostic();
                assert!(
                    core_diag::scan::scan_bytes("crash-recovery.txt", text.as_bytes()).is_clean()
                );
            }
        }
        for bad in [
            b"".as_slice(),
            b"cookie=SECRET_COOKIE",
            &TEMPLATE[..TEMPLATE.len() - 1],
        ] {
            assert!(Record::parse(bad).is_err());
        }
        let mut extra = TEMPLATE.to_vec();
        extra.extend_from_slice(b"\ntoken=PRIVATE_TOKEN");
        assert!(Record::parse(&extra).is_err());
        let mut unknown = *TEMPLATE;
        unknown[PREVIOUS] = b'x';
        assert!(Record::parse(&unknown).is_err());
        let mut unknown = *TEMPLATE;
        unknown[CURRENT] = b'u';
        assert!(Record::parse(&unknown).is_err());
    }

    #[test]
    fn previous_observation_rotates_once_per_startup_and_export_never_clears_it() {
        let root = Temp::new();
        let (writer, first) = prepare(&root.0).unwrap();
        assert!(!first.previous_panic);
        assert_eq!(fs::read(root.marker()).unwrap(), *TEMPLATE);
        writer.record_panic();
        drop(writer);
        let (writer, status) = prepare(&root.0).unwrap();
        assert!(status.previous_panic);
        let report = diagnostic_metadata(&root.0).unwrap().unwrap();
        assert!(report.contains("current_run_rust_panic=not_observed"));
        assert!(report.contains("previous_run_rust_panic=observed"));
        assert_eq!(diagnostic_metadata(&root.0).unwrap().unwrap(), report);
        drop(writer);
        let (_writer, status) = prepare(&root.0).unwrap();
        assert!(!status.previous_panic);
        assert!(diagnostic_metadata(&root.0)
            .unwrap()
            .unwrap()
            .contains("previous_run_rust_panic=not_observed"));
    }

    #[test]
    fn concurrent_and_repeated_panics_cannot_grow_the_file_or_copy_private_data() {
        let root = Temp::new();
        let (writer, _) = prepare(&root.0).unwrap();
        let writer = std::sync::Arc::new(writer);
        let threads: Vec<_> = (0..16)
            .map(|_| {
                let writer = writer.clone();
                std::thread::spawn(move || {
                    for _ in 0..100 {
                        writer.record_panic();
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        let bytes = fs::read(root.marker()).unwrap();
        assert_eq!(bytes.len(), TEMPLATE.len());
        assert_eq!(
            Record::parse(&bytes).unwrap(),
            Record {
                current: true,
                previous: None
            }
        );
        assert_eq!(fs::read_dir(root.0.join(DIRECTORY)).unwrap().count(), 2);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(root.0.join(DIRECTORY))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(root.marker()).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn corrupt_and_oversized_markers_are_bounded_and_left_untouched() {
        let root = Temp::new();
        drop(prepare(&root.0).unwrap());
        for data in [
            vec![],
            TEMPLATE[..12].to_vec(),
            vec![b'x'; TEMPLATE.len() + 1],
            vec![b'x'; 1024 * 1024],
            b"cookie=SECRET_COOKIE token=PRIVATE_TOKEN\n".to_vec(),
            vec![0xff; TEMPLATE.len()],
        ] {
            fs::write(root.marker(), &data).unwrap();
            assert!(prepare(&root.0).is_err());
            assert!(diagnostic_metadata(&root.0).is_err());
            assert_eq!(fs::read(root.marker()).unwrap(), data);
        }
    }

    #[test]
    fn absent_markers_are_not_reported_as_a_clean_exit_and_io_failure_never_panics() {
        let root = Temp::new();
        assert_eq!(diagnostic_metadata(&root.0).unwrap(), None);
        drop(prepare(&root.0).unwrap());
        // Inject a read-only descriptor into the same pure hook writer. It must
        // swallow the write failure and subsequent calls without taking locks.
        let writer = MarkerWriter {
            file: options(false).open(root.marker()).unwrap(),
            recorded: AtomicBool::new(false),
            _lease: None,
        };
        writer.record_panic();
        writer.record_panic();
        assert!(
            !Record::parse(&fs::read(root.marker()).unwrap())
                .unwrap()
                .current
        );
        assert!(diagnostic_metadata(&root.0)
            .unwrap()
            .unwrap()
            .contains("native_abort_and_process_kill=not_observed"));
    }

    #[cfg(unix)]
    #[test]
    fn symlink_directories_files_ancestors_and_hardlinks_are_rejected_without_touching_targets() {
        use std::os::unix::fs::symlink;
        let root = Temp::new();
        let outside = Temp::new();
        symlink(&outside.0, root.0.join(DIRECTORY)).unwrap();
        assert!(prepare(&root.0).is_err());
        assert!(diagnostic_metadata(&root.0).is_err());
        assert_eq!(fs::read_dir(&outside.0).unwrap().count(), 0);
        fs::remove_file(root.0.join(DIRECTORY)).unwrap();
        drop(prepare(&root.0).unwrap());
        fs::remove_file(root.marker()).unwrap();
        let target = outside.0.join("private");
        fs::write(&target, b"cookie=SECRET_COOKIE").unwrap();
        symlink(&target, root.marker()).unwrap();
        assert!(prepare(&root.0).is_err());
        assert!(diagnostic_metadata(&root.0).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"cookie=SECRET_COOKIE");
        fs::remove_file(root.marker()).unwrap();
        fs::hard_link(&target, root.marker()).unwrap();
        assert!(prepare(&root.0).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"cookie=SECRET_COOKIE");
        let alias = outside.0.join("alias");
        symlink(&root.0, &alias).unwrap();
        assert!(prepare(&alias).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn preopened_hook_cannot_be_redirected_when_the_directory_is_replaced() {
        use std::os::unix::fs::symlink;
        let root = Temp::new();
        let outside = Temp::new();
        let (writer, _) = prepare(&root.0).unwrap();
        let moved = root.0.join("moved-private-marker");
        fs::rename(root.0.join(DIRECTORY), &moved).unwrap();
        fs::write(outside.0.join(FILE_NAME), b"cookie=SECRET_COOKIE").unwrap();
        symlink(&outside.0, root.0.join(DIRECTORY)).unwrap();
        writer.record_panic();
        assert!(
            Record::parse(&fs::read(moved.join(FILE_NAME)).unwrap())
                .unwrap()
                .current
        );
        assert_eq!(
            fs::read(outside.0.join(FILE_NAME)).unwrap(),
            b"cookie=SECRET_COOKIE"
        );
        assert!(diagnostic_metadata(&root.0).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn insecure_permissions_and_replaced_inode_are_rejected() {
        use std::os::unix::fs::PermissionsExt;
        let root = Temp::new();
        let (writer, _) = prepare(&root.0).unwrap();
        let original = root.0.join(DIRECTORY).join("moved.marker");
        fs::rename(root.marker(), &original).unwrap();
        fs::write(root.marker(), TEMPLATE).unwrap();
        assert!(verify_marker_location(&writer.file, &root.marker()).is_err());
        fs::set_permissions(root.0.join(DIRECTORY), fs::Permissions::from_mode(0o755)).unwrap();
        assert!(prepare(&root.0).is_err());
        assert!(diagnostic_metadata(&root.0).is_err());
    }

    #[test]
    fn panic_hook_child() {
        let Some(root) = std::env::var_os("VBK_CRASH_HOOK_CHILD") else {
            return;
        };
        install(Path::new(&root)).unwrap();
        assert!(install(Path::new(&root)).is_err());
        if std::env::var_os("VBK_CRASH_HOOK_HOLD").is_some() {
            fs::write(Path::new(&root).join("child-ready"), b"ready").unwrap();
            std::io::stdin().read_exact(&mut [0u8; 1]).unwrap();
            return;
        }
        panic!("cookie=SECRET_COOKIE token=PRIVATE_TOKEN user@example.com /Users/private-user/messages 普通聊天正文");
    }
    #[test]
    fn installed_hook_is_exercised_only_in_an_isolated_subprocess_with_privacy_probes() {
        let root = Temp::new();
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "crash_recovery::tests::panic_hook_child",
                "--nocapture",
            ])
            .env("VBK_CRASH_HOOK_CHILD", &root.0)
            .output()
            .unwrap();
        assert!(!output.status.success());
        let bytes = fs::read(root.marker()).unwrap();
        assert_eq!(bytes.len(), TEMPLATE.len());
        assert!(Record::parse(&bytes).unwrap().current);
        let mut captured = output.stdout;
        captured.extend_from_slice(&output.stderr);
        let output = String::from_utf8_lossy(&captured);
        let marker = String::from_utf8_lossy(&bytes);
        for probe in [
            "SECRET_COOKIE",
            "PRIVATE_TOKEN",
            "user@example.com",
            "private-user",
            "普通聊天正文",
        ] {
            assert!(
                !output.contains(probe),
                "hook must not chain the payload-printing default hook"
            );
            assert!(!marker.contains(probe));
        }
        let (_writer, status) = prepare(&root.0).unwrap();
        assert!(status.previous_panic);
        assert!(core_diag::scan::scan_bytes(
            "crash-recovery.txt",
            diagnostic_metadata(&root.0).unwrap().unwrap().as_bytes()
        )
        .is_clean());
    }
    #[test]
    fn competing_process_cannot_rotate_the_live_writer_and_diagnostics_remain_readable() {
        use std::{
            io::Write,
            process::Stdio,
            time::{Duration, Instant},
        };
        let root = Temp::new();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "crash_recovery::tests::panic_hook_child",
                "--nocapture",
            ])
            .env("VBK_CRASH_HOOK_CHILD", &root.0)
            .env("VBK_CRASH_HOOK_HOLD", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !root.0.join("child-ready").exists() {
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("child did not acquire the writer lease");
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let before = fs::read(root.marker()).unwrap();
        let rejected = prepare(&root.0).is_err();
        let after = fs::read(root.marker()).unwrap();
        let readable = diagnostic_metadata(&root.0).unwrap().is_some();
        child.stdin.take().unwrap().write_all(b"x").unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());
        assert!(rejected);
        assert!(readable);
        assert_eq!(before, after);
        // The OS releases the lease at process exit, so a new run can rotate.
        assert!(!prepare(&root.0).unwrap().1.previous_panic);
    }
    #[cfg(unix)]
    #[test]
    fn writer_lease_symlinks_and_nonempty_files_are_rejected_without_marker_mutation() {
        use std::os::unix::fs::symlink;
        let root = Temp::new();
        let outside = Temp::new();
        drop(prepare(&root.0).unwrap());
        let before = fs::read(root.marker()).unwrap();
        let lease = root.0.join(DIRECTORY).join("writer.lock");
        fs::remove_file(&lease).unwrap();
        let secret = outside.0.join("secret");
        fs::write(&secret, b"token=PRIVATE_TOKEN").unwrap();
        symlink(&secret, &lease).unwrap();
        assert!(prepare(&root.0).is_err());
        assert_eq!(fs::read(root.marker()).unwrap(), before);
        assert_eq!(fs::read(&secret).unwrap(), b"token=PRIVATE_TOKEN");
        fs::remove_file(&lease).unwrap();
        fs::write(&lease, b"corrupt lease").unwrap();
        assert!(prepare(&root.0).is_err());
        assert_eq!(fs::read(root.marker()).unwrap(), before);
    }
}

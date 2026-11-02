//! Scoped, read-only Chromium LevelDB reader. Never opens a database, takes its
//! lock, copies a store, writes browser files, or logs credentials. A corrupt or
//! changing store is an error, never permission to recover an obsolete token.
use contracts::AppError;
use core_assistant::SecretString;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, Metadata, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
};

const MAX_FILE: usize = 64 * 1024 * 1024;
const MAX_TOTAL: usize = 256 * 1024 * 1024;
const MAX_RECORD: usize = 16 * 1024 * 1024;
const MAX_FILES: usize = 4096;
const MAX_SEQUENCE: u64 = (1 << 56) - 1;
const MAGIC: u64 = 0xdb4775248b80fb57;
const PREFIX: &[u8] = b"_https://csagent.tsim.tech\0";
type Result<T> = std::result::Result<T, AppError>;

fn unavailable() -> AppError {
    AppError::new(
        "assistant.browser_storage_unavailable",
        "browser session storage unavailable",
    )
}
fn require(condition: bool) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(unavailable())
    }
}

/// Paths stay inside the host; IPC exposes only the opaque id and fixed label.
#[derive(Debug, Clone)]
pub struct BrowserProfile {
    pub id: String,
    pub label: String,
    pub directory: PathBuf,
}

fn no_link(metadata: &Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return false;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return false;
        }
    }
    true
}

// Reject every existing ancestor, not just the leaf: junctions are reparse
// points on Windows and can otherwise redirect a perfectly ordinary filename.
fn safe_directory(path: &Path) -> Result<()> {
    require(path.is_absolute())?;
    for ancestor in path.ancestors() {
        let metadata = fs::symlink_metadata(ancestor).map_err(|_| unavailable())?;
        require(metadata.is_dir() && no_link(&metadata))?;
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn profile_name(name: &str) -> bool {
    name == "Default"
        || name.strip_prefix("Profile ").is_some_and(|n| {
            !n.is_empty()
                && n.len() <= 10
                && n.bytes().all(|b| b.is_ascii_digit())
                && n.parse::<u32>().is_ok()
        })
}

/// Only Windows stable Edge/Chrome default user-data roots are supported.
/// This enumerates directory names; it never reads a browser credential.
pub fn discover_profiles() -> Result<Vec<BrowserProfile>> {
    #[cfg(not(windows))]
    {
        Err(unavailable())
    }
    #[cfg(windows)]
    {
        let local = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .ok_or_else(unavailable)?;
        safe_directory(&local)?;
        let mut profiles = Vec::new();
        for (id, label, relative) in [
            ("edge", "Microsoft Edge", "Microsoft/Edge/User Data"),
            ("chrome", "Google Chrome", "Google/Chrome/User Data"),
        ] {
            let root = local.join(relative);
            match fs::symlink_metadata(&root) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return Err(unavailable()),
                Ok(_) => safe_directory(&root)?,
            }
            for name in directory_names(&root)? {
                if !profile_name(&name) {
                    continue;
                }
                let profile = root.join(&name);
                safe_directory(&profile)?;
                let directory = profile.join("Local Storage").join("leveldb");
                match fs::symlink_metadata(&directory) {
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(_) => return Err(unavailable()),
                    Ok(_) => safe_directory(&directory)?,
                }
                profiles.push(BrowserProfile {
                    id: format!("{id}:{name}"),
                    label: format!("{label} — {name}"),
                    directory,
                });
                require(profiles.len() <= 64)?;
            }
        }
        profiles.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(profiles)
    }
}

/// The caller resolves an id using discovery. Enforce that boundary again here;
/// arbitrary paths, custom profiles and symlinked stores are never accepted.
pub fn read_token(directory: &Path) -> Result<Option<SecretString>> {
    require(
        discover_profiles()?
            .iter()
            .any(|p| p.directory == directory),
    )?;
    for _ in 0..3 {
        if let Ok(token) = attempt(directory) {
            return Ok(token);
        }
    }
    Err(unavailable())
}

struct Cursor<'a> {
    data: &'a [u8],
    offset: usize,
}
impl<'a> Cursor<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, offset: 0 }
    }
    fn byte(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    fn varint(&mut self) -> Result<u64> {
        let mut result = 0u64;
        for i in 0..10 {
            let b = self.byte()?;
            require(i != 9 || b <= 1)?;
            result |= u64::from(b & 127) << (i * 7);
            if b & 128 == 0 {
                return Ok(result);
            }
        }
        Err(unavailable())
    }
    fn number(&mut self, max: usize) -> Result<usize> {
        let value = self.varint()?;
        require(value <= max as u64)?;
        Ok(value as usize)
    }
    fn take(&mut self, length: usize) -> Result<&'a [u8]> {
        require(length <= self.data.len() - self.offset)?;
        let start = self.offset;
        self.offset += length;
        Ok(&self.data[start..self.offset])
    }
    fn slice(&mut self) -> Result<&'a [u8]> {
        let length = self.number(MAX_RECORD)?;
        self.take(length)
    }
    fn done(&self) -> bool {
        self.offset == self.data.len()
    }
}
fn u32le(data: &[u8]) -> u32 {
    u32::from_le_bytes(data[..4].try_into().expect("checked length"))
}
fn u64le(data: &[u8]) -> u64 {
    u64::from_le_bytes(data[..8].try_into().expect("checked length"))
}
const fn crc_table() -> [u32; 256] {
    let mut table = [0; 256];
    let mut index = 0;
    while index < 256 {
        let mut n = index as u32;
        let mut bit = 0;
        while bit < 8 {
            n = (n >> 1) ^ (0x82f63b78 & (0u32.wrapping_sub(n & 1)));
            bit += 1;
        }
        table[index] = n;
        index += 1;
    }
    table
}
const CRC_TABLE: [u32; 256] = crc_table();
fn checksum(parts: &[&[u8]]) -> u32 {
    let mut crc = !0u32;
    for data in parts {
        for byte in *data {
            crc = CRC_TABLE[((crc ^ u32::from(*byte)) & 255) as usize] ^ (crc >> 8);
        }
    }
    (!crc).rotate_right(15).wrapping_add(0xa282ead8)
}

fn log_records(data: &[u8], mut visit: impl FnMut(&[u8]) -> Result<()>) -> Result<()> {
    let mut offset = 0;
    let mut fragments: Option<Vec<u8>> = None;
    while offset < data.len() {
        let remaining = 32768 - offset % 32768;
        if remaining < 7 {
            let length = remaining.min(data.len() - offset);
            require(data[offset..offset + length].iter().all(|b| *b == 0))?;
            offset += length;
            continue;
        }
        // Even a torn final header may hide a newer deletion.
        require(data.len() - offset >= 7)?;
        let crc = u32le(&data[offset..]);
        let size = u16::from_le_bytes(data[offset + 4..offset + 6].try_into().unwrap()) as usize;
        let kind = data[offset + 6];
        require(
            size + 7 <= remaining && size + 7 <= data.len() - offset && (1..=4).contains(&kind),
        )?;
        let body = &data[offset + 7..offset + 7 + size];
        require(checksum(&[&[kind], body]) == crc)?;
        offset += 7 + size;
        if kind == 1 {
            require(fragments.is_none() && size <= MAX_RECORD)?;
            visit(body)?;
            continue;
        }
        if kind == 2 {
            require(fragments.is_none())?;
            fragments = Some(Vec::new());
        }
        let buffer = fragments.as_mut().ok_or_else(unavailable)?;
        require(size <= MAX_RECORD - buffer.len())?;
        buffer.extend_from_slice(body);
        if kind == 4 {
            visit(buffer)?;
            fragments = None;
        }
    }
    require(fragments.is_none())
}

fn snappy(data: &[u8]) -> Result<Vec<u8>> {
    let mut c = Cursor::new(data);
    let size = c.number(MAX_RECORD)?;
    let mut result = Vec::with_capacity(size);
    while !c.done() {
        let tag = c.byte()?;
        if tag & 3 == 0 {
            let n = (tag >> 2) as usize;
            let length = if n < 60 {
                n + 1
            } else {
                let mut value = 0u64;
                for (i, b) in c.take(n - 59)?.iter().enumerate() {
                    value |= u64::from(*b) << (i * 8);
                }
                require(value < size as u64)?;
                value as usize + 1
            };
            require(length <= size - result.len())?;
            result.extend_from_slice(c.take(length)?);
            continue;
        }
        let (length, distance) = match tag & 3 {
            1 => (
                4 + ((tag >> 2) & 7) as usize,
                (usize::from(tag & 0xe0) << 3) | usize::from(c.byte()?),
            ),
            2 => (
                1 + (tag >> 2) as usize,
                u16::from_le_bytes(c.take(2)?.try_into().unwrap()) as usize,
            ),
            _ => (1 + (tag >> 2) as usize, u32le(c.take(4)?) as usize),
        };
        require(distance > 0 && distance <= result.len() && length <= size - result.len())?;
        for _ in 0..length {
            result.push(result[result.len() - distance]);
        }
    }
    require(result.len() == size)?;
    Ok(result)
}

fn block_entries(data: &[u8], mut visit: impl FnMut(&[u8], &[u8]) -> Result<()>) -> Result<()> {
    require(data.len() >= 8)?;
    let count = u32le(&data[data.len() - 4..]) as usize;
    require(count >= 1 && count <= (data.len() - 4) / 4)?;
    let end = data.len() - 4 - count * 4;
    let mut restarts = BTreeSet::new();
    let mut previous_restart = None;
    for i in 0..count {
        let restart = u32le(&data[end + i * 4..]) as usize;
        require(
            (i != 0 || restart == 0)
                && previous_restart.map_or(true, |p| restart > p)
                && restart <= end
                && (restart != end || end == 0),
        )?;
        restarts.insert(restart);
        previous_restart = Some(restart);
    }
    let mut c = Cursor::new(&data[..end]);
    let mut previous = Vec::new();
    while !c.done() {
        let start = c.offset;
        let shared = c.number(MAX_RECORD)?;
        let nonshared = c.number(MAX_RECORD)?;
        let length = c.number(MAX_RECORD)?;
        require(
            shared <= previous.len()
                && shared + nonshared <= MAX_RECORD
                && (!restarts.contains(&start) || shared == 0),
        )?;
        restarts.remove(&start);
        previous.truncate(shared);
        previous.extend_from_slice(c.take(nonshared)?);
        visit(&previous, c.take(length)?)?;
    }
    if end == 0 {
        restarts.remove(&0);
    }
    require(restarts.is_empty())
}

fn internal_key(key: &[u8]) -> Result<(&[u8], u64, u8)> {
    require(key.len() >= 8)?;
    let tag = u64le(&key[key.len() - 8..]);
    let kind = tag as u8;
    require(kind <= 1)?;
    Ok((&key[..key.len() - 8], tag >> 8, kind))
}
fn compare_internal(a: &[u8], b: &[u8]) -> Result<std::cmp::Ordering> {
    let (x, xs, xt) = internal_key(a)?;
    let (y, ys, yt) = internal_key(b)?;
    Ok(x.cmp(y)
        .then_with(|| ((ys << 8) | u64::from(yt)).cmp(&((xs << 8) | u64::from(xt)))))
}
struct Table {
    number: u64,
    size: usize,
    smallest: Vec<u8>,
    largest: Vec<u8>,
    level: usize,
}
#[derive(Default)]
struct Version {
    tables: BTreeMap<u64, Table>,
    log: u64,
    previous_log: u64,
    sequence: u64,
}
fn manifest(data: &[u8]) -> Result<Version> {
    let mut version = Version::default();
    let (mut has_log, mut has_sequence, mut has_comparator) = (false, false, false);
    log_records(data, |record| {
        let mut c = Cursor::new(record);
        while !c.done() {
            match c.number(9)? {
                1 => {
                    require(c.slice()? == b"leveldb.BytewiseComparator")?;
                    has_comparator = true;
                }
                2 => {
                    version.log = c.varint()?;
                    has_log = true;
                }
                3 => {
                    c.varint()?;
                }
                4 => {
                    let n = c.varint()?;
                    require(n <= MAX_SEQUENCE && n >= version.sequence)?;
                    version.sequence = n;
                    has_sequence = true;
                }
                5 => {
                    c.number(6)?;
                    internal_key(c.slice()?)?;
                }
                6 => {
                    let level = c.number(6)?;
                    let number = c.varint()?;
                    require(
                        version
                            .tables
                            .get(&number)
                            .map_or(true, |t| t.level == level),
                    )?;
                    version.tables.remove(&number);
                }
                7 => {
                    let level = c.number(6)?;
                    let number = c.varint()?;
                    let size = c.number(MAX_FILE)?;
                    let smallest = c.slice()?.to_vec();
                    let largest = c.slice()?.to_vec();
                    require(
                        number != 0
                            && size >= 48
                            && !version.tables.contains_key(&number)
                            && !compare_internal(&smallest, &largest)?.is_gt(),
                    )?;
                    version.tables.insert(
                        number,
                        Table {
                            number,
                            size,
                            smallest,
                            largest,
                            level,
                        },
                    );
                    require(version.tables.len() <= MAX_FILES)?;
                }
                9 => version.previous_log = c.varint()?,
                _ => return Err(unavailable()),
            }
        }
        Ok(())
    })?;
    require(has_log && has_sequence && has_comparator)?;
    Ok(version)
}

#[derive(Default)]
struct Target {
    current: Option<(u64, Option<Vec<u8>>)>,
}
impl Target {
    fn add(&mut self, key: &[u8], sequence: u64, kind: u8, value: &[u8]) -> Result<()> {
        let Some(suffix) = key.strip_prefix(PREFIX) else {
            return Ok(());
        };
        let ascii = suffix.first() == Some(&1) && &suffix[1..] == b"agent_token";
        let utf16 =
            suffix.first() == Some(&0) && &suffix[1..] == b"a\0g\0e\0n\0t\0_\0t\0o\0k\0e\0n\0";
        if !ascii && !utf16 {
            return Ok(());
        }
        require(value.len() <= 32769)?;
        let next = if kind == 0 {
            None
        } else {
            Some(value.to_vec())
        };
        if let Some((old_sequence, old)) = &self.current {
            require(sequence != *old_sequence || old == &next)?;
        }
        if self.current.as_ref().map_or(true, |(s, _)| sequence > *s) {
            self.current = Some((sequence, next));
        }
        Ok(())
    }
    fn token(self) -> Option<SecretString> {
        let value = self.current?.1?;
        if value.len() < 2 {
            return None;
        }
        let result = match value[0] {
            1 => {
                if !value[1..].iter().all(|b| (0x21..=0x7e).contains(b)) {
                    return None;
                }
                String::from_utf8(value[1..].to_vec()).ok()?
            }
            0 if value.len() % 2 == 1 => {
                let mut s = String::new();
                for bytes in value[1..].chunks_exact(2) {
                    let unit = u16::from_le_bytes(bytes.try_into().ok()?);
                    if !(0x21..=0x7e).contains(&unit) {
                        return None;
                    }
                    s.push(char::from_u32(u32::from(unit))?);
                }
                s
            }
            _ => return None,
        };
        if result.is_empty() || result.len() > 16384 {
            None
        } else {
            Some(SecretString::new(result))
        }
    }
}

fn handle(c: &mut Cursor<'_>) -> Result<(usize, usize)> {
    Ok((c.number(MAX_FILE)?, c.number(MAX_RECORD)?))
}
fn table_contents(
    data: &[u8],
    meta: &Table,
    target: &mut Target,
    last_sequence: u64,
    budget: &mut usize,
) -> Result<()> {
    require(data.len() == meta.size && data.len() >= 48)?;
    require(u64le(&data[data.len() - 8..]) == MAGIC)?;
    let mut footer = Cursor::new(&data[data.len() - 48..data.len() - 8]);
    let meta_handle = handle(&mut footer)?;
    let index_handle = handle(&mut footer)?;
    require(
        meta_handle.0 + meta_handle.1 + 5 <= index_handle.0
            && index_handle.0 + index_handle.1 + 5 <= data.len() - 48,
    )?;
    let padding = 40 - footer.offset;
    require(footer.take(padding)?.iter().all(|b| *b == 0))?;
    let mut read_block = |(offset, length): (usize, usize)| -> Result<Vec<u8>> {
        require(
            data.len() >= 53 && offset <= data.len() - 53 && length <= data.len() - 53 - offset,
        )?;
        let bytes = &data[offset..offset + length];
        let compression = data[offset + length];
        require(checksum(&[bytes, &[compression]]) == u32le(&data[offset + length + 1..]))?;
        let decoded = match compression {
            0 => bytes.to_vec(),
            1 => snappy(bytes)?,
            _ => return Err(unavailable()),
        };
        require(decoded.len() <= *budget)?;
        *budget -= decoded.len();
        Ok(decoded)
    };
    block_entries(&read_block(meta_handle)?, |_, _| Ok(()))?;
    let mut first: Option<Vec<u8>> = None;
    let mut last: Option<Vec<u8>> = None;
    let mut previous_index: Option<Vec<u8>> = None;
    let mut previous_block_end = 0;
    block_entries(&read_block(index_handle)?, |index_key, value| {
        internal_key(index_key)?;
        if let Some(previous) = &previous_index {
            require(compare_internal(previous, index_key)?.is_lt())?;
        }
        previous_index = Some(index_key.to_vec());
        let mut c = Cursor::new(value);
        let h = handle(&mut c)?;
        require(c.done() && h.0 >= previous_block_end && h.0 + h.1 + 5 <= meta_handle.0)?;
        previous_block_end = h.0 + h.1 + 5;
        block_entries(&read_block(h)?, |key, entry_value| {
            if let Some(previous) = &last {
                require(compare_internal(previous, key)?.is_lt())?;
            }
            require(!compare_internal(key, index_key)?.is_gt())?;
            if first.is_none() {
                first = Some(key.to_vec());
            }
            last = Some(key.to_vec());
            let (user, sequence, kind) = internal_key(key)?;
            require(sequence <= last_sequence && (kind != 0 || entry_value.is_empty()))?;
            target.add(user, sequence, kind, entry_value)
        })
    })?;
    require(
        first.as_deref() == Some(&meta.smallest[..]) && last.as_deref() == Some(&meta.largest[..]),
    )
}

fn write_batch(data: &[u8], target: &mut Target) -> Result<()> {
    require(data.len() >= 12)?;
    let sequence = u64le(data);
    let count = u32le(&data[8..]) as usize;
    require(
        count <= MAX_RECORD / 2
            && sequence <= MAX_SEQUENCE
            && (count == 0 || count as u64 - 1 <= MAX_SEQUENCE - sequence),
    )?;
    let mut c = Cursor::new(&data[12..]);
    for i in 0..count {
        let kind = c.byte()?;
        require(kind <= 1)?;
        let key = c.slice()?;
        let value = if kind == 1 { c.slice()? } else { &[] };
        target.add(key, sequence + i as u64, kind, value)?;
    }
    require(c.done())
}

fn directory_names(path: &Path) -> Result<Vec<String>> {
    safe_directory(path)?;
    let mut names = Vec::new();
    for item in fs::read_dir(path).map_err(|_| unavailable())? {
        require(names.len() < MAX_FILES)?;
        names.push(
            item.map_err(|_| unavailable())?
                .file_name()
                .into_string()
                .map_err(|_| unavailable())?,
        );
    }
    names.sort();
    Ok(names)
}

#[cfg(windows)]
fn signature(file: &File) -> Result<Vec<u64>> {
    use std::os::windows::io::AsRawHandle;
    #[repr(C)]
    #[derive(Default)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct Information {
        attributes: u32,
        creation: FileTime,
        access: FileTime,
        write: FileTime,
        volume: u32,
        size_high: u32,
        size_low: u32,
        links: u32,
        index_high: u32,
        index_low: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct BasicInformation {
        creation: i64,
        access: i64,
        write: i64,
        change: i64,
        attributes: u32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetFileInformationByHandle(handle: *mut std::ffi::c_void, info: *mut Information)
            -> i32;
        fn GetFileInformationByHandleEx(
            handle: *mut std::ffi::c_void,
            class: i32,
            info: *mut std::ffi::c_void,
            length: u32,
        ) -> i32;
    }
    let mut info = Information::default();
    // SAFETY: the live File owns this handle and info has the Windows ABI layout.
    require(unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } != 0)?;
    require(info.attributes & (0x400 | 0x10) == 0)?;
    let mut basic = BasicInformation::default();
    // FileBasicInfo includes NTFS change time (creation time is not ctime).
    // SAFETY: class 0 expects the repr(C) FILE_BASIC_INFO layout above.
    require(
        unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                0,
                (&mut basic as *mut BasicInformation).cast(),
                std::mem::size_of::<BasicInformation>() as u32,
            )
        } != 0,
    )?;
    Ok(vec![
        u64::from(info.volume),
        (u64::from(info.index_high) << 32) | u64::from(info.index_low),
        (u64::from(info.size_high) << 32) | u64::from(info.size_low),
        (u64::from(info.write.high) << 32) | u64::from(info.write.low),
        (u64::from(info.creation.high) << 32) | u64::from(info.creation.low),
        basic.change as u64,
    ])
}

#[cfg(windows)]
fn verify_opened_path(file: &File, path: &Path) -> Result<()> {
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
    // SAFETY: buffer is writable for its declared UTF-16 capacity; File stays live.
    let length = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            0,
        )
    };
    require(length > 0 && (length as usize) < buffer.len())?;
    buffer.truncate(length as usize);
    let opened = PathBuf::from(std::ffi::OsString::from_wide(&buffer));
    let expected = fs::canonicalize(path).map_err(|_| unavailable())?;
    require(opened == expected)
}
#[cfg(unix)]
fn signature(file: &File) -> Result<Vec<u64>> {
    use std::os::unix::fs::MetadataExt;
    let m = file.metadata().map_err(|_| unavailable())?;
    require(m.is_file())?;
    Ok(vec![
        m.dev(),
        m.ino(),
        m.len(),
        m.mtime() as u64,
        m.mtime_nsec() as u64,
        m.ctime() as u64,
        m.ctime_nsec() as u64,
    ])
}
#[cfg(not(any(windows, unix)))]
fn signature(_: &File) -> Result<Vec<u64>> {
    Err(unavailable())
}

fn open_read(path: &Path) -> Result<File> {
    safe_directory(path.parent().ok_or_else(unavailable)?)?;
    let metadata = fs::symlink_metadata(path).map_err(|_| unavailable())?;
    require(metadata.is_file() && no_link(&metadata))?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
                                          // Permit Chrome/Edge's existing writer; never acquire the LevelDB lock.
        options.share_mode(1 | 2 | 4);
    }
    let file = options.open(path).map_err(|_| unavailable())?;
    let opened = file.metadata().map_err(|_| unavailable())?;
    require(opened.is_file() && no_link(&opened))?;
    #[cfg(windows)]
    verify_opened_path(&file, path)?;
    safe_directory(path.parent().ok_or_else(unavailable)?)?;
    Ok(file)
}
struct Snapshot {
    name: String,
    data: Vec<u8>,
    signature: Vec<u64>,
}
fn read_snapshot(
    directory: &Path,
    name: &str,
    limit: usize,
    total: &mut usize,
) -> Result<Snapshot> {
    let mut file = open_read(&directory.join(name))?;
    let before = signature(&file)?;
    let size = file.metadata().map_err(|_| unavailable())?.len();
    require(size <= limit as u64 && size as usize <= MAX_TOTAL - *total)?;
    *total += size as usize;
    let mut data = vec![0; size as usize];
    file.read_exact(&mut data).map_err(|_| unavailable())?;
    require(before == signature(&file)?)?;
    Ok(Snapshot {
        name: name.into(),
        data,
        signature: before,
    })
}
fn verify_snapshot(directory: &Path, snapshot: &Snapshot, total: &mut usize) -> Result<()> {
    let mut file = open_read(&directory.join(&snapshot.name))?;
    require(signature(&file)? == snapshot.signature)?;
    let size = file.metadata().map_err(|_| unavailable())?.len();
    require(
        size == snapshot.data.len() as u64
            && size <= MAX_FILE as u64
            && size as usize <= MAX_TOTAL - *total,
    )?;
    *total += size as usize;
    let mut buffer = [0u8; 65536];
    for chunk in snapshot.data.chunks(buffer.len()) {
        file.read_exact(&mut buffer[..chunk.len()])
            .map_err(|_| unavailable())?;
        require(buffer[..chunk.len()] == *chunk)?;
    }
    require(signature(&file)? == snapshot.signature)
}
fn decimal_number(name: &str, prefix: &str, suffix: &str) -> Option<u64> {
    let digits = name.strip_prefix(prefix)?.strip_suffix(suffix)?;
    if !(6..=20).contains(&digits.len()) || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}
fn attempt(directory: &Path) -> Result<Option<SecretString>> {
    safe_directory(directory)?;
    let mut total = 0;
    let current = read_snapshot(directory, "CURRENT", 256, &mut total)?;
    let current_name = std::str::from_utf8(&current.data).map_err(|_| unavailable())?;
    require(decimal_number(current_name, "MANIFEST-", "\n").is_some())?;
    let descriptor = read_snapshot(
        directory,
        current_name.trim_end_matches('\n'),
        MAX_FILE,
        &mut total,
    )?;
    let version = manifest(&descriptor.data)?;
    let names = directory_names(directory)?;
    let mut logs: Vec<_> = names
        .iter()
        .filter_map(|name| {
            decimal_number(name, "", ".log")
                .filter(|number| *number >= version.log || *number == version.previous_log)
                .map(|number| (number, name))
        })
        .collect();
    require(version.log == 0 || logs.iter().any(|(n, _)| *n >= version.log))?;
    logs.sort_by_key(|(n, _)| *n);
    let mut observed = Vec::new();
    let mut target = Target::default();
    let mut budget = MAX_TOTAL;
    for meta in version.tables.values() {
        let options: Vec<_> = [
            format!("{:06}.ldb", meta.number),
            format!("{:06}.sst", meta.number),
        ]
        .into_iter()
        .filter(|name| names.contains(name))
        .collect();
        require(options.len() == 1)?;
        let snapshot = read_snapshot(directory, &options[0], MAX_FILE, &mut total)?;
        table_contents(
            &snapshot.data,
            meta,
            &mut target,
            version.sequence,
            &mut budget,
        )?;
        observed.push(snapshot);
    }
    for (_, name) in logs {
        let snapshot = read_snapshot(directory, name, MAX_FILE, &mut total)?;
        log_records(&snapshot.data, |record| write_batch(record, &mut target))?;
        observed.push(snapshot);
    }
    verify_snapshot(directory, &current, &mut total)?;
    verify_snapshot(directory, &descriptor, &mut total)?;
    for snapshot in &observed {
        verify_snapshot(directory, snapshot, &mut total)?;
    }
    require(names == directory_names(directory)?)?;
    verify_snapshot(directory, &current, &mut total)?;
    verify_snapshot(directory, &descriptor, &mut total)?;
    Ok(target.token())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn varint(mut n: u64) -> Vec<u8> {
        let mut bytes = Vec::new();
        loop {
            let b = (n & 127) as u8;
            n >>= 7;
            bytes.push(b | if n > 0 { 128 } else { 0 });
            if n == 0 {
                break;
            }
        }
        bytes
    }
    fn slice(value: &[u8]) -> Vec<u8> {
        let mut out = varint(value.len() as u64);
        out.extend_from_slice(value);
        out
    }
    fn key(wide: bool) -> Vec<u8> {
        let mut key = PREFIX.to_vec();
        key.push(if wide { 0 } else { 1 });
        if wide {
            key.extend("agent_token".encode_utf16().flat_map(u16::to_le_bytes));
        } else {
            key.extend_from_slice(b"agent_token");
        }
        key
    }
    fn value(text: &str, wide: bool) -> Vec<u8> {
        let mut out = vec![if wide { 0 } else { 1 }];
        if wide {
            out.extend(text.encode_utf16().flat_map(u16::to_le_bytes));
        } else {
            out.extend_from_slice(text.as_bytes());
        }
        out
    }
    fn record(kind: u8, body: &[u8]) -> Vec<u8> {
        let mut out = checksum(&[&[kind], body]).to_le_bytes().to_vec();
        out.extend_from_slice(&(body.len() as u16).to_le_bytes());
        out.push(kind);
        out.extend_from_slice(body);
        out
    }
    fn batch(sequence: u64, entries: &[(u8, Vec<u8>, Vec<u8>)]) -> Vec<u8> {
        let mut out = sequence.to_le_bytes().to_vec();
        out.extend_from_slice(&(entries.len() as u32).to_le_bytes());
        for (kind, key, value) in entries {
            out.push(*kind);
            out.extend(slice(key));
            if *kind == 1 {
                out.extend(slice(value));
            }
        }
        out
    }
    fn descriptor(log: u64, sequence: u64) -> Vec<u8> {
        let mut out = vec![1];
        out.extend(slice(b"leveldb.BytewiseComparator"));
        out.push(2);
        out.extend(varint(log));
        out.push(4);
        out.extend(varint(sequence));
        out
    }
    fn internal(user: &[u8], sequence: u64, kind: u8) -> Vec<u8> {
        let mut out = user.to_vec();
        out.extend_from_slice(&((sequence << 8) | u64::from(kind)).to_le_bytes());
        out
    }
    fn block(entries: &[(Vec<u8>, Vec<u8>)]) -> Vec<u8> {
        let mut out = Vec::new();
        for (key, value) in entries {
            out.push(0);
            out.extend(varint(key.len() as u64));
            out.extend(varint(value.len() as u64));
            out.extend_from_slice(key);
            out.extend_from_slice(value);
        }
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&1u32.to_le_bytes());
        out
    }
    fn snappy_literal(bytes: &[u8]) -> Vec<u8> {
        let mut out = varint(bytes.len() as u64);
        if !bytes.is_empty() {
            let n = bytes.len() - 1;
            if n < 60 {
                out.push((n << 2) as u8);
            } else {
                out.push(60 << 2);
                out.push(n as u8);
            }
            out.extend_from_slice(bytes);
        }
        out
    }
    fn append_block(table: &mut Vec<u8>, bytes: &[u8], compressed: bool) -> (usize, usize) {
        let bytes = if compressed {
            snappy_literal(bytes)
        } else {
            bytes.to_vec()
        };
        let h = (table.len(), bytes.len());
        let kind = u8::from(compressed);
        table.extend_from_slice(&bytes);
        table.push(kind);
        table.extend_from_slice(&checksum(&[&bytes, &[kind]]).to_le_bytes());
        h
    }
    fn encode_handle(h: (usize, usize)) -> Vec<u8> {
        let mut out = varint(h.0 as u64);
        out.extend(varint(h.1 as u64));
        out
    }
    fn table_fixture(compressed: bool) -> (Vec<u8>, Table) {
        let user = key(false);
        let k = internal(&user, 4, 1);
        let mut out = Vec::new();
        let data = append_block(
            &mut out,
            &block(&[(k.clone(), value("SYNTHETIC_TABLE", false))]),
            compressed,
        );
        let meta = append_block(&mut out, &block(&[]), false);
        let index = append_block(&mut out, &block(&[(k.clone(), encode_handle(data))]), false);
        let mut footer = encode_handle(meta);
        footer.extend(encode_handle(index));
        footer.resize(40, 0);
        footer.extend_from_slice(&MAGIC.to_le_bytes());
        out.extend(footer);
        let metadata = Table {
            number: 2,
            size: out.len(),
            smallest: k.clone(),
            largest: k,
            level: 0,
        };
        (out, metadata)
    }
    struct Fixture(PathBuf, PathBuf);
    impl Fixture {
        fn new() -> Self {
            Self::under(&std::env::temp_dir())
        }
        fn under(root: &Path) -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            // macOS TMPDIR commonly contains /var -> /private/var. Resolve the
            // test root without relaxing the production ancestor-link rejection.
            let root = root.canonicalize().expect("canonical temporary root");
            let path = root.join(format!(
                "vbk-browser-reader-test-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path, root)
        }
        fn put(&self, name: &str, bytes: &[u8]) {
            fs::write(self.0.join(name), bytes).unwrap();
        }
        fn store(&self, wal: &[u8]) {
            self.put("CURRENT", b"MANIFEST-000001\n");
            self.put("MANIFEST-000001", &record(1, &descriptor(3, 4)));
            self.put("000003.log", wal);
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            // Only the uniquely named fixture directory directly under TEMP.
            if self.0.parent() == Some(self.1.as_path())
                && self
                    .0
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("vbk-browser-reader-test-")
            {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn fixture_resolves_symlinked_temporary_root() {
        use std::os::unix::fs::symlink;
        let outer = Fixture::new();
        let real = outer.0.join("real");
        fs::create_dir(&real).expect("real temporary root");
        let alias = outer.0.join("alias");
        symlink(&real, &alias).expect("symlinked temporary root");
        let fixture = Fixture::under(&alias);
        assert_eq!(fixture.0.parent(), Some(real.as_path()));
        assert!(safe_directory(&fixture.0).is_ok());
        let path = fixture.0.clone();
        drop(fixture);
        assert!(!path.exists(), "canonical fixture is cleaned up");
        assert!(
            safe_directory(&alias).is_err(),
            "production still rejects links"
        );
    }

    #[test]
    fn latest_sequence_and_deletion_win_across_encodings() {
        let mut target = Target::default();
        target
            .add(&key(false), 8, 1, &value("SYNTHETIC_OLD", false))
            .unwrap();
        target
            .add(&key(true), 10, 1, &value("SYNTHETIC_NEW", true))
            .unwrap();
        target
            .add(&key(false), 9, 1, &value("SYNTHETIC_MIDDLE", false))
            .unwrap();
        assert_eq!(target.token().unwrap().expose(), "SYNTHETIC_NEW");
        let mut target = Target::default();
        write_batch(
            &batch(
                2,
                &[
                    (1, key(false), value("SYNTHETIC_OLD", false)),
                    (0, key(true), vec![]),
                ],
            ),
            &mut target,
        )
        .unwrap();
        assert!(target.token().is_none());
    }

    #[test]
    fn conflicts_and_invalid_values_never_restore_old_value() {
        let mut target = Target::default();
        target
            .add(&key(false), 1, 1, &value("SYNTHETIC", false))
            .unwrap();
        assert!(target.add(&key(true), 1, 0, &[]).is_err());
        target
            .add(&key(true), 2, 1, &value("has space", false))
            .unwrap();
        assert!(target.token().is_none());
        for invalid in [
            vec![0, 65],
            vec![1, 0],
            vec![1, 127],
            vec![1, 128],
            vec![2, 65],
        ] {
            let mut t = Target::default();
            t.add(&key(false), 1, 1, &invalid).unwrap();
            assert!(t.token().is_none());
        }
        let mut t = Target::default();
        assert!(t.add(&key(false), 0, 1, &vec![1; 32770]).is_err());
    }

    #[test]
    fn log_crc_fragments_and_torn_tail_are_strict() {
        let mut bytes = record(2, b"syn");
        bytes.extend(record(3, b"thet"));
        bytes.extend(record(4, b"ic"));
        let mut records = Vec::new();
        log_records(&bytes, |r| {
            records.push(r.to_vec());
            Ok(())
        })
        .unwrap();
        assert_eq!(records, vec![b"synthetic".to_vec()]);
        for broken in [
            record(2, b"unfinished"),
            record(3, b"middle"),
            record(4, b"last"),
            vec![0; 7],
        ] {
            assert!(log_records(&broken, |_| Ok(())).is_err());
        }
        let mut valid = record(1, b"synthetic");
        valid[0] ^= 1;
        assert!(log_records(&valid, |_| Ok(())).is_err());
        let mut valid = record(1, b"synthetic");
        valid.push(0);
        assert!(log_records(&valid, |_| Ok(())).is_err());
        let body = vec![42; 32754];
        let mut trailer = record(1, &body); // 7 bytes remain: not a trailer.
        trailer.extend_from_slice(&[0; 7]);
        assert!(log_records(&trailer, |_| Ok(())).is_err());
        let body = vec![42; 32755];
        let mut trailer = record(1, &body);
        trailer.extend_from_slice(&[0; 6]);
        log_records(&trailer, |_| Ok(())).unwrap();
        trailer[32767] = 1;
        assert!(log_records(&trailer, |_| Ok(())).is_err());
    }

    #[test]
    fn snappy_literal_all_copy_modes_overlap_and_limits() {
        assert_eq!(
            snappy(&snappy_literal(&vec![b'x'; 61])).unwrap(),
            vec![b'x'; 61]
        );
        for compressed in [
            vec![6, 0, b'a', 5, 1],
            vec![6, 0, b'a', 18, 1, 0],
            vec![6, 0, b'a', 19, 1, 0, 0, 0],
        ] {
            assert_eq!(snappy(&compressed).unwrap(), b"aaaaaa");
        }
        for bad in [
            vec![1, 2, 0, 0],
            vec![1, 0],
            vec![2, 0, b'a'],
            vec![0, 0, b'a'],
            varint(MAX_RECORD as u64 + 1),
        ] {
            assert!(snappy(&bad).is_err());
        }
    }

    #[test]
    fn block_restart_positions_and_lengths_are_validated() {
        let valid = block(&[(b"synthetic".to_vec(), vec![42])]);
        block_entries(&valid, |k, v| {
            assert_eq!(k, b"synthetic");
            assert_eq!(v, [42]);
            Ok(())
        })
        .unwrap();
        let mut bad = valid.clone();
        let end = bad.len();
        bad[end - 8] = 1;
        assert!(block_entries(&bad, |_, _| Ok(())).is_err());
        let mut bad = valid;
        bad[0] = 1;
        assert!(block_entries(&bad, |_, _| Ok(())).is_err());
        assert!(block_entries(&[0; 8], |_, _| Ok(())).is_err());
        block_entries(&block(&[]), |_, _| Ok(())).unwrap();
    }

    #[test]
    fn sst_compressed_and_plain_checksums_and_sequence_bounds() {
        for compressed in [false, true] {
            let (bytes, meta) = table_fixture(compressed);
            let mut target = Target::default();
            table_contents(&bytes, &meta, &mut target, 4, &mut MAX_TOTAL.clone()).unwrap();
            assert_eq!(target.token().unwrap().expose(), "SYNTHETIC_TABLE");
            assert!(table_contents(
                &bytes,
                &meta,
                &mut Target::default(),
                3,
                &mut MAX_TOTAL.clone()
            )
            .is_err());
            assert!(table_contents(&bytes, &meta, &mut Target::default(), 4, &mut 0).is_err());
            let mut corrupt = bytes;
            corrupt[3] ^= 1;
            assert!(table_contents(
                &corrupt,
                &meta,
                &mut Target::default(),
                4,
                &mut MAX_TOTAL.clone()
            )
            .is_err());
        }
    }

    #[test]
    fn manifest_requires_metadata_and_tracks_table_deletion() {
        let (_, meta) = table_fixture(false);
        let mut edit = descriptor(3, 4);
        edit.push(7);
        edit.extend(varint(0));
        edit.extend(varint(2));
        edit.extend(varint(meta.size as u64));
        edit.extend(slice(&meta.smallest));
        edit.extend(slice(&meta.largest));
        assert_eq!(manifest(&record(1, &edit)).unwrap().tables.len(), 1);
        edit.extend_from_slice(&[6, 0, 2]);
        assert!(manifest(&record(1, &edit)).unwrap().tables.is_empty());
        edit.push(4);
        edit.push(3);
        assert!(manifest(&record(1, &edit)).is_err());
        assert!(manifest(&record(1, &[2, 0, 4, 0])).is_err());
        assert!(manifest(&record(1, &[8])).is_err());
    }

    #[test]
    fn varint_batch_and_filename_boundaries() {
        assert_eq!(Cursor::new(&varint(u64::MAX)).varint().unwrap(), u64::MAX);
        assert!(Cursor::new(&[255; 10]).varint().is_err());
        assert!(Cursor::new(&varint(MAX_RECORD as u64 + 1))
            .number(MAX_RECORD)
            .is_err());
        assert!(write_batch(
            &batch(
                MAX_SEQUENCE,
                &[(0, key(false), vec![]), (0, key(false), vec![])]
            ),
            &mut Target::default()
        )
        .is_err());
        write_batch(
            &batch(MAX_SEQUENCE, &[(0, key(false), vec![])]),
            &mut Target::default(),
        )
        .unwrap();
        let mut bad = batch(0, &[]);
        bad.push(1);
        assert!(write_batch(&bad, &mut Target::default()).is_err());
        assert!(profile_name("Default") && profile_name("Profile 2"));
        for bad in [
            "Guest Profile",
            "Profile ../2",
            "Profile ",
            "Profile -1",
            "Profile 99999999999",
        ] {
            assert!(!profile_name(bad));
        }
        assert_eq!(decimal_number("000003.log", "", ".log"), Some(3));
        assert!(decimal_number("../000003.log", "", ".log").is_none());
        assert!(decimal_number("MANIFEST-000001\nextra", "MANIFEST-", "\n").is_none());
    }

    #[test]
    fn synthetic_store_latest_deletion_torn_tail_and_missing_wal() {
        let fixture = Fixture::new();
        let mut wal = record(
            1,
            &batch(5, &[(1, key(false), value("SYNTHETIC_ONLY", false))]),
        );
        fixture.store(&wal);
        assert_eq!(
            attempt(&fixture.0).unwrap().unwrap().expose(),
            "SYNTHETIC_ONLY"
        );
        wal.extend(record(1, &batch(6, &[(0, key(true), vec![])])));
        fixture.put("000003.log", &wal);
        assert!(attempt(&fixture.0).unwrap().is_none());
        wal.push(0);
        fixture.put("000003.log", &wal);
        assert!(attempt(&fixture.0).is_err());
        fs::remove_file(fixture.0.join("000003.log")).unwrap();
        assert!(attempt(&fixture.0).is_err());
    }

    #[test]
    fn selected_sst_and_wal_never_fall_back_after_deletion_or_corruption() {
        let fixture = Fixture::new();
        let (table, meta) = table_fixture(true);
        let mut edit = descriptor(3, 4);
        edit.push(7);
        edit.extend(varint(0));
        edit.extend(varint(meta.number));
        edit.extend(varint(meta.size as u64));
        edit.extend(slice(&meta.smallest));
        edit.extend(slice(&meta.largest));
        fixture.put("CURRENT", b"MANIFEST-000001\n");
        fixture.put("MANIFEST-000001", &record(1, &edit));
        fixture.put("000002.ldb", &table);
        fixture.put("000003.log", &[]);
        assert_eq!(
            attempt(&fixture.0).unwrap().unwrap().expose(),
            "SYNTHETIC_TABLE"
        );
        fixture.put(
            "000003.log",
            &record(1, &batch(5, &[(0, key(true), vec![])])),
        );
        assert!(attempt(&fixture.0).unwrap().is_none());
        fixture.put("000003.log", &[0]);
        assert!(attempt(&fixture.0).is_err());
        fixture.put("000003.log", &[]);
        let mut corrupt = table.clone();
        corrupt[0] ^= 1;
        fixture.put("000002.ldb", &corrupt);
        assert!(attempt(&fixture.0).is_err());
        fixture.put("000002.ldb", &table);
        fixture.put("000002.sst", &table);
        assert!(attempt(&fixture.0).is_err()); // Ambiguous table files are rejected.
    }

    #[test]
    fn stable_reread_rejects_replaced_or_changed_bytes() {
        let fixture = Fixture::new();
        fixture.put("CURRENT", b"synthetic-before");
        let snapshot = read_snapshot(&fixture.0, "CURRENT", 256, &mut 0).unwrap();
        verify_snapshot(&fixture.0, &snapshot, &mut 0).unwrap();
        fixture.put("CURRENT", b"synthetic-after!");
        assert!(verify_snapshot(&fixture.0, &snapshot, &mut 0).is_err());
        assert!(read_snapshot(&fixture.0, "CURRENT", 2, &mut 0).is_err());
        assert!(read_snapshot(&fixture.0, "CURRENT", 256, &mut MAX_TOTAL.clone()).is_err());
        assert!(read_token(&fixture.0).is_err()); // Production entry never accepts a supplied arbitrary path.
    }

    #[cfg(unix)]
    #[test]
    fn symlink_file_and_ancestor_are_rejected() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        fixture.put("source", b"synthetic");
        symlink(fixture.0.join("source"), fixture.0.join("linked")).unwrap();
        assert!(open_read(&fixture.0.join("linked")).is_err());
        fs::create_dir(fixture.0.join("real")).unwrap();
        symlink(fixture.0.join("real"), fixture.0.join("alias")).unwrap();
        assert!(safe_directory(&fixture.0.join("alias")).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_junction_ancestor_is_rejected() {
        use std::os::windows::process::CommandExt;
        let fixture = Fixture::new();
        let real = fixture.0.join("real");
        let alias = fixture.0.join("alias");
        fs::create_dir(&real).unwrap();
        let output = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&alias)
            .arg(&real)
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        eprintln!(
            "synthetic fixture command: cmd.exe /d /c mklink /J {:?} {:?}",
            alias, real
        );
        eprintln!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            output.status.success(),
            "synthetic junction fixture setup failed"
        );
        assert!(!no_link(&fs::symlink_metadata(&alias).unwrap()));
        assert!(safe_directory(&alias).is_err());
        fs::write(real.join("synthetic-file"), b"synthetic").unwrap();
        assert!(open_read(&alias.join("synthetic-file")).is_err());
        fs::remove_dir(&alias).unwrap();
    }
}

//! Local diagnostics. Unregistered fields and legacy text are never persisted.
//! Hashes are stable pseudonyms, not encryption or protection against dictionary attacks.
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};

pub const REDACTED: &str = "<redacted:text>";
#[derive(Clone, Debug)]
pub enum Value<'a> {
    Text(&'a str),
    Count(u64),
    Flag(bool),
}
#[derive(Clone, Debug)]
pub struct Event {
    line: String,
}
impl Event {
    /// `event`, `error_code`, `message_id`, `thread`, and `module` are trusted
    /// metadata: callers must supply reviewed event/code identifiers, never
    /// credentials, customer text, or arbitrary server error messages. Character
    /// validation prevents line injection; it cannot prove semantic provenance.
    pub fn new(event: &str, fields: &[(&str, Value<'_>)]) -> Self {
        let mut line = format!("event={}", code(event));
        for (key, value) in fields.iter().take(32) {
            // Unknown key names may themselves contain private data.
            let safe_key = match *key {
                "account_id" | "buid" | "gid" | "message_id" | "timestamp" | "error_code"
                | "count" | "length" | "thread" | "module" | "url" | "path" => *key,
                _ => "unknown",
            };
            let rendered = match (safe_key, value) {
                ("account_id" | "buid", Value::Text(v)) => account_hash(v),
                ("gid", _) => "<redacted:gid>".into(),
                ("count" | "length" | "timestamp", Value::Count(v)) => v.to_string(),
                ("message_id" | "error_code" | "thread" | "module", Value::Text(v)) => code(v),
                ("url", Value::Text(v)) => sanitize_url(v),
                ("path", Value::Text(v)) => sanitize_path(v),
                (_, Value::Count(_)) => "<redacted:number>".into(),
                (_, Value::Flag(_)) => "<redacted:bool>".into(),
                _ => REDACTED.into(),
            };
            line.push(' ');
            line.push_str(safe_key);
            line.push('=');
            line.push_str(&rendered);
        }
        // Bound individual records, including hostile field sizes.
        line = line.chars().take(512).collect();
        Self { line }
    }
    pub fn legacy() -> Self {
        Self::new("legacy_log", &[("count", Value::Count(1))])
    }
    pub fn as_str(&self) -> &str {
        &self.line
    }
}
fn code(v: &str) -> String {
    if !v.is_empty()
        && v.len() <= 64
        && v.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_:-.".contains(&c))
    {
        v.into()
    } else {
        REDACTED.into()
    }
}
/// Do not retain arbitrary URL path segments: they can contain tickets, names or IDs.
/// The origin is retained only for the known application domains; queries/fragments and
/// credentials are always discarded. Unknown origins and paths are masked.
pub fn sanitize_url(v: &str) -> String {
    let Some(rest) = v.strip_prefix("https://") else {
        return REDACTED.into();
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if matches!(
        authority,
        "m.ctrip.com" | "vbooking.ctrip.com" | "im3.ctrip.com"
    ) {
        format!("https://{authority}/<redacted:path>")
    } else {
        REDACTED.into()
    }
}
/// Filenames can also contain personal information; retain only a known log extension.
pub fn sanitize_path(v: &str) -> String {
    let name = v.rsplit(['/', '\\']).next().unwrap_or("");
    let extension = name.rsplit_once('.').map(|(_, ext)| ext);
    match extension {
        Some("log") => "<dir>/<redacted>.log".into(),
        _ => "<dir>/<redacted>".into(),
    }
}

#[macro_export]
macro_rules! diag_log {
    ($event:expr, { $($key:ident = $value:expr),* $(,)? }) => {
        $crate::Event::new($event, &[$((stringify!($key), $value)),*])
    };
}

/// Includes the active file in both file-count and total byte budgets.
#[derive(Debug)]
pub struct RotatingLog {
    dir: PathBuf,
    max_file: u64,
    files: usize,
    file: File,
    size: u64,
}
impl RotatingLog {
    pub fn open(dir: impl AsRef<Path>) -> io::Result<Self> {
        Self::with_limits(dir, 20 * 1024 * 1024, 10)
    }
    pub fn with_limits(dir: impl AsRef<Path>, max_file: u64, files: usize) -> io::Result<Self> {
        if max_file < 1024 || !(1..=100).contains(&files) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid diagnostic limits",
            ));
        }
        let dir = dir.as_ref().to_path_buf();
        fs::create_dir_all(&dir)?;
        // Remove old managed slices outside the configured budget on every startup.
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            if let Some(index) = entry
                .file_name()
                .to_str()
                .and_then(|n| n.strip_prefix("diag."))
                .and_then(|n| n.strip_suffix(".log"))
                .and_then(|n| n.parse::<usize>().ok())
            {
                if index >= files {
                    fs::remove_file(entry.path())?;
                }
            }
        }
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("diag.0.log"))?;
        let size = file.metadata()?.len();
        let mut log = Self {
            dir,
            max_file,
            files,
            file,
            size,
        };
        // Previous runs may have used larger limits. Remove oversize old slices.
        for index in 1..files {
            let path = log.path(index);
            if fs::metadata(&path)
                .map(|m| m.len() > max_file)
                .unwrap_or(false)
            {
                fs::remove_file(path)?;
            }
        }
        if size > max_file {
            log.file.set_len(0)?;
            log.size = 0;
        }
        Ok(log)
    }
    fn path(&self, n: usize) -> PathBuf {
        self.dir.join(format!("diag.{n}.log"))
    }
    fn rotate(&mut self) -> io::Result<()> {
        self.file.flush()?;
        // Copy instead of renaming open files, for Windows compatibility.
        for index in (1..self.files).rev() {
            let previous = self.path(index - 1);
            let next = self.path(index);
            if previous.exists() {
                fs::copy(previous, next)?;
            }
        }
        self.file.set_len(0)?;
        self.size = 0;
        Ok(())
    }
    pub fn write(&mut self, level: &str, event: &Event) -> io::Result<()> {
        let level = match level {
            "ERROR" | "WARN" | "INFO" | "DEBUG" | "TRACE" => level,
            _ => "INFO",
        };
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let line = format!("{timestamp} {level} {}\n", event.as_str());
        // Refresh after a previous partial write or an external file change.
        self.size = self.file.metadata()?.len();
        if self.size + line.len() as u64 > self.max_file {
            self.rotate()?;
        }
        self.file.write_all(line.as_bytes())?;
        self.file.flush()?;
        self.size += line.len() as u64;
        Ok(())
    }
    pub fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

/// SHA-256, truncated to eight hexadecimal characters (32 bits), per I-10a.
/// Collisions are possible; this must never serve as an authorization/account key.
pub fn account_hash(account: &str) -> String {
    let digest = sha256(account.as_bytes());
    digest[..4].iter().map(|b| format!("{b:02x}")).collect()
}
fn sha256(input: &[u8]) -> [u8; 32] {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h = [
        0x6a09e667u32,
        0xbb67ae85,
        0x3c6ef372,
        0xa54ff53a,
        0x510e527f,
        0x9b05688c,
        0x1f83d9ab,
        0x5be0cd19,
    ];
    let mut data = input.to_vec();
    let bits = (input.len() as u64).wrapping_mul(8);
    data.push(0x80);
    while data.len() % 64 != 56 {
        data.push(0);
    }
    data.extend_from_slice(&bits.to_be_bytes());
    for chunk in data.chunks_exact(64) {
        let mut w = [0u32; 64];
        for (i, bytes) in chunk.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
        }
        for i in 16..64 {
            let x = w[i - 15];
            let y = w[i - 2];
            w[i] = w[i - 16]
                .wrapping_add(x.rotate_right(7) ^ x.rotate_right(18) ^ (x >> 3))
                .wrapping_add(w[i - 7])
                .wrapping_add(y.rotate_right(17) ^ y.rotate_right(19) ^ (y >> 10));
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..64 {
            let t1 = hh
                .wrapping_add(e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25))
                .wrapping_add((e & f) ^ (!e & g))
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let t2 = (a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22))
                .wrapping_add((a & b) ^ (a & c) ^ (b & c));
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (state, v) in h.iter_mut().zip([a, b, c, d, e, f, g, hh]) {
            *state = state.wrapping_add(v);
        }
    }
    let mut out = [0u8; 32];
    for (chunk, v) in out.chunks_exact_mut(4).zip(h) {
        chunk.copy_from_slice(&v.to_be_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static SERIAL: AtomicU64 = AtomicU64::new(0);
    fn temp() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "core-diag-{}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&p).expect("temporary directory");
        p
    }
    #[test]
    fn sha256_published_vectors() {
        for (input, expected) in [
            (
                "",
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            ),
            (
                "abc",
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            ),
            (
                "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
                "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
            ),
        ] {
            let actual: String = sha256(input.as_bytes())
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            assert_eq!(actual, expected);
        }
        assert_eq!(account_hash("abc"), "ba7816bf");
    }
    #[test]
    fn every_sensitive_class_and_unknown_field_is_masked() {
        for index in 0..12 {
            for (key, secret) in [
                ("ticket", format!("synthetic-ticket-{index}")),
                ("cookie", format!("synthetic-cookie-{index}")),
                ("phone", format!("1390000{index:04}")),
                ("order", format!("9876543210{index:04}")),
                ("email", format!("synthetic{index}@example.invalid")),
                ("identity", format!("11010119900101{index:04}")),
                ("customer_name", format!("Synthetic Customer {index}")),
                ("body", format!("private-message-{index}")),
                ("new_unregistered_key", format!("unexpected-secret-{index}")),
            ] {
                let event = Event::new("privacy_test", &[(key, Value::Text(&secret))]);
                assert!(!event.as_str().contains(&secret));
                assert!(event.as_str().contains(REDACTED));
            }
            let account = format!("synthetic-account-{index}");
            let event = Event::new("account", &[("account_id", Value::Text(&account))]);
            assert!(!event.as_str().contains(&account));
            assert!(event.as_str().contains(&account_hash(&account)));
            let url = format!(
                "https://m.ctrip.com/private-person-{index}?ticket=synthetic-ticket-{index}#secret"
            );
            assert_eq!(sanitize_url(&url), "https://m.ctrip.com/<redacted:path>");
            for path in [
                format!("/Users/synthetic-person-{index}/private-{index}.log"),
                format!("C:\\Users\\synthetic-person-{index}\\private-{index}.log"),
            ] {
                assert_eq!(sanitize_path(&path), "<dir>/<redacted>.log");
            }
        }
    }
    #[test]
    fn injection_types_and_spoofed_urls_fail_closed() {
        for url in [
            "https://user:secret@m.ctrip.com/path",
            "https://m.ctrip.com.evil.invalid",
            "https://secret.invalid/",
            "file:///Users/private",
            "https://m.ctrip.com:443/",
            "http://m.ctrip.com/",
        ] {
            assert_eq!(sanitize_url(url), REDACTED);
        }
        let event = Event::new(
            "bad\nevent",
            &[
                ("injected\nsecret", Value::Text("secret")),
                ("count", Value::Text("secret")),
                ("count", Value::Count(5)),
                ("body", Value::Count(123)),
                ("gid", Value::Text("private-group")),
            ],
        );
        assert!(!event.as_str().contains('\n'));
        assert!(!event.as_str().contains("secret"));
        assert!(event.as_str().contains("count=5"));
        assert!(event.as_str().contains("<redacted:number>"));
        assert!(!event.as_str().contains("private-group"));
        assert_eq!(Event::legacy().as_str(), "event=legacy_log count=1");
        assert!(Event::new(&"文".repeat(1000), &[]).as_str().len() < 512);
    }
    #[test]
    fn rotated_artifacts_are_bounded_and_contain_no_sensitive_values() {
        let dir = temp();
        let mut logger = RotatingLog::with_limits(&dir, 1024, 3).expect("open");
        for index in 0..200 {
            let secret = format!("synthetic-private-secret-{index}");
            let event = Event::new(
                "privacy_test",
                &[
                    ("body", Value::Text(&secret)),
                    ("count", Value::Count(index)),
                ],
            );
            logger.write("INFO", &event).expect("write");
        }
        drop(logger);
        let mut size = 0;
        let mut count = 0;
        for entry in fs::read_dir(&dir).expect("directory") {
            let path = entry.expect("entry").path();
            let data = fs::read_to_string(path).expect("log");
            assert!(!data.contains("synthetic-private-secret"));
            assert!(data.len() <= 1024);
            size += data.len();
            count += 1;
        }
        assert_eq!(count, 3);
        assert!(size <= 3072);
        fs::remove_dir_all(dir).expect("cleanup");
    }
    #[test]
    fn restart_removes_old_budget_and_oversized_slices() {
        let dir = temp();
        for index in 0..6 {
            fs::write(dir.join(format!("diag.{index}.log")), vec![b'x'; 2048]).expect("fixture");
        }
        let logger = RotatingLog::with_limits(&dir, 1024, 3).expect("open");
        drop(logger);
        let sizes: Vec<_> = fs::read_dir(&dir)
            .expect("directory")
            .map(|e| e.expect("entry").metadata().expect("metadata").len())
            .collect();
        assert!(sizes.len() <= 3);
        assert!(sizes.iter().sum::<u64>() <= 3072);
        fs::remove_dir_all(dir).expect("cleanup");
    }
}

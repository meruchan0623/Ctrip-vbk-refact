//! Line formatting, the file-backed [`Logger`] and the process-wide handle
//! used by the `diag_log!` macro.

use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::policy::{render_field, sanitize_text, truncate_chars};
use crate::rotate::{RotatingFile, DEFAULT_MAX_FILE_BYTES, DEFAULT_TOTAL_CAP_BYTES};
use crate::value::{Level, Value};

/// Default account-hash salt. Hosts should pass a per-install random salt
/// (see [`load_or_create_salt`]) so ids cannot be recovered by table lookup:
/// with a public constant, a numeric uid is a few GPU-minutes away.
pub const DEFAULT_SALT: &str = "vbk-diag-v1";

/// Reads the per-install salt from `path`, creating it (32 hex chars from
/// std's OS-seeded hasher mixed with clock and pid) when missing or
/// malformed. Keep the file outside the exported/scanned log directory.
pub fn load_or_create_salt(path: &std::path::Path) -> io::Result<String> {
    if let Ok(existing) = std::fs::read_to_string(path) {
        let t = existing.trim();
        if t.len() >= 16 && t.chars().all(|c| c.is_ascii_hexdigit()) {
            return Ok(t.to_string());
        }
    }
    use std::hash::{BuildHasher, Hash, Hasher};
    let mut salt = String::with_capacity(32);
    for round in 0..2u8 {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
            .hash(&mut h);
        std::process::id().hash(&mut h);
        round.hash(&mut h);
        salt.push_str(&format!("{:016x}", h.finish()));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, &salt)?;
    Ok(salt)
}

#[derive(Debug, Clone)]
pub struct Config {
    pub dir: PathBuf,
    pub stem: String,
    pub max_file_bytes: u64,
    pub total_cap_bytes: u64,
    pub min_level: Level,
    pub salt: String,
}

impl Config {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into(),
            stem: "vbk".to_string(),
            max_file_bytes: DEFAULT_MAX_FILE_BYTES,
            total_cap_bytes: DEFAULT_TOTAL_CAP_BYTES,
            min_level: Level::Info,
            salt: DEFAULT_SALT.to_string(),
        }
    }
}

/// Unix milliseconds -> `YYYY-MM-DDTHH:MM:SS.mmmZ`.
pub fn format_utc(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let milli = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // civil_from_days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{milli:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

fn safe_name(s: &str, max: usize, lower: bool) -> String {
    let t: String = s
        .chars()
        .take(max)
        .map(|c| {
            let c = if lower { c.to_ascii_lowercase() } else { c };
            if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if t.is_empty() {
        "_".to_string()
    } else {
        t
    }
}

fn quote_if_needed(s: &str) -> String {
    let plain = !s.is_empty()
        && s.chars()
            .all(|c| !c.is_whitespace() && !c.is_control() && c != '"' && c != '=' && c != '\\');
    if plain {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => out.push('?'),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Formats one structured record. Pure; every field value passes through
/// the allow-list policy, so nothing unregistered can reach the output.
pub fn format_record(
    ts_ms: i64,
    level: Level,
    event: &str,
    module: &str,
    thread: &str,
    fields: &[(&str, Value)],
    salt: &str,
) -> String {
    let event = if !event.is_empty()
        && event.chars().count() <= 64
        && event
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-'))
    {
        event.to_string()
    } else {
        "<redacted:event>".to_string()
    };
    let mut line = format!(
        "{} {} {} thread={} module={}",
        format_utc(ts_ms),
        level.as_str(),
        event,
        quote_if_needed(&safe_name(thread, 32, false)),
        quote_if_needed(&safe_name(module, 96, false)),
    );
    for (k, v) in fields {
        line.push(' ');
        line.push_str(&safe_name(k, 32, true));
        line.push('=');
        line.push_str(&quote_if_needed(&render_field(k, v, salt)));
    }
    line
}

#[derive(Debug)]
pub struct Logger {
    salt: String,
    min_level: Level,
    sink: Mutex<RotatingFile>,
    dropped: AtomicU64,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

impl Logger {
    pub fn open(cfg: &Config) -> io::Result<Self> {
        Ok(Self {
            salt: cfg.salt.clone(),
            min_level: cfg.min_level,
            sink: Mutex::new(RotatingFile::open(
                &cfg.dir,
                &cfg.stem,
                cfg.max_file_bytes,
                cfg.total_cap_bytes,
            )?),
            dropped: AtomicU64::new(0),
        })
    }

    /// Records dropped because the file could not be written.
    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    pub fn enabled(&self, level: Level) -> bool {
        level <= self.min_level
    }

    fn write(&self, level: Level, mut line: String) {
        let mut sink = match self.sink.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let cap = usize::try_from(sink.max_bytes() / 2).unwrap_or(usize::MAX);
        if line.len() > cap {
            let mut cut = cap;
            while cut > 0 && !line.is_char_boundary(cut) {
                cut -= 1;
            }
            line.truncate(cut);
        }
        if sink.write_line(&line, level <= Level::Warn).is_err() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Structured record (what `diag_log!` calls).
    pub fn log(&self, level: Level, event: &str, module: &str, fields: &[(&str, Value)]) {
        if !self.enabled(level) {
            return;
        }
        let thread = std::thread::current();
        let line = format_record(
            now_ms(),
            level,
            event,
            module,
            thread.name().unwrap_or("unnamed"),
            fields,
            &self.salt,
        );
        self.write(level, line);
    }

    /// Free-text record (bridge for `log::*`): masked and cut to 512 chars.
    pub fn log_text(&self, level: Level, target: &str, text: &str) {
        let msg = sanitize_text(text);
        self.log(
            level,
            "log.text",
            target,
            &[("reason", Value::Str(truncate_chars(&msg, 512)))],
        );
    }
}

static GLOBAL: OnceLock<Logger> = OnceLock::new();

/// Installs the process-wide logger (first call wins).
pub fn init(cfg: &Config) -> io::Result<()> {
    if GLOBAL.get().is_none() {
        let logger = Logger::open(cfg)?;
        let _ = GLOBAL.set(logger);
    }
    Ok(())
}

pub fn global() -> Option<&'static Logger> {
    GLOBAL.get()
}

/// Entry used by `diag_log!`; a no-op before [`init`].
pub fn emit(level: Level, event: &str, module: &str, fields: &[(&str, Value)]) {
    if let Some(l) = GLOBAL.get() {
        l.log(level, event, module, fields);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_formatting() {
        assert_eq!(format_utc(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(format_utc(1_704_067_200_123), "2024-01-01T00:00:00.123Z");
        assert_eq!(format_utc(1_709_164_800_000), "2024-02-29T00:00:00.000Z");
        assert_eq!(format_utc(-1), "1969-12-31T23:59:59.999Z");
    }

    #[test]
    fn salt_is_created_once_hex_and_reused() {
        let dir = std::env::temp_dir().join(format!("core-diag-salt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let p = dir.join("diag.salt");
        let a = load_or_create_salt(&p).expect("create");
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, DEFAULT_SALT);
        assert_eq!(load_or_create_salt(&p).expect("reuse"), a);
        std::fs::write(&p, "not hex!").expect("corrupt");
        let b = load_or_create_salt(&p).expect("recreate");
        assert_ne!(b, a);
        assert_eq!(std::fs::read_to_string(&p).expect("read"), b);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn line_has_no_raw_newline_and_quotes_values() {
        let l = format_record(
            0,
            Level::Warn,
            "x.y",
            "m",
            "t",
            &[("error", Value::Str("a\nb c=d".into()))],
            "s",
        );
        assert!(!l.contains('\n'));
        assert!(l.ends_with("error=\"a b c=d\""), "{l}");
    }
}

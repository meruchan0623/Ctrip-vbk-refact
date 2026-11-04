//! Deliberately small, local-only diagnostics. Never traverse the data tree.
//! Free-text log fields are discarded before the shared sanitizer is applied:
//! a scanner cannot reliably distinguish ordinary message bodies from prose.
use std::io::{self, Read};
use std::path::Path;

use core_diag::export::{prepare_bundle, Bundle, Candidate};

const MAX_SLICE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_EXPORTED_LOG_BYTES: usize = 2 * 1024 * 1024;

/// Only the logger's fixed timestamp and level survive. No event, module,
/// field, free text, account ID or message content is copied.
fn log_metadata(bytes: &[u8]) -> String {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return String::new();
    };
    let mut out = String::new();
    for line in text.lines() {
        let mut fields = line.split_whitespace();
        let Some(stamp) = fields.next() else { continue };
        let Some(level) = fields.next() else { continue };
        let timestamp = stamp.len() == 24
            && stamp.bytes().enumerate().all(|(i, c)| match i {
                4 | 7 => c == b'-',
                10 => c == b'T',
                13 | 16 => c == b':',
                19 => c == b'.',
                23 => c == b'Z',
                _ => c.is_ascii_digit(),
            });
        if timestamp && matches!(level, "ERROR" | "WARN" | "INFO" | "DEBUG" | "TRACE") {
            if out.len() + stamp.len() + level.len() + 2 > MAX_EXPORTED_LOG_BYTES {
                break;
            }
            out.push_str(stamp);
            out.push(' ');
            out.push_str(level);
            out.push('\n');
        }
    }
    out
}

pub fn prepare(data_dir: &Path, version: &str) -> io::Result<Bundle> {
    let mut candidates = vec![Candidate {
        name: "environment.txt".into(),
        bytes: format!(
            "VBooking diagnostics\nversion={version}\nos={}\narch={}\nLogs contain timestamps and levels only; all record details are omitted.\n",
            std::env::consts::OS,
            std::env::consts::ARCH
        ).into_bytes(),
    }];
    let logs = data_dir.join("logs");
    // Refuse symlink directories as well as symlink files. The salt next to
    // this directory and all other app data are outside the candidate set.
    match std::fs::symlink_metadata(&logs) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
            return Err(io::Error::other(
                "diagnostic log directory is not a directory",
            ));
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return Ok(prepare_bundle(candidates, MAX_EXPORTED_LOG_BYTES));
        }
        Err(e) => return Err(e),
        _ => {}
    }
    for index in 0..10 {
        let name = if index == 0 {
            "vbk.log".into()
        } else {
            format!("vbk.{index}.log")
        };
        let path = logs.join(&name);
        let meta = match std::fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e),
        };
        if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > MAX_SLICE_BYTES {
            continue;
        }
        let mut bytes = Vec::new();
        std::fs::File::open(path)?
            .take(MAX_SLICE_BYTES + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_SLICE_BYTES {
            continue;
        }
        candidates.push(Candidate {
            name,
            bytes: log_metadata(&bytes).into_bytes(),
        });
    }
    Ok(prepare_bundle(candidates, MAX_EXPORTED_LOG_BYTES))
}

pub fn render(bundle: &Bundle) -> io::Result<String> {
    let mut text = bundle.manifest.render();
    for (name, body) in &bundle.files {
        text.push_str(&format!("\n--- {name} ---\n{body}"));
    }
    if !core_diag::scan::scan_bytes("diagnostics.txt", text.as_bytes()).is_clean() {
        return Err(io::Error::other(
            "diagnostic content failed the privacy scan",
        ));
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn free_text_and_sensitive_fields_never_survive() {
        let private = "cookie=SECRET_COOKIE token=SECRET_TOKEN phone=13812345678 email=user@example.com message=普通聊天正文";
        let input = format!("2026-11-03T01:02:03.004Z INFO log thread=main {private}\n{private}\n2026-11-03T01:02:04.004Z WARN event {private}\n");
        let metadata = log_metadata(input.as_bytes());
        assert_eq!(
            metadata,
            "2026-11-03T01:02:03.004Z INFO\n2026-11-03T01:02:04.004Z WARN\n"
        );
        let bundle = prepare_bundle(
            vec![Candidate {
                name: "vbk.log".into(),
                bytes: metadata.into_bytes(),
            }],
            MAX_EXPORTED_LOG_BYTES,
        );
        let text = render(&bundle).unwrap();
        for secret in [
            "SECRET_COOKIE",
            "SECRET_TOKEN",
            "13812345678",
            "user@example.com",
            "普通聊天正文",
        ] {
            assert!(!text.contains(secret));
        }
        assert!(core_diag::scan::scan_bytes("diagnostics.txt", text.as_bytes()).is_clean());
        assert!(log_metadata(b"not a log\n\xff").is_empty());
    }

    #[test]
    fn only_fixed_log_slices_are_collected() {
        let root = std::env::temp_dir().join(format!("vbk-diag-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("logs")).unwrap();
        let line = b"2026-11-03T01:02:03.004Z INFO private body\n";
        for name in [
            "vbk.log",
            "cookies.txt",
            "messages.db",
            "vbk.10.log",
            "other.log",
        ] {
            std::fs::write(root.join("logs").join(name), line).unwrap();
        }
        std::fs::write(root.join("diag.salt"), "PRIVATE_SALT").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("diag.salt"), root.join("logs/vbk.1.log")).unwrap();
        let bundle = prepare(&root, "0.1.0").unwrap();
        assert_eq!(
            bundle
                .files
                .iter()
                .map(|(name, _)| name.as_str())
                .collect::<Vec<_>>(),
            ["environment.txt", "vbk.log"]
        );
        let rendered = render(&bundle).unwrap();
        assert!(!rendered.contains("PRIVATE_SALT"));
        assert!(!rendered.contains("private body"));
        std::fs::remove_dir_all(root).unwrap();
    }
}

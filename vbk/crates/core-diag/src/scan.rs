//! Sensitive-content scanner. Same detector as the masker, so a file that
//! was produced by this crate's logger or sanitizer scans clean, and
//! anything else is judged by exactly the rules the plan lists
//! (I-10a acceptance 3, I-22 "任意导出的诊断包扫描零敏感命中", G-SEC-3).
//!
//! Reports never contain the matched secret: excerpts are the *masked* line.

use std::fs;
use std::io;
use std::path::Path;

use crate::detect::{self, Kind};
use crate::policy::truncate_chars;

/// One sensitive match.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    pub kind: Kind,
    /// 1-based line number.
    pub line: usize,
    /// Byte offset of the match within the line.
    pub col: usize,
    /// Masked copy of the line (<= 120 chars); never the raw match.
    pub excerpt: String,
}

/// Scan result for one file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileReport {
    /// File name only (no directory: it may contain a user name).
    pub name: String,
    pub bytes: u64,
    pub findings: Vec<Finding>,
    /// Set when the content could not be inspected (compressed archive).
    /// An uninspectable file is never reported clean.
    pub unscannable: Option<String>,
}

impl FileReport {
    pub fn is_clean(&self) -> bool {
        self.findings.is_empty() && self.unscannable.is_none()
    }
}

/// Scan result for a directory tree.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DirReport {
    pub files: Vec<FileReport>,
    /// Entries that could not be read (reported, never silently skipped).
    pub errors: Vec<String>,
}

impl DirReport {
    pub fn is_clean(&self) -> bool {
        self.errors.is_empty() && self.files.iter().all(FileReport::is_clean)
    }

    pub fn total_findings(&self) -> usize {
        self.files.iter().map(|f| f.findings.len()).sum()
    }
}

/// Scans text line by line.
pub fn scan_text(text: &str) -> Vec<Finding> {
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        let spans = detect::detect(line);
        if spans.is_empty() {
            continue;
        }
        let excerpt = truncate_chars(&detect::mask(line).0, 120);
        for s in spans {
            out.push(Finding {
                kind: s.kind,
                line: i + 1,
                col: s.start,
                excerpt: excerpt.clone(),
            });
        }
    }
    out
}

const ARCHIVE_EXTS: &[&str] = &["gz", "zip", "7z", "bz2", "xz", "zst", "tar", "tgz", "rar"];

/// Scans in-memory content of a file called `name`.
pub fn scan_bytes(name: &str, data: &[u8]) -> FileReport {
    let base = detect::basename(name).to_string();
    let ext = base.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    let unscannable = if ARCHIVE_EXTS.contains(&ext.as_str()) && base.contains('.') {
        Some(format!("compressed archive (.{ext}) cannot be inspected"))
    } else {
        None
    };
    let findings = if unscannable.is_some() {
        Vec::new()
    } else {
        scan_text(&String::from_utf8_lossy(data))
    };
    FileReport {
        name: base,
        bytes: data.len() as u64,
        findings,
        unscannable,
    }
}

pub fn scan_file(path: &Path) -> io::Result<FileReport> {
    let data = fs::read(path)?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(scan_bytes(&name, &data))
}

/// Recursively scans every regular file under `dir` (symlinks are not
/// followed). Rotated slices (`vbk.3.log`) and archives are included.
pub fn scan_dir(dir: &Path) -> io::Result<DirReport> {
    let mut report = DirReport::default();
    walk(dir, &mut report)?;
    report.files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(report)
}

fn walk(dir: &Path, report: &mut DirReport) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        let path = entry.path();
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            if let Err(e) = walk(&path, report) {
                report.errors.push(format!(
                    "{}: {e}",
                    path.file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default()
                ));
            }
        } else {
            match scan_file(&path) {
                Ok(r) => report.files.push(r),
                Err(e) => report.errors.push(format!(
                    "{}: {e}",
                    path.file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default()
                )),
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn findings_carry_line_and_masked_excerpt_only() {
        let f = scan_text("ok line\nphone 13812345678 here\n");
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].line, 2);
        assert_eq!(f[0].kind, Kind::Phone);
        assert!(!f[0].excerpt.contains("13812345678"));
    }

    #[test]
    fn archives_are_never_clean() {
        let r = scan_bytes("vbk.2.log.gz", b"\x1f\x8b");
        assert!(!r.is_clean());
        assert!(scan_bytes("vbk.2.log", b"fine").is_clean());
    }
}

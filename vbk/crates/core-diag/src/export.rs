//! Diagnostic-bundle preparation and the "导出前清单" (I-22), pure logic.
//!
//! The host collects candidate files (logs, crash markers), calls
//! [`prepare_bundle`], shows [`Manifest::render`] to the user and only
//! writes the archive after explicit confirmation. Nothing is uploaded.
//!
//! Guarantees: only allow-listed file types are considered; names that look
//! like credential stores are excluded; every line is masked; the masked
//! content is re-scanned and a file with any residual hit is excluded (not
//! exported "best effort"); non-UTF-8 content is excluded.

use crate::detect::{self, basename, Kind};
use crate::scan::scan_text;

/// File categories shown in the manifest.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileKind {
    Log,
    CrashMarker,
    Text,
}

impl FileKind {
    fn label(self) -> &'static str {
        match self {
            FileKind::Log => "日志",
            FileKind::CrashMarker => "崩溃标记",
            FileKind::Text => "文本",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Exclusion {
    /// Extension not on the allow-list.
    TypeNotAllowed,
    /// Name suggests credentials / keys / cookies.
    SensitiveName,
    NotUtf8,
    TooLarge,
    DuplicateName,
    /// Masked content still triggered the scanner (should not happen).
    ResidualHit(Kind),
}

impl Exclusion {
    fn describe(&self) -> String {
        match self {
            Exclusion::TypeNotAllowed => "文件类型不在导出白名单".into(),
            Exclusion::SensitiveName => "文件名疑似凭据或密钥".into(),
            Exclusion::NotUtf8 => "不是文本，无法检查敏感内容".into(),
            Exclusion::TooLarge => "超过单文件大小上限".into(),
            Exclusion::DuplicateName => "文件名重复".into(),
            Exclusion::ResidualHit(k) => format!("脱敏后仍检出 {}", k.label()),
        }
    }
}

/// Input file as the host read it.
#[derive(Debug, Clone)]
pub struct Candidate {
    /// Name or path; only the file name is used and shown.
    pub name: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Included {
    pub name: String,
    pub kind: FileKind,
    pub original_bytes: u64,
    pub exported_bytes: u64,
    /// Number of values masked while preparing the file.
    pub redactions: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Excluded {
    pub name: String,
    pub reason: Exclusion,
}

/// What the user sees before confirming.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Manifest {
    pub included: Vec<Included>,
    pub excluded: Vec<Excluded>,
}

impl Manifest {
    pub fn total_exported_bytes(&self) -> u64 {
        self.included.iter().map(|i| i.exported_bytes).sum()
    }

    /// The export is never automatic or uploaded; the UI must obtain an
    /// explicit confirmation for the listed files.
    pub const REQUIRES_CONFIRMATION: bool = true;

    /// Plain-text checklist for the confirmation dialog.
    pub fn render(&self) -> String {
        let mut s = String::from("诊断包将包含以下文件（仅保存到本机，不会上传）：\n");
        for i in &self.included {
            s.push_str(&format!(
                "  [{}] {}  {} 字节，已脱敏 {} 处\n",
                i.kind.label(),
                i.name,
                i.exported_bytes,
                i.redactions
            ));
        }
        if self.included.is_empty() {
            s.push_str("  （无）\n");
        }
        if !self.excluded.is_empty() {
            s.push_str("以下文件未纳入：\n");
            for e in &self.excluded {
                s.push_str(&format!("  {}：{}\n", e.name, e.reason.describe()));
            }
        }
        s.push_str(&format!("合计 {} 字节\n", self.total_exported_bytes()));
        s
    }
}

/// Prepared bundle: manifest plus the already-masked file contents.
#[derive(Debug, Clone, Default)]
pub struct Bundle {
    pub manifest: Manifest,
    /// `(file name, masked text)` in manifest order.
    pub files: Vec<(String, String)>,
}

/// Size limit per exported file.
pub const DEFAULT_MAX_FILE_BYTES: usize = 64 * 1024 * 1024;

const SENSITIVE_NAME_PARTS: &[&str] = &[
    "cookie",
    "credential",
    "secret",
    "password",
    "passwd",
    "token",
    "keyring",
    "ticket",
    ".pem",
    ".key",
    ".p12",
    ".pfx",
];

fn classify(name_lower: &str) -> Option<FileKind> {
    let ext = name_lower.rsplit('.').next().unwrap_or("");
    match ext {
        "log" => Some(FileKind::Log),
        "crash" | "marker" => Some(FileKind::CrashMarker),
        "txt" => Some(FileKind::Text),
        _ => None,
    }
}

/// Masks and checks every candidate; see the module docs for the rules.
pub fn prepare_bundle(candidates: Vec<Candidate>, max_file_bytes: usize) -> Bundle {
    let mut bundle = Bundle::default();
    let mut seen: Vec<String> = Vec::new();
    for c in candidates {
        let name = basename(&c.name).to_string();
        let lower = name.to_ascii_lowercase();
        let exclude = |reason: Exclusion, m: &mut Manifest| {
            m.excluded.push(Excluded {
                name: name.clone(),
                reason,
            });
        };
        if seen.contains(&lower) {
            exclude(Exclusion::DuplicateName, &mut bundle.manifest);
            continue;
        }
        seen.push(lower.clone());
        if SENSITIVE_NAME_PARTS.iter().any(|p| lower.contains(p)) {
            exclude(Exclusion::SensitiveName, &mut bundle.manifest);
            continue;
        }
        let Some(kind) = classify(&lower) else {
            exclude(Exclusion::TypeNotAllowed, &mut bundle.manifest);
            continue;
        };
        if c.bytes.len() > max_file_bytes {
            exclude(Exclusion::TooLarge, &mut bundle.manifest);
            continue;
        }
        let Ok(text) = String::from_utf8(c.bytes) else {
            exclude(Exclusion::NotUtf8, &mut bundle.manifest);
            continue;
        };
        let original_bytes = text.len() as u64;
        let mut redactions = 0;
        let mut masked = String::with_capacity(text.len());
        for line in text.split_inclusive('\n') {
            let (body, nl) = match line.strip_suffix('\n') {
                Some(b) => (b, "\n"),
                None => (line, ""),
            };
            let (m, n) = detect::mask(body);
            redactions += n;
            masked.push_str(&m);
            masked.push_str(nl);
        }
        if let Some(f) = scan_text(&masked).first() {
            exclude(Exclusion::ResidualHit(f.kind), &mut bundle.manifest);
            continue;
        }
        bundle.manifest.included.push(Included {
            name: name.clone(),
            kind,
            original_bytes,
            exported_bytes: masked.len() as u64,
            redactions,
        });
        bundle.files.push((name, masked));
    }
    bundle
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cand(name: &str, body: &str) -> Candidate {
        Candidate {
            name: name.into(),
            bytes: body.as_bytes().to_vec(),
        }
    }

    #[test]
    fn masks_filters_and_lists() {
        let b = prepare_bundle(
            vec![
                cand(
                    "/home/bob/data/vbk.log",
                    "a ticket=SECRET123 b\nphone 13812345678\nclean\n",
                ),
                cand("C:\\Users\\Bob\\cookies.txt", "x"),
                cand("vbk.1.log.gz", "x"),
                cand("vbk.log", "dup"),
                cand("crash.marker", "panic at src/a.rs:1"),
            ],
            DEFAULT_MAX_FILE_BYTES,
        );
        let m = &b.manifest;
        assert_eq!(m.included.len(), 2);
        assert_eq!(m.included[0].name, "vbk.log");
        assert_eq!(m.included[0].redactions, 2);
        let body = &b.files[0].1;
        assert!(!body.contains("SECRET123") && !body.contains("13812345678"));
        assert!(body.contains("clean\n"));
        let reasons: Vec<_> = m.excluded.iter().map(|e| e.reason.clone()).collect();
        assert!(reasons.contains(&Exclusion::SensitiveName));
        assert!(reasons.contains(&Exclusion::TypeNotAllowed));
        assert!(reasons.contains(&Exclusion::DuplicateName));
        let text = m.render();
        assert!(text.contains("不会上传") && text.contains("vbk.log"));
        assert!(!text.contains("/home/bob"), "directories never listed");
    }

    #[test]
    fn non_utf8_and_oversize_are_excluded() {
        let b = prepare_bundle(
            vec![
                Candidate {
                    name: "a.log".into(),
                    bytes: vec![0xff, 0xfe, 0x00],
                },
                cand("b.log", &"x".repeat(20)),
            ],
            10,
        );
        assert!(b.manifest.included.is_empty());
        assert_eq!(b.manifest.excluded[0].reason, Exclusion::NotUtf8);
        assert_eq!(b.manifest.excluded[1].reason, Exclusion::TooLarge);
    }
}

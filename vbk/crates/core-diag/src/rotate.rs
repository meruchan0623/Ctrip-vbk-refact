//! Size-based rotating log file: `stem.log` (current), `stem.1.log` (newest
//! rotated) ... `stem.N.log` (oldest). Rotation happens before a write that
//! would push the current file past `max_bytes`, so no file exceeds the limit.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// Default size of one slice (plan I-10a: 20 MB).
pub const DEFAULT_MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;
/// Baseline total cap (plan I-10a: 200 MB until the 72 h soak fixes it).
pub const DEFAULT_TOTAL_CAP_BYTES: u64 = 200 * 1024 * 1024;

#[derive(Debug)]
pub struct RotatingFile {
    dir: PathBuf,
    stem: String,
    max_bytes: u64,
    keep_rotated: usize,
    file: File,
    size: u64,
}

fn slice_path(dir: &Path, stem: &str, idx: usize) -> PathBuf {
    if idx == 0 {
        dir.join(format!("{stem}.log"))
    } else {
        dir.join(format!("{stem}.{idx}.log"))
    }
}

/// Number of rotated slices implied by the caps (current slice excluded).
pub fn rotated_slices(max_bytes: u64, total_cap_bytes: u64) -> usize {
    let total = total_cap_bytes / max_bytes.max(1);
    usize::try_from(total.saturating_sub(1))
        .unwrap_or(usize::MAX)
        .max(1)
}

impl RotatingFile {
    pub fn open(dir: &Path, stem: &str, max_bytes: u64, total_cap_bytes: u64) -> io::Result<Self> {
        fs::create_dir_all(dir)?;
        let max_bytes = max_bytes.max(1024);
        let path = slice_path(dir, stem, 0);
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let size = file.metadata()?.len();
        Ok(Self {
            dir: dir.to_path_buf(),
            stem: stem.to_string(),
            max_bytes,
            keep_rotated: rotated_slices(max_bytes, total_cap_bytes),
            file,
            size,
        })
    }

    pub fn max_bytes(&self) -> u64 {
        self.max_bytes
    }

    /// Appends `line` plus `\n`. `sync` also flushes to disk (used for
    /// warnings/errors so the context before a crash survives).
    pub fn write_line(&mut self, line: &str, sync: bool) -> io::Result<()> {
        let mut buf = Vec::with_capacity(line.len() + 1);
        buf.extend_from_slice(line.as_bytes());
        buf.push(b'\n');
        let n = buf.len() as u64;
        if self.size > 0 && self.size + n > self.max_bytes {
            self.rotate()?;
        }
        self.file.write_all(&buf)?;
        self.size += n;
        if sync {
            self.file.sync_data()?;
        }
        Ok(())
    }

    fn rotate(&mut self) -> io::Result<()> {
        self.file.flush()?;
        let oldest = slice_path(&self.dir, &self.stem, self.keep_rotated);
        if oldest.exists() {
            fs::remove_file(&oldest)?;
        }
        for idx in (1..self.keep_rotated).rev() {
            let from = slice_path(&self.dir, &self.stem, idx);
            if from.exists() {
                fs::rename(&from, slice_path(&self.dir, &self.stem, idx + 1))?;
            }
        }
        fs::rename(
            slice_path(&self.dir, &self.stem, 0),
            slice_path(&self.dir, &self.stem, 1),
        )?;
        self.file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(slice_path(&self.dir, &self.stem, 0))?;
        self.size = 0;
        Ok(())
    }
}

/// Every existing slice of `stem` in `dir`, current first, oldest last.
pub fn slice_paths(dir: &Path, stem: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut idx = 0;
    loop {
        let p = slice_path(dir, stem, idx);
        if p.exists() {
            out.push(p);
        } else if idx > 0 {
            break;
        }
        idx += 1;
        if idx > 10_000 {
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn temp_dir(tag: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let d = std::env::temp_dir().join(format!(
            "core-diag-{tag}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn caps_derive_slice_count() {
        assert_eq!(rotated_slices(20 << 20, 200 << 20), 9);
        assert_eq!(rotated_slices(20 << 20, 20 << 20), 1);
        assert_eq!(rotated_slices(1024, 4096), 3);
    }

    #[test]
    fn rotates_by_size_and_drops_oldest() {
        let dir = temp_dir("rot");
        let mut f = RotatingFile::open(&dir, "t", 1024, 4096).expect("open");
        let line = "x".repeat(99); // 100 bytes with newline
        for i in 0..200 {
            f.write_line(&format!("{i:04}{}", &line[4..]), false)
                .expect("write");
        }
        let slices = slice_paths(&dir, "t");
        assert_eq!(slices.len(), 4, "current + 3 rotated");
        for p in &slices {
            assert!(fs::metadata(p).expect("meta").len() <= 1024);
        }
        let newest = fs::read_to_string(&slices[0]).expect("read");
        assert!(newest.contains("0199"), "newest line in current slice");
        let all: String = slices
            .iter()
            .map(|p| fs::read_to_string(p).expect("read"))
            .collect();
        assert!(!all.contains("0000"), "oldest lines dropped by the cap");
        // Reopen continues the current slice instead of truncating it.
        let before = fs::metadata(&slices[0]).expect("meta").len();
        drop(f);
        let mut g = RotatingFile::open(&dir, "t", 1024, 4096).expect("reopen");
        g.write_line("again", false).expect("write");
        let after = fs::metadata(&slice_paths(&dir, "t")[0])
            .expect("meta")
            .len();
        assert!(
            after == before + 6 || after == 6,
            "append or clean rotation"
        );
        let _ = fs::remove_dir_all(&dir);
    }
}

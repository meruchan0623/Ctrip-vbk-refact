//! 升级/重装时保护用户数据（账号索引、偏好、WebView 登录态）的共用规则。
//!
//! 所有持久数据都在 `app_data_dir`（Windows `%APPDATA%\tech.tsim.vbk.client`，
//! macOS `~/Library/Application Support/tech.tsim.vbk.client`）下，路径只由
//! bundle identifier 决定，与版本号、安装目录、exe 路径无关；WebView2 本地窗口的
//! 默认数据目录由 Tauri 放在 `app_local_data_dir`，同样不在安装目录。
//!
//! 本模块只负责两件事：
//! * 读不懂的持久文档（新版写入后降级、半截写入、手工改坏）先原样备份成
//!   `<name>.unreadable-<unix_ms>`，再让调用方用默认值继续——之后的保存不会把
//!   唯一一份旧数据覆盖掉；
//! * 账号索引不可信时，禁止「清理孤儿 profile」——否则一次读失败就会把全部
//!   账号的 Cookie 当孤儿删掉（更新后丢登录态的主要路径）。

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// 启动时账号索引（`accounts.json`）的读取结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IndexLoad {
    /// 文件不存在（首次运行）。
    Absent,
    /// 读取并恢复成功：内存中的账号集合就是磁盘上的真相。
    Restored,
    /// 文件存在但读不出、解析失败、版本更新或恢复被拒绝。
    Untrusted,
}

/// 只有索引完整恢复后，磁盘上不属于任何账号的 profile 才能算孤儿。
/// `Absent` 也不清理：索引丢了但 profile 还在，说明数据只是暂时对不上，
/// 宁可多占磁盘也不删掉可能还能找回的登录态。
pub fn may_purge_orphans(load: IndexLoad) -> bool {
    matches!(load, IndexLoad::Restored)
}

/// 备份文件名：`accounts.json` → `accounts.json.unreadable-<ms>`。
pub fn backup_path(path: &Path, now_ms: u128) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "data".to_string());
    path.with_file_name(format!("{name}.unreadable-{now_ms}"))
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 把读不懂的持久文件复制一份留底（原文件保持不动）。失败只记日志：
/// 备份是额外保险，不能因此阻止启动。
pub fn preserve_unreadable(path: &Path) -> Option<PathBuf> {
    preserve_unreadable_at(path, now_ms())
}

fn preserve_unreadable_at(path: &Path, now_ms: u128) -> Option<PathBuf> {
    if !path.is_file() {
        return None;
    }
    let backup = backup_path(path, now_ms);
    match std::fs::copy(path, &backup) {
        Ok(_) => {
            log::warn!(
                "{}: unreadable document preserved as {}",
                path.display(),
                backup.display()
            );
            Some(backup)
        }
        Err(e) => {
            log::warn!("{}: unreadable document not preserved: {e}", path.display());
            None
        }
    }
}

/// 账号 profile 的数据目录名必须是 core-account 生成的 `p_<hex>`：只认这种
/// 名字，既防路径穿越，也让孤儿清理不会碰到别的目录。
pub fn is_profile_dir_name(name: &str) -> bool {
    name.strip_prefix("p_").is_some_and(|rest| {
        !rest.is_empty() && rest.len() <= 64 && rest.bytes().all(|b| b.is_ascii_alphanumeric())
    })
}

/// 账号 profile 的 WebView 数据目录：`<app_data_dir>/profiles/<profile_id>`。
/// 只由 profile id 决定，不含版本号、安装路径或 exe 哈希，升级后原样复用。
pub fn profile_dir(app_data_dir: &Path, profile_id: &str) -> Option<PathBuf> {
    is_profile_dir_name(profile_id).then(|| app_data_dir.join("profiles").join(profile_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "vbk-data-guard-{tag}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn orphan_purge_only_after_a_trusted_restore() {
        assert!(may_purge_orphans(IndexLoad::Restored));
        assert!(!may_purge_orphans(IndexLoad::Untrusted));
        assert!(!may_purge_orphans(IndexLoad::Absent));
    }

    #[test]
    fn profile_dir_is_version_and_install_path_independent() {
        let base = Path::new("/data/tech.tsim.vbk.client");
        let dir = profile_dir(base, "p_0123456789abcdef").expect("valid id");
        assert_eq!(dir, base.join("profiles").join("p_0123456789abcdef"));
        // 同一个 profile 永远落在同一目录：路径里没有版本号或安装位置。
        assert_eq!(profile_dir(base, "p_0123456789abcdef"), Some(dir.clone()));
        let text = dir.to_string_lossy();
        assert!(!text.contains("0.1.0"));
        assert!(!text.to_ascii_lowercase().contains("program"));
    }

    #[test]
    fn profile_dir_rejects_traversal_and_foreign_names() {
        let base = Path::new("/data");
        for bad in [
            "",
            "p_",
            "../p_1",
            "p_../x",
            "p_a/b",
            "q_1",
            "p_a b",
            "EBWebView",
        ] {
            assert!(profile_dir(base, bad).is_none(), "{bad:?}");
            assert!(!is_profile_dir_name(bad), "{bad:?}");
        }
        assert!(is_profile_dir_name("p_ABCdef0123"));
    }

    #[test]
    fn backup_name_keeps_the_original_name() {
        let p = Path::new("/x/accounts.json");
        assert_eq!(
            backup_path(p, 42),
            Path::new("/x/accounts.json.unreadable-42")
        );
    }

    #[test]
    fn unreadable_document_is_copied_not_moved() {
        let dir = temp_dir("copy");
        let path = dir.join("prefs.json");
        std::fs::write(&path, b"{not json").expect("write");
        let backup = preserve_unreadable_at(&path, 7).expect("backup");
        assert_eq!(
            std::fs::read(&backup).expect("backup readable"),
            b"{not json"
        );
        assert!(path.is_file(), "the original stays in place");
        assert!(preserve_unreadable_at(&dir.join("missing.json"), 8).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

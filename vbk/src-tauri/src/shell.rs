//! Window chrome and shell commands: minimize/maximize/close, open local
//! windows, open external official URLs, screenshot and file pick.
//!
//! Owner: host-shell.
//!
//! * `shell_window` acts on the caller's own native window. `main` close
//!   hides to the tray (or quits when `general.close_action == quit`);
//!   every other window goes through its normal close-requested path
//!   (alarm hides itself, login is handled by its own close handler).
//! * `shell_open_external` only lets `https` URLs on `*.ctrip.com` or the
//!   TSim official domain through and hands them to the system browser.
//! * `media_pick` / `media_screenshot` return an opaque `attachment_id`;
//!   file paths never leave this module's in-memory table.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use contracts::{codes, AppError};
use serde::Serialize;
use tauri::{AppHandle, Manager, State, Url, Window};

use crate::dto::AppErrorDto;
use crate::prefs;
use crate::state::HostState;
use crate::views;
use crate::windows;

type CmdResult<T> = Result<T, AppErrorDto>;

/// Module-private error code: malformed command argument.
pub const INVALID_ARGUMENT: &str = "host.invalid_argument";

fn guard(state: &HostState, window: &Window, command: &str) -> CmdResult<()> {
    state
        .authorize(window.label(), command)
        .map_err(AppErrorDto::from)
}

fn invalid_argument(what: impl Into<String>) -> AppErrorDto {
    AppError::new(INVALID_ARGUMENT, what).into()
}

fn tauri_err(e: tauri::Error) -> AppErrorDto {
    AppError::new(codes::HOST_UNSUPPORTED, e.to_string()).into()
}

// ------------------------------------------------------------------ attachments

#[derive(Debug, Clone)]
struct Attachment {
    path: PathBuf,
    /// Created by the host (screenshot temp file); removed on drop of the table.
    temporary: bool,
}

#[derive(Default)]
struct Attachments {
    items: Mutex<HashMap<String, Attachment>>,
}

impl Drop for Attachments {
    fn drop(&mut self) {
        let items = self.items.get_mut().unwrap_or_else(|p| p.into_inner());
        for a in items.values().filter(|a| a.temporary) {
            let _ = std::fs::remove_file(&a.path);
        }
    }
}

/// `{attachment_id, name}` returned to the UI. Never carries the path.
#[derive(Debug, Clone, Serialize)]
pub struct AttachmentDto {
    pub attachment_id: String,
    pub name: String,
}

fn register_attachment(app: &AppHandle, path: PathBuf, temporary: bool) -> AttachmentDto {
    let id = uuid::Uuid::new_v4().to_string();
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "attachment".into());
    if let Some(table) = app.try_state::<Attachments>() {
        table
            .items
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id.clone(), Attachment { path, temporary });
    }
    AttachmentDto {
        attachment_id: id,
        name,
    }
}

// ------------------------------------------------------------------ init

/// Called once from `lib.rs` setup. Register module state with `app.manage(..)` here.
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    app.manage(Attachments::default());
    // `lib.rs` already turns main's close into hide-to-tray. When the user
    // chose "退出程序" the native close (macOS red light, Alt+F4) quits.
    if let Some(main) = app.get_webview_window(views::MAIN) {
        let handle = app.clone();
        main.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if prefs::close_quits(&handle) {
                    handle.state::<HostState>().request_quit(&handle);
                }
            }
        });
    }
    Ok(())
}

// ------------------------------------------------------------------ window chrome

#[tauri::command]
pub fn shell_window(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
    action: String,
) -> CmdResult<()> {
    guard(&state, &window, "shell_window")?;
    match action.as_str() {
        "minimize" => window.minimize().map_err(tauri_err),
        "toggle_maximize" => {
            if window.is_maximized().unwrap_or(false) {
                window.unmaximize().map_err(tauri_err)
            } else {
                window.maximize().map_err(tauri_err)
            }
        }
        "close" => {
            if window.label() == views::MAIN {
                if prefs::close_quits(&app) {
                    state.request_quit(&app);
                    Ok(())
                } else {
                    window.hide().map_err(tauri_err)
                }
            } else {
                // Goes through CloseRequested so per-window handlers apply.
                window.close().map_err(tauri_err)
            }
        }
        other => Err(invalid_argument(format!("unknown window action {other:?}"))),
    }
}

#[tauri::command]
pub fn shell_open_window(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
    label: String,
) -> CmdResult<()> {
    guard(&state, &window, "shell_open_window")?;
    match label.as_str() {
        views::SETTING => windows::open_setting(&app).map_err(tauri_err),
        views::UPDATE => windows::open_update(&app).map_err(tauri_err),
        other => Err(invalid_argument(format!(
            "window {other:?} cannot be opened"
        ))),
    }
}

// ------------------------------------------------------------------ external URLs

/// TSim official registrable domain (`csapi.tsim.tech`, app identifier).
const TSIM_DOMAIN: &str = "tsim.tech";
const CTRIP_DOMAIN: &str = "ctrip.com";

fn host_in(host: &str, domain: &str) -> bool {
    host == domain
        || host
            .strip_suffix(domain)
            .is_some_and(|prefix| prefix.ends_with('.') && prefix.len() > 1)
}

/// Official-origin policy for `shell_open_external`: `https`, default port,
/// no credentials, host is `ctrip.com` / `*.ctrip.com` / `tsim.tech` /
/// `*.tsim.tech`. Returns the normalised URL.
pub fn check_external_url(raw: &str) -> Result<Url, AppError> {
    let reject =
        |why: &str| AppError::new(codes::HOST_URL_REJECTED, format!("url rejected: {why}"));
    let url = Url::parse(raw.trim()).map_err(|_| reject("not a valid URL"))?;
    if url.scheme() != "https" {
        return Err(reject("only https is allowed"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(reject("credentials in URL"));
    }
    if url.port().is_some() {
        return Err(reject("explicit port"));
    }
    // `domain()` is None for IP-literal hosts.
    let Some(host) = url.domain() else {
        return Err(reject("host is not a domain"));
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if !(host_in(&host, CTRIP_DOMAIN) || host_in(&host, TSIM_DOMAIN)) {
        return Err(reject("host is not an official domain"));
    }
    Ok(url)
}

fn open_in_browser(url: &Url) -> Result<(), AppError> {
    let spawned = {
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("/usr/bin/open")
                .arg(url.as_str())
                .spawn()
        }
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            // The serialised URL never contains `"` (percent-encoded), so
            // quoting keeps `&` / `^` away from cmd's parser.
            std::process::Command::new("cmd")
                .raw_arg(format!("/C start \"\" \"{}\"", url.as_str()))
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            std::process::Command::new("xdg-open")
                .arg(url.as_str())
                .spawn()
        }
    };
    match spawned {
        Ok(mut child) => {
            // Reap the launcher without blocking the command.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            Ok(())
        }
        Err(e) => Err(AppError::new(
            codes::HOST_UNSUPPORTED,
            format!("cannot launch the system browser: {e}"),
        )),
    }
}

#[tauri::command]
pub fn shell_open_external(
    window: Window,
    state: State<'_, HostState>,
    url: String,
) -> CmdResult<()> {
    guard(&state, &window, "shell_open_external")?;
    let url = check_external_url(&url)?;
    open_in_browser(&url)?;
    Ok(())
}

// ------------------------------------------------------------------ media

#[tauri::command]
pub async fn media_screenshot(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
) -> CmdResult<Option<AttachmentDto>> {
    guard(&state, &window, "media_screenshot")?;
    #[cfg(target_os = "macos")]
    {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join("vbk-screenshots");
        let path = dir.join(format!("screenshot-{stamp}.png"));
        let target = path.clone();
        // Interactive selection (-i), no shutter sound (-x). Cancelling with
        // Esc exits without writing the file.
        let status = tauri::async_runtime::spawn_blocking(move || {
            std::fs::create_dir_all(&dir)?;
            std::process::Command::new("/usr/sbin/screencapture")
                .args(["-i", "-x"])
                .arg(&target)
                .status()
        })
        .await
        .map_err(|e| AppError::new(codes::HOST_UNSUPPORTED, e.to_string()))?
        .map_err(|e| {
            AppError::new(
                codes::HOST_UNSUPPORTED,
                format!("screencapture failed: {e}"),
            )
        })?;
        let written = std::fs::metadata(&path)
            .map(|m| m.len() > 0)
            .unwrap_or(false);
        if !status.success() || !written {
            let _ = std::fs::remove_file(&path);
            return Ok(None);
        }
        Ok(Some(register_attachment(&app, path, true)))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err(AppError::new(
            codes::HOST_UNSUPPORTED,
            "screenshot is not available on this platform",
        )
        .into())
    }
}

fn filter_for(kind: &str) -> Result<Option<(&'static str, &'static [&'static str])>, AppErrorDto> {
    match kind {
        "image" => Ok(Some((
            "图片",
            &["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic"],
        ))),
        "video" => Ok(Some(("视频", &["mp4", "mov", "m4v", "avi", "webm"]))),
        "file" => Ok(None),
        other => Err(invalid_argument(format!("unknown media kind {other:?}"))),
    }
}

#[tauri::command]
pub async fn media_pick(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
    kind: String,
) -> CmdResult<Option<AttachmentDto>> {
    use tauri_plugin_dialog::DialogExt;

    guard(&state, &window, "media_pick")?;
    let filter = filter_for(&kind)?;
    let mut dialog = app.dialog().file().set_parent(&window);
    if let Some((name, exts)) = filter {
        dialog = dialog.add_filter(name, exts);
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    dialog.pick_file(move |picked| {
        let _ = tx.send(picked);
    });
    let picked = rx.await.ok().flatten();
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else {
        return Ok(None);
    };
    if !path.is_file() {
        return Ok(None);
    }
    Ok(Some(register_attachment(&app, path, false)))
}

// ------------------------------------------------------------------
// Cross-module interface (FROZEN signatures; bodies owned by host-shell).

/// "macos" | "windows" | "linux".
pub fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

/// Local file behind an `attachment_id` from `media_pick` / `media_screenshot`
/// (for the later send path). None when unknown.
pub fn attachment_path(app: &AppHandle, id: &str) -> Option<PathBuf> {
    let table = app.try_state::<Attachments>()?;
    let items = table.items.lock().unwrap_or_else(|p| p.into_inner());
    items.get(id).map(|a| a.path.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn official_https_urls_pass() {
        for ok in [
            "https://vbooking.ctrip.com/im/x?a=1&b=2",
            "https://ctrip.com/",
            "https://a.b.ctrip.com/path#frag",
            "https://csapi.tsim.tech/agent",
            "https://tsim.tech",
            "https://VBOOKING.CTRIP.COM/",
        ] {
            assert!(check_external_url(ok).is_ok(), "{ok}");
        }
    }

    #[test]
    fn other_urls_rejected() {
        for bad in [
            "http://vbooking.ctrip.com/",
            "https://evilctrip.com/",
            "https://ctrip.com.evil.com/",
            "https://.ctrip.com/",
            "https://user:pw@vbooking.ctrip.com/",
            "https://vbooking.ctrip.com:8443/",
            "https://1.2.3.4/",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "tsim.tech",
            "https://faketsim.tech/",
        ] {
            let err = check_external_url(bad).unwrap_err();
            assert_eq!(err.code, codes::HOST_URL_REJECTED, "{bad}");
        }
    }

    #[test]
    fn media_kinds() {
        assert!(filter_for("image").unwrap().is_some());
        assert!(filter_for("video").unwrap().is_some());
        assert!(filter_for("file").unwrap().is_none());
        assert!(filter_for("exe").is_err());
    }
}

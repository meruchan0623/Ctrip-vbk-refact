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
use tauri::{AppHandle, Manager, State, Url, Window};

use crate::dto::AccountContextDto;
use crate::dto::AppErrorDto;
pub use crate::media_outbound::AttachmentDto;
use crate::media_outbound::{FrozenAttachment, MediaTarget};
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

#[derive(Clone)]
struct Attachment {
    path: PathBuf,
    /// Created by the host (screenshot temp file); removed on drop of the table.
    temporary: bool,
    frozen: FrozenAttachment,
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

async fn register_attachment(
    app: &AppHandle,
    path: PathBuf,
    temporary: bool,
    kind: String,
    account: contracts::AccountContext,
    gid: String,
    target: MediaTarget,
) -> CmdResult<AttachmentDto> {
    let read_path = path.clone();
    let read_account = account.clone();
    let read_gid = gid.clone();
    let read_target = target.clone();
    let frozen = tauri::async_runtime::spawn_blocking(move || {
        FrozenAttachment::read(&read_path, &kind, &read_account, &read_gid, read_target)
    })
    .await
    .map_err(|_| invalid_argument("attachment snapshot failed"))?
    .map_err(AppErrorDto::from)?;
    crate::adapter::validate_media_target(app, &account, &gid, &target)
        .await
        .map_err(AppErrorDto::from)?;
    let table = app
        .try_state::<Attachments>()
        .ok_or_else(|| invalid_argument("attachment table unavailable"))?;
    let mut items = table.items.lock().unwrap_or_else(|p| p.into_inner());
    items.retain(|_, old| {
        crate::media_outbound::now_ms() - old.frozen.created_ms <= crate::media_outbound::TTL_MS
    });
    if items
        .values()
        .filter(|item| !item.frozen.bytes.is_empty())
        .count()
        >= crate::media_outbound::MAX_ATTACHMENTS
        || items.values().map(|item| item.frozen.bytes.len()).sum::<usize>()
            .saturating_add(frozen.bytes.len()) > 300 * 1024 * 1024
        || items.len() >= 128
    {
        return Err(invalid_argument(
            "too many pending local attachments; release one first",
        ));
    }
    let dto = frozen.dto.clone();
    items.insert(
        dto.attachment_id.clone(),
        Attachment {
            path,
            temporary,
            frozen,
        },
    );
    Ok(dto)
}

pub fn frozen_attachment(
    app: &AppHandle,
    id: &str,
    account: &contracts::AccountContext,
    gid: &str,
) -> Result<FrozenAttachment, AppError> {
    let table = app
        .try_state::<Attachments>()
        .ok_or_else(crate::media_outbound::invalid)?;
    let item = table
        .items
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(id)
        .cloned()
        .ok_or_else(crate::media_outbound::invalid)?;
    if !item.frozen.owns(account, gid) {
        return Err(crate::media_outbound::invalid());
    }
    Ok(item.frozen)
}

/// Keep only body-free in-memory manifest metadata for correct same-ID replay;
/// the active command's clone owns the immutable bytes until it settles.
pub fn consume_attachment(
    app: &AppHandle,
    id: &str,
    account: &contracts::AccountContext,
    gid: &str,
) {
    if let Some(table) = app.try_state::<Attachments>() {
        let mut items = table.items.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(item) = items.get_mut(id) {
            if item.frozen.owns(account, gid) {
                item.frozen.bytes = std::sync::Arc::new(Vec::new());
            }
        }
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
pub async fn shell_open_window(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
    label: String,
) -> CmdResult<()> {
    guard(&state, &window, "shell_open_window")?;
    match label.as_str() {
        views::SETTING => windows::open_setting(&app).await.map_err(tauri_err),
        views::UPDATE => windows::open_update(&app).await.map_err(tauri_err),
        other => Err(invalid_argument(format!(
            "window {other:?} cannot be opened"
        ))),
    }
}

// ------------------------------------------------------------------ external URLs

/// TSim official registrable domain (`csapi.tsim.tech`, app identifier).
const TSIM_DOMAIN: &str = "tsim.tech";
const CTRIP_DOMAIN: &str = "ctrip.com";
// Official chat attachment and product-link hosts observed in the message payloads.
const OFFICIAL_MEDIA_DOMAINS: &[&str] = &["c-ctrip.com", "tripcdn.com", "trip.com"];

fn host_in(host: &str, domain: &str) -> bool {
    host == domain
        || host
            .strip_suffix(domain)
            .is_some_and(|prefix| prefix.ends_with('.') && prefix.len() > 1)
}

/// Official-origin policy for `shell_open_external`: `https`, default port,
/// no credentials, host is an official Ctrip/Trip content domain or TSim.
/// Returns the normalised URL; suffix checks always require a label boundary.
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
    if !(host_in(&host, CTRIP_DOMAIN)
        || host_in(&host, TSIM_DOMAIN)
        || OFFICIAL_MEDIA_DOMAINS.iter().any(|domain| host_in(&host, domain))) {
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
    account: AccountContextDto,
    gid: String,
) -> CmdResult<Option<AttachmentDto>> {
    guard(&state, &window, "media_screenshot")?;
    #[cfg(target_os = "macos")]
    {
        let account: contracts::AccountContext = account.into();
        state
            .lock()
            .accounts
            .validate(&account)
            .map_err(AppErrorDto::from)?;
        let target = crate::adapter::capture_media_target(&app, &account, &gid)
            .await
            .map_err(AppErrorDto::from)?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join("vbk-screenshots");
        let path = dir.join(format!("screenshot-{stamp}.png"));
        let screenshot_path = path.clone();
        // Interactive selection (-i), no shutter sound (-x). Cancelling with
        // Esc exits without writing the file.
        let status = tauri::async_runtime::spawn_blocking(move || {
            std::fs::create_dir_all(&dir)?;
            std::process::Command::new("/usr/sbin/screencapture")
                .args(["-i", "-x"])
                .arg(&screenshot_path)
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
            crate::adapter::release_media_target(&app, &account, &gid, &target).await;
            return Ok(None);
        }
        let result = register_attachment(
            &app,
            path.clone(),
            true,
            "image".into(),
            account.clone(),
            gid.clone(),
            target.clone(),
        )
        .await;
        // The immutable memory snapshot now owns the selected bytes, including
        // when a late target validation rejects the selection.
        let _ = std::fs::remove_file(&path);
        if result.is_err() {
            crate::adapter::release_media_target(&app, &account, &gid, &target).await;
        }
        result.map(Some)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, account, gid);
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
    account: AccountContextDto,
    gid: String,
) -> CmdResult<Option<AttachmentDto>> {
    use tauri_plugin_dialog::DialogExt;

    guard(&state, &window, "media_pick")?;
    let filter = filter_for(&kind)?;
    let account: contracts::AccountContext = account.into();
    state
        .lock()
        .accounts
        .validate(&account)
        .map_err(AppErrorDto::from)?;
    let target = crate::adapter::capture_media_target(&app, &account, &gid)
        .await
        .map_err(AppErrorDto::from)?;
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
        crate::adapter::release_media_target(&app, &account, &gid, &target).await;
        return Ok(None);
    };
    if !path.is_file() {
        crate::adapter::release_media_target(&app, &account, &gid, &target).await;
        return Ok(None);
    }
    let result = register_attachment(
        &app,
        path,
        false,
        kind,
        account.clone(),
        gid.clone(),
        target.clone(),
    )
    .await;
    if result.is_err() {
        crate::adapter::release_media_target(&app, &account, &gid, &target).await;
    }
    result.map(Some)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn media_release(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
    account: AccountContextDto,
    gid: String,
    attachment_id: String,
) -> CmdResult<()> {
    guard(&state, &window, "media_release")?;
    let account: contracts::AccountContext = account.into();
    let table = app
        .try_state::<Attachments>()
        .ok_or_else(|| invalid_argument("attachment table unavailable"))?;
    let removed = {
        let mut items = table.items.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(item) = items.get(&attachment_id) {
            if !item.frozen.owns(&account, &gid) {
                return Err(crate::media_outbound::invalid().into());
            }
        }
        items.remove(&attachment_id)
    };
    if let Some(item) = removed {
        if item.temporary {
            let _ = std::fs::remove_file(item.path);
        }
        crate::adapter::release_media_target(&app, &account, &gid, &item.frozen.target).await;
    }
    Ok(())
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
            "https://dimg04.c-ctrip.com/images/example.png",
            "https://ak-d.tripcdn.com/images/example.png",
            "https://hk.trip.com/things-to-do/detail/123",
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
            "https://tripcdn.com.evil.example/file",
            "https://evilc-ctrip.com/file",
            "https://trip.com@evil.example/file",
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

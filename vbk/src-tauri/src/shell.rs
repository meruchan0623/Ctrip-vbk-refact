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
    path: Option<PathBuf>,
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
            if let Some(path) = &a.path {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

/// Private per-capture destination. Never reuse the public timestamp path.
/// Dropping this guard removes temporary bytes on cancellation and all errors.
#[cfg(any(target_os = "macos", test))]
struct ScreenshotFile {
    dir: PathBuf,
    path: PathBuf,
}
#[cfg(any(target_os = "macos", test))]
impl ScreenshotFile {
    fn create() -> std::io::Result<Self> {
        let dir = std::env::temp_dir().join(format!("vbk-screenshot-{}", uuid::Uuid::new_v4()));
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        // create_dir fails for an existing entry, including a symlink.
        builder.create(&dir)?;
        Ok(Self {
            path: dir.join("screenshot.png"),
            dir,
        })
    }
}
#[cfg(any(target_os = "macos", test))]
impl Drop for ScreenshotFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        let _ = std::fs::remove_dir(&self.dir);
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
    let mut frozen = tauri::async_runtime::spawn_blocking(move || {
        FrozenAttachment::read(&read_path, &kind, &read_account, &read_gid, read_target)
    })
    .await
    .map_err(|_| invalid_argument("attachment snapshot failed"))?
    .map_err(AppErrorDto::from)?;
    crate::adapter::validate_media_target(app, &account, &gid, &target)
        .await
        .map_err(AppErrorDto::from)?;
    let persist_app = app.clone();
    frozen = tauri::async_runtime::spawn_blocking(move || {
        let owner: contracts::AccountContext = frozen.dto.owner.account.clone().into();
        frozen.dto.lease_id = Some(crate::adapter::with_outbound(
            &persist_app,
            &owner,
            |journal| journal.persist_attachment(&frozen),
        )?);
        Ok::<_, AppError>(frozen)
    })
    .await
    .map_err(|_| invalid_argument("attachment persistence failed"))?
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
        >= core_im::media_limits::MAX_FILES_PER_SEND
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
            // A screenshot guard owns its temporary path and removes it as
            // soon as these immutable bytes are frozen. Do not retain a stale
            // path that could later be replaced with a symlink directory.
            path: (!temporary).then_some(path),
            temporary: false,
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

/// Annotation handles must still be live in the table, not merely a clone
/// retained by a command that was consumed/released while decoding.
fn annotation_source_is_live(
    items: &HashMap<String, Attachment>,
    source: &FrozenAttachment,
) -> bool {
    items.get(&source.dto.attachment_id).is_some_and(|item| {
        !item.frozen.bytes.is_empty()
            && std::sync::Arc::ptr_eq(&item.frozen.bytes, &source.bytes)
            && item.frozen.target == source.target
            && crate::media_outbound::now_ms() - item.frozen.created_ms
                <= crate::media_outbound::TTL_MS
    })
}

pub(crate) fn ensure_annotation_source_live(
    app: &AppHandle,
    source: &FrozenAttachment,
) -> Result<(), AppError> {
    let table = app
        .try_state::<Attachments>()
        .ok_or_else(crate::media_outbound::invalid)?;
    let items = table.items.lock().unwrap_or_else(|p| p.into_inner());
    if !annotation_source_is_live(&items, source) {
        return Err(crate::media_outbound::invalid());
    }
    Ok(())
}

fn insert_derived(
    items: &mut HashMap<String, Attachment>,
    source: &FrozenAttachment,
    derived: FrozenAttachment,
) -> Result<AttachmentDto, AppError> {
    if !annotation_source_is_live(items, source)
        || (source.dto.owner.account != derived.dto.owner.account
            || source.dto.owner.gid != derived.dto.owner.gid)
        || source.target.target_token == derived.target.target_token
        || source.target.identity_sha256 != derived.target.identity_sha256
        || source.target.sender_id != derived.target.sender_id
        || items
            .values()
            .filter(|item| !item.frozen.bytes.is_empty())
            .count()
            >= core_im::media_limits::MAX_FILES_PER_SEND
        || items.len() >= 128
    {
        return Err(crate::media_outbound::invalid());
    }
    let dto = derived.dto.clone();
    items.insert(
        dto.attachment_id.clone(),
        Attachment {
            path: None,
            temporary: false,
            frozen: derived,
        },
    );
    Ok(dto)
}

pub(crate) fn register_derived_attachment(
    app: &AppHandle,
    source: &FrozenAttachment,
    mut derived: FrozenAttachment,
) -> Result<AttachmentDto, AppError> {
    let owner: contracts::AccountContext = derived.dto.owner.account.clone().into();
    derived.dto.lease_id = Some(crate::adapter::with_outbound(app, &owner, |journal| {
        journal.persist_attachment(&derived)
    })?);
    let table = app
        .try_state::<Attachments>()
        .ok_or_else(crate::media_outbound::invalid)?;
    let mut items = table.items.lock().unwrap_or_else(|p| p.into_inner());
    insert_derived(&mut items, source, derived)
}

/// Register only bytes reconstructed from an authorized persistent draft.
/// The caller must revalidate the current account and freshly captured target.
pub(crate) fn register_restored_attachment(
    app: &AppHandle,
    frozen: FrozenAttachment,
) -> Result<AttachmentDto, AppError> {
    let table = app
        .try_state::<Attachments>()
        .ok_or_else(crate::media_outbound::invalid)?;
    let mut items = table.items.lock().unwrap_or_else(|p| p.into_inner());
    items.retain(|_, item| {
        crate::media_outbound::now_ms() - item.frozen.created_ms <= crate::media_outbound::TTL_MS
    });
    if items.len() >= 128
        || items
            .values()
            .filter(|item| !item.frozen.bytes.is_empty())
            .count()
            >= core_im::media_limits::MAX_FILES_PER_SEND
    {
        return Err(crate::media_outbound::invalid());
    }
    let dto = frozen.dto.clone();
    items.insert(
        dto.attachment_id.clone(),
        Attachment {
            path: None,
            temporary: false,
            frozen,
        },
    );
    Ok(dto)
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
    app.manage(DroppedFiles::default());
    // `lib.rs` already turns main's close into hide-to-tray. When the user
    // chose "退出程序" the native close (macOS red light, Alt+F4) quits.
    if let Some(main) = app.get_window(views::MAIN) {
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
) -> CmdResult<WindowChromeState> {
    guard(&state, &window, "shell_window")?;
    match action.as_str() {
        "state" => Ok(()),
        "minimize" => window.minimize().map_err(tauri_err),
        "toggle_maximize" => {
            if window.is_maximized().unwrap_or(false) {
                window.unmaximize().map_err(tauri_err)
            } else {
                window.maximize().map_err(tauri_err)
            }
        }
        "close" => close_caller_window(&app, &window).map_err(tauri_err),
        "system_menu" => show_system_menu(&window).map_err(tauri_err),
        other => Err(invalid_argument(format!("unknown window action {other:?}"))),
    }?;
    Ok(WindowChromeState {
        maximized: window.is_maximized().unwrap_or(false),
        focused: window.is_focused().unwrap_or(true),
    })
}

/// What the self-drawn caption needs to mirror the native window state.
#[derive(serde::Serialize)]
pub struct WindowChromeState {
    maximized: bool,
    focused: bool,
}

fn close_caller_window(app: &AppHandle, window: &Window) -> tauri::Result<()> {
    if window.label() == views::MAIN {
        if prefs::close_quits(app) {
            app.state::<HostState>().request_quit(app);
            Ok(())
        } else {
            window.hide()
        }
    } else {
        // Goes through CloseRequested so per-window handlers apply.
        window.close()
    }
}

/// Native menu for a right-click on the self-drawn title bar. Its Close entry
/// takes the same path as the caption button so `close_action` still applies.
#[cfg(target_os = "windows")]
fn show_system_menu(window: &Window) -> tauri::Result<()> {
    let app = window.app_handle().clone();
    let target = window.clone();
    crate::win_chrome::show_system_menu(window, move || {
        if let Err(e) = close_caller_window(&app, &target) {
            log::warn!("system menu close failed: {e}");
        }
    })
}

/// macOS keeps the native title bar, so it never reaches this action in use.
#[cfg(not(target_os = "windows"))]
fn show_system_menu(_window: &Window) -> tauri::Result<()> {
    Ok(())
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
        views::ALARM => {
            if state.alarm_snapshot().entries.is_empty() {
                return Ok(());
            }
            let corner = windows::Corner::from_bottom_right(state.settings().position_bottom_right);
            let app = app.clone();
            windows::dispatch_secondary_window(move || windows::show_alarm(&app, corner, true))
                .await
                .map_err(tauri_err)
        }
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
        || OFFICIAL_MEDIA_DOMAINS
            .iter()
            .any(|domain| host_in(&host, domain)))
    {
        return Err(reject("host is not an official domain"));
    }
    Ok(url)
}

pub(crate) fn open_in_browser(url: &Url) -> Result<(), AppError> {
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

/// Export only host-generated metadata after native checklist and save dialogs.
/// No caller-provided paths or file selection are accepted.
#[tauri::command]
pub async fn shell_export_diagnostics(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
) -> CmdResult<bool> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    guard(&state, &window, "shell_export_diagnostics")?;
    let dir = app.path().app_data_dir().map_err(tauri_err)?;
    let version = app.package_info().version.to_string();
    let bundle =
        tauri::async_runtime::spawn_blocking(move || crate::diagnostics::prepare(&dir, &version))
            .await
            .map_err(|_| diagnostic_error("无法准备诊断信息"))?
            .map_err(|_| diagnostic_error("无法读取诊断日志"))?;
    let checklist = format!(
        "{}\n仅包含版本、平台、日志时间/级别及已验证的异常标记。日志正文、账号、凭据、数据库均不导出。",
        bundle.manifest.render()
    );
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(checklist)
        .title("导出诊断信息")
        .parent(&window)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "选择保存位置".into(),
            "取消".into(),
        ))
        .show(move |confirmed| {
            let _ = tx.send(confirmed);
        });
    if !rx.await.unwrap_or(false) {
        return Ok(false);
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_parent(&window)
        .set_title("保存诊断信息")
        .set_file_name("vbooking-diagnostics.txt")
        .add_filter("诊断文本", &["txt"])
        .save_file(move |picked| {
            let _ = tx.send(picked);
        });
    let Some(path) = rx.await.ok().flatten() else {
        return Ok(false);
    };
    let path = path
        .into_path()
        .map_err(|_| diagnostic_error("无法使用该保存位置"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let text = crate::diagnostics::render(&bundle)?;
        std::fs::write(path, text)
    })
    .await
    .map_err(|_| diagnostic_error("无法保存诊断信息"))?
    .map_err(|_| diagnostic_error("无法保存诊断信息"))?;
    Ok(true)
}

fn diagnostic_error(message: &str) -> AppErrorDto {
    // OS errors can include user paths; keep those out of IPC responses.
    AppError::new(codes::HOST_UNSUPPORTED, message).into()
}

/// Open the fixed app data directory, never an arbitrary path from JavaScript.
#[tauri::command]
pub async fn shell_open_data_directory(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
) -> CmdResult<()> {
    guard(&state, &window, "shell_open_data_directory")?;
    let dir = app.path().app_data_dir().map_err(tauri_err)?;
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&dir)?;
        #[cfg(target_os = "macos")]
        let mut command = std::process::Command::new("/usr/bin/open");
        #[cfg(target_os = "windows")]
        let mut command = std::process::Command::new("explorer.exe");
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let mut command = std::process::Command::new("xdg-open");
        // Pass as one process argument, never through a command shell.
        let status = command.arg(&dir).status()?;
        if status.success() {
            Ok(())
        } else {
            Err(std::io::Error::other("directory launcher failed"))
        }
    })
    .await
    .map_err(|_| diagnostic_error("无法打开数据目录"))?
    .map_err(|_| diagnostic_error("无法打开数据目录"))
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
        // Interactive selection (-i), no shutter sound (-x). Each process
        // writes a fresh file inside its own randomly named 0700 directory.
        let capture = tauri::async_runtime::spawn_blocking(move || {
            let capture = ScreenshotFile::create()?;
            let status = std::process::Command::new("/usr/sbin/screencapture")
                .args(["-i", "-x"])
                .arg(&capture.path)
                .status()?;
            let written = std::fs::symlink_metadata(&capture.path)
                .map(|m| m.is_file() && !m.file_type().is_symlink() && m.len() > 0)
                .unwrap_or(false);
            Ok::<_, std::io::Error>((capture, status.success() && written))
        })
        .await;
        let (capture, written) = match capture {
            Ok(Ok(capture)) => capture,
            _ => {
                crate::adapter::release_media_target(&app, &account, &gid, &target).await;
                return Err(AppError::new(codes::HOST_UNSUPPORTED, "screencapture failed").into());
            }
        };
        if !written {
            crate::adapter::release_media_target(&app, &account, &gid, &target).await;
            return Ok(None);
        }
        let result = register_attachment(
            &app,
            capture.path.clone(),
            true,
            "image".into(),
            account.clone(),
            gid.clone(),
            target.clone(),
        )
        .await;
        // The immutable memory snapshot now owns the selected bytes, including
        // when a late target validation rejects the selection.
        tauri::async_runtime::spawn_blocking(move || drop(capture))
            .await
            .map_err(|_| invalid_argument("screenshot cleanup failed"))?;
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
        // Matches the content check in `media_outbound`, so the picker never offers
        // a format the snapshot refuses (BMP/HEIC can still go through "文件").
        "image" => Ok(Some(("图片", &["png", "jpg", "jpeg", "gif", "webp"]))),
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

/// Paths the OS handed to the main window in the latest drop. The page only gets
/// a name and count, and redeems `drop_id` for an attachment in its current
/// conversation; it can never name a path itself.
#[derive(Default)]
struct DroppedFiles(Mutex<Option<(u64, PathBuf)>>);
static DROP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

const MEDIA_DRAG: &str = "media://drag"; // {active}
const MEDIA_DROPPED: &str = "media://dropped"; // {drop_id, name, count}

/// Images go out as image messages; everything else, videos included, as files.
fn kind_for_dropped(path: &std::path::Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp") {
        "image"
    } else {
        "file"
    }
}

pub fn on_main_drag_drop(app: &AppHandle, event: &tauri::DragDropEvent) {
    use tauri::DragDropEvent as D;
    // macOS also reports drags without files (selected text in the page).
    let active = matches!(event, D::Enter { paths, .. } if !paths.is_empty());
    if !matches!(event, D::Over { .. }) {
        crate::events::to_main(app, MEDIA_DRAG, serde_json::json!({ "active": active }));
    }
    let D::Drop { paths, .. } = event else {
        return;
    };
    if paths.is_empty() {
        return;
    }
    let files: Vec<&PathBuf> = paths.iter().filter(|p| p.is_file()).collect();
    let Some(first) = files.first() else {
        crate::events::toast(app, "只能拖入文件，不支持文件夹");
        return;
    };
    let id = DROP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    let name = first
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if let Some(table) = app.try_state::<DroppedFiles>() {
        *table.0.lock().unwrap_or_else(|p| p.into_inner()) = Some((id, (*first).clone()));
    }
    crate::events::to_main(
        app,
        MEDIA_DROPPED,
        serde_json::json!({ "drop_id": id, "name": name, "count": files.len() }),
    );
}

#[tauri::command(rename_all = "snake_case")]
pub async fn media_accept_drop(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
    account: AccountContextDto,
    gid: String,
    drop_id: u64,
) -> CmdResult<Option<AttachmentDto>> {
    guard(&state, &window, "media_accept_drop")?;
    let account: contracts::AccountContext = account.into();
    state
        .lock()
        .accounts
        .validate(&account)
        .map_err(AppErrorDto::from)?;
    let path = app.try_state::<DroppedFiles>().and_then(|table| {
        let mut slot = table.0.lock().unwrap_or_else(|p| p.into_inner());
        match slot.take() {
            Some((id, path)) if id == drop_id => Some(path),
            other => {
                *slot = other;
                None
            }
        }
    });
    let Some(path) = path else {
        return Ok(None);
    };
    let target = crate::adapter::capture_media_target(&app, &account, &gid)
        .await
        .map_err(AppErrorDto::from)?;
    let kind = kind_for_dropped(&path);
    let mut result = register_attachment(
        &app,
        path.clone(),
        false,
        kind.to_string(),
        account.clone(),
        gid.clone(),
        target.clone(),
    )
    .await;
    // An image the image rules refuse (too large, content mismatch) can still go as a file.
    if kind == "image" && result.is_err() {
        result = register_attachment(
            &app,
            path,
            false,
            "file".into(),
            account.clone(),
            gid.clone(),
            target.clone(),
        )
        .await;
    }
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
            if let Some(path) = item.path {
                let _ = std::fs::remove_file(path);
            }
        }
        crate::adapter::release_media_target(&app, &account, &gid, &item.frozen.target).await;
        let release_app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            crate::adapter::release_unused_attachment(&release_app, &item.frozen)
        })
        .await
        .map_err(|_| invalid_argument("attachment cleanup failed"))?
        .map_err(AppErrorDto::from)?;
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

/// Local file behind an `attachment_id` from `media_pick` / `media_accept_drop`
/// (for the later send path). None when unknown.
pub fn attachment_path(app: &AppHandle, id: &str) -> Option<PathBuf> {
    let table = app.try_state::<Attachments>()?;
    let items = table.items.lock().unwrap_or_else(|p| p.into_inner());
    items.get(id).and_then(|a| a.path.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_picker_offers_only_formats_the_snapshot_accepts() {
        let (_, extensions) = filter_for("image").ok().flatten().unwrap();
        assert_eq!(extensions, ["png", "jpg", "jpeg", "gif", "webp"]);
        for extension in extensions {
            assert_eq!(
                kind_for_dropped(std::path::Path::new(&format!("a.{extension}"))),
                "image"
            );
        }
    }

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
        assert!(filter_for("file").unwrap().is_none());
        assert!(filter_for("video").is_err());
        assert!(filter_for("exe").is_err());
    }

    #[test]
    fn dropped_videos_and_unknown_types_become_files() {
        let kind = |name: &str| kind_for_dropped(std::path::Path::new(name));
        assert_eq!(kind("a.PNG"), "image");
        assert_eq!(kind("a.jpeg"), "image");
        assert_eq!(kind("clip.mp4"), "file");
        assert_eq!(kind("a.heic"), "file");
        assert_eq!(kind("no-extension"), "file");
    }

    fn annotation_fixture() -> (
        HashMap<String, Attachment>,
        FrozenAttachment,
        FrozenAttachment,
    ) {
        use contracts::{AccountContext, AccountId, Environment};
        let account = AccountContext::new(
            AccountId::new("synthetic-account"),
            Environment::named("synthetic-env"),
            1,
        );
        let target = |token: &str| MediaTarget {
            target_token: token.into(),
            identity_sha256: "a".repeat(64),
            sender_id: "self".into(),
        };
        // These tests exercise table liveness/token ownership; the boundary
        // decoder tests validate complete PNG compression separately.
        let source = FrozenAttachment::from_annotated_png(
            b"\x89PNG\r\n\x1a\nsource".to_vec(),
            &account,
            "room",
            target("source-token"),
        )
        .unwrap();
        let derived = FrozenAttachment::from_annotated_png(
            b"\x89PNG\r\n\x1a\nresult".to_vec(),
            &account,
            "room",
            target("derived-token"),
        )
        .unwrap();
        let items = [(
            source.dto.attachment_id.clone(),
            Attachment {
                path: None,
                temporary: false,
                frozen: source.clone(),
            },
        )]
        .into_iter()
        .collect();
        (items, source, derived)
    }

    #[test]
    fn derived_attachment_has_no_path_and_source_release_cannot_revoke_its_independent_target() {
        let (mut items, source, derived) = annotation_fixture();
        let dto = insert_derived(&mut items, &source, derived).unwrap();
        assert_ne!(dto.attachment_id, source.dto.attachment_id);
        let released = items.remove(&source.dto.attachment_id).unwrap();
        let derived = &items[&dto.attachment_id];
        assert!(derived.path.is_none());
        assert!(!derived.temporary);
        assert_ne!(
            released.frozen.target.target_token,
            derived.frozen.target.target_token
        );
        assert!(!derived.frozen.bytes.is_empty());
        let owner = derived.frozen.dto.owner.account.clone().into();
        derived.frozen.validate(&owner, "room").unwrap();
    }

    #[test]
    fn released_consumed_expired_or_cross_owner_source_cannot_admit_a_derived_handle() {
        let (mut items, source, derived) = annotation_fixture();
        items
            .get_mut(&source.dto.attachment_id)
            .unwrap()
            .frozen
            .bytes = std::sync::Arc::new(Vec::new());
        assert!(insert_derived(&mut items, &source, derived.clone()).is_err());
        assert_eq!(items.len(), 1);
        let (mut items, source, derived) = annotation_fixture();
        items
            .get_mut(&source.dto.attachment_id)
            .unwrap()
            .frozen
            .created_ms -= crate::media_outbound::TTL_MS + 1;
        assert!(insert_derived(&mut items, &source, derived).is_err());
        let (mut items, source, mut derived) = annotation_fixture();
        derived.dto.owner.gid = "foreign-room".into();
        assert!(insert_derived(&mut items, &source, derived).is_err());
        let (mut items, source, mut derived) = annotation_fixture();
        derived.dto.owner.account.session_generation += 1;
        assert!(insert_derived(&mut items, &source, derived).is_err());
        let (mut items, source, derived) = annotation_fixture();
        items.clear();
        assert!(insert_derived(&mut items, &source, derived).is_err());
    }

    #[test]
    fn derived_table_rejects_shared_tokens_or_changed_target_identity() {
        let (mut items, source, mut derived) = annotation_fixture();
        derived.target.target_token = source.target.target_token.clone();
        assert!(insert_derived(&mut items, &source, derived).is_err());
        let (mut items, source, mut derived) = annotation_fixture();
        derived.target.identity_sha256 = "b".repeat(64);
        assert!(insert_derived(&mut items, &source, derived).is_err());
        let (mut items, source, mut derived) = annotation_fixture();
        derived.target.sender_id = "foreign-self".into();
        assert!(insert_derived(&mut items, &source, derived).is_err());
    }
    #[test]
    fn screenshot_temp_paths_are_unique_private_and_raii_cleaned() {
        let a = ScreenshotFile::create().unwrap();
        let b = ScreenshotFile::create().unwrap();
        assert_ne!(a.path, b.path);
        assert!(!a.path.exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&a.dir).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        std::fs::write(&a.path, b"synthetic screenshot").unwrap();
        let dir = a.dir.clone();
        drop(a);
        assert!(!dir.exists());
        let dir = b.dir.clone();
        drop(b);
        assert!(!dir.exists());
    }
}

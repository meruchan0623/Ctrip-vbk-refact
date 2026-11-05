//! Viewer right-click "复制文件 / 复制视频": the renderer only names an index
//! into the gallery the host bound to it. The host shows the platform's native
//! context menu, re-downloads the item (CDN allowlist, no cookies/referer) into
//! its own temp folder and puts that file on the system clipboard, so Finder /
//! Explorer / chat apps can paste it. URLs and paths never reach the renderer.

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use contracts::AppError;
use tauri::menu::{ContextMenu, Menu, MenuEvent, MenuItem};
use tauri::{AppHandle, Emitter, State, Window};

use crate::dto::AppErrorDto;
use crate::state::HostState;
use crate::views;

const MENU_COPY: &str = "media_viewer_copy";
const EVENT: &str = "media-viewer://copy";
const MAX_VIDEO_BYTES: u64 = 300 * 1024 * 1024;
const KEEP_FOR: Duration = Duration::from_secs(24 * 3600);

#[derive(Debug, Clone)]
struct Pending {
    index: usize,
    kind: String,
    url: String,
}
static PENDING: Mutex<Option<Pending>> = Mutex::new(None);

fn failed(message: &str) -> AppError {
    AppError::new("media.copy_failed", message)
}

#[tauri::command(rename_all = "snake_case")]
pub fn media_viewer_context_menu(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
    index: usize,
) -> Result<(), AppErrorDto> {
    state
        .authorize(window.label(), "media_viewer_context_menu")
        .map_err(AppErrorDto::from)?;
    if window.label() != views::MEDIA_VIEWER {
        return Err(failed("此窗口不能复制附件").into());
    }
    let gallery = crate::media_viewer::current(&app).map_err(AppErrorDto::from)?;
    let Some(item) = gallery.items.get(index) else {
        return Ok(());
    };
    let label = match item.kind.as_str() {
        "image" => "复制文件",
        "video" => "复制视频",
        _ => return Ok(()),
    };
    *PENDING.lock().unwrap_or_else(|e| e.into_inner()) = Some(Pending {
        index,
        kind: item.kind.clone(),
        url: item.url.clone(),
    });
    let build = || -> tauri::Result<()> {
        let entry = MenuItem::with_id(&app, MENU_COPY, label, true, None::<&str>)?;
        Menu::with_items(&app, &[&entry])?.popup(window.clone())
    };
    build().map_err(|_| AppErrorDto::from(failed("无法显示右键菜单")))
}

pub fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    if event.id().as_ref() != MENU_COPY {
        return;
    }
    let Some(pending) = PENDING.lock().unwrap_or_else(|e| e.into_inner()).take() else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = app.emit_to(views::MEDIA_VIEWER, EVENT, "copying");
        let outcome = match copy(&app, &pending).await {
            Ok(()) => "copied",
            Err(e) => {
                log::warn!("media copy failed: {}", e.code);
                "failed"
            }
        };
        let _ = app.emit_to(views::MEDIA_VIEWER, EVENT, outcome);
    });
}

fn still_bound(app: &AppHandle, pending: &Pending) -> Result<(), AppError> {
    let gallery = crate::media_viewer::current(app)?;
    match gallery.items.get(pending.index) {
        Some(item) if item.url == pending.url => Ok(()),
        _ => Err(failed("附件预览已变化")),
    }
}

fn video_extension(url: &tauri::Url) -> &'static str {
    let path = url.path().to_ascii_lowercase();
    ["mov", "webm", "m4v"]
        .into_iter()
        .find(|ext| path.ends_with(&format!(".{ext}")))
        .unwrap_or("mp4")
}

fn sweep(root: &std::path::Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .is_some_and(|age| age > KEEP_FOR);
        if old {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

async fn download_video(url: tauri::Url, path: &std::path::Path) -> Result<(), AppError> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|_| failed("无法准备下载"))?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|_| failed("下载失败"))?;
    if response.status() != reqwest::StatusCode::OK
        || response
            .content_length()
            .is_some_and(|n| n > MAX_VIDEO_BYTES)
    {
        return Err(failed("下载失败或超过大小限制"));
    }
    let mut file = fs::File::create(path).map_err(|_| failed("无法写入临时文件"))?;
    let mut total = 0u64;
    while let Some(chunk) = response.chunk().await.map_err(|_| failed("下载失败"))? {
        total += chunk.len() as u64;
        if total > MAX_VIDEO_BYTES {
            return Err(failed("超过大小限制"));
        }
        file.write_all(&chunk)
            .map_err(|_| failed("无法写入临时文件"))?;
    }
    file.sync_all().map_err(|_| failed("无法写入临时文件"))
}

async fn copy(app: &AppHandle, pending: &Pending) -> Result<(), AppError> {
    let url = crate::media_save::image_url(&pending.url)?;
    still_bound(app, pending)?;
    let root = std::env::temp_dir().join("vbooking-clipboard");
    sweep(&root);
    let dir = root.join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&dir).map_err(|_| failed("无法创建临时目录"))?;
    let path: PathBuf = if pending.kind == "video" {
        let path = dir.join(format!("vbooking-video.{}", video_extension(&url)));
        if let Err(e) = download_video(url, &path).await {
            let _ = fs::remove_dir_all(&dir);
            return Err(e);
        }
        path
    } else {
        let (bytes, kind) = crate::media_save::download(url).await?;
        let path = dir.join(format!("vbooking-image.{}", kind.extension()));
        fs::write(&path, bytes).map_err(|_| failed("无法写入临时文件"))?;
        path
    };
    if let Err(e) = still_bound(app, pending) {
        let _ = fs::remove_dir_all(&dir);
        return Err(e);
    }
    let file = path.to_string_lossy().into_owned();
    tauri::async_runtime::spawn_blocking(move || {
        use clipboard_rs::{Clipboard, ClipboardContext};
        ClipboardContext::new()
            .and_then(|ctx| ctx.set_files(vec![file]))
            .map_err(|_| failed("无法写入剪贴板"))
    })
    .await
    .map_err(|_| failed("无法写入剪贴板"))?
}

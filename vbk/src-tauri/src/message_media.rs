//! Native image actions resolve their source in the host cache. Neither URLs nor file paths
//! can be supplied by the UI. Bytes stay in memory until a native save dialog grants a path.
use crate::adapter::{self, display::UiMessageDto};
use crate::dto::{AccountContextDto, AppErrorDto};
use crate::state::HostState;
use contracts::{AccountContext, AppError};
use image::{ImageFormat, ImageReader};
use serde::Serialize;
use std::borrow::Cow;
use std::io::Cursor;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager, State, Window};
use tauri_plugin_dialog::DialogExt;

type CmdResult<T> = Result<T, AppErrorDto>;
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const MAX_CLIPBOARD_TEXT_BYTES: usize = 1024 * 1024;
const MAX_IMAGE_SIDE: u32 = 8192;
const MAX_IMAGE_PIXELS: u64 = 16 * 1024 * 1024;
const ALLOWED_IMAGE_DOMAINS: [&str; 3] = ["ctrip.com", "tripcdn.com", "c-ctrip.com"];

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageActionStatus {
    Copied,
    Saved,
    Cancelled,
}
#[derive(Serialize)]
pub struct ImageActionResult {
    pub status: ImageActionStatus,
}

fn error(code: &str, message: &str) -> AppError {
    AppError::new(code, message)
}
fn invalid() -> AppError {
    error("im.invalid_image", "此消息没有可用的图片")
}
fn stale() -> AppError {
    error("im.invalid_message", "消息或会话已变化，请重新选择图片")
}

fn image_url(value: &str) -> Result<reqwest::Url, AppError> {
    let url = reqwest::Url::parse(value).map_err(|_| invalid())?;
    let host = url.host_str().ok_or_else(invalid)?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(443)
        || !ALLOWED_IMAGE_DOMAINS
            .iter()
            .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
    {
        return Err(invalid());
    }
    Ok(url)
}

#[derive(Clone)]
struct ImageSource {
    message: UiMessageDto,
    revision: Option<String>,
    active_visit_epoch: u64,
    url: reqwest::Url,
}
impl ImageSource {
    fn capture(
        app: &AppHandle,
        account: &AccountContext,
        gid: &str,
        id: &str,
    ) -> Result<Self, AppError> {
        let active_visit_epoch = crate::login::active_visit_epoch(app).ok_or_else(stale)?;
        let host = app.state::<HostState>();
        host.lock().accounts.validate(account)?;
        let (message, revision) = adapter::cached_message(app, account, gid, id)?;
        if message.kind != "image" {
            return Err(invalid());
        }
        let url = image_url(
            message
                .media_url
                .as_deref()
                .filter(|url| !url.is_empty())
                .unwrap_or(&message.text),
        )?;
        if crate::login::active_visit_epoch(app) != Some(active_visit_epoch) {
            return Err(stale());
        }
        Ok(Self {
            message,
            revision,
            active_visit_epoch,
            url,
        })
    }
    fn ensure(
        &self,
        app: &AppHandle,
        account: &AccountContext,
        gid: &str,
        id: &str,
    ) -> Result<(), AppError> {
        let current = Self::capture(app, account, gid, id)?;
        if same_resource(self, &current) {
            Ok(())
        } else {
            Err(stale())
        }
    }
}

fn same_resource(old: &ImageSource, current: &ImageSource) -> bool {
    old.active_visit_epoch == current.active_visit_epoch
        && old.revision == current.revision
        && old.url == current.url
        && old.message.gid == current.message.gid
        && old.message.message_id == current.message.message_id
        && old.message.create_time_ms == current.message.create_time_ms
        && old.message.sender_id == current.message.sender_id
}

async fn download(url: reqwest::Url) -> Result<Vec<u8>, AppError> {
    let client = crate::net_policy::apply(reqwest::Client::builder())
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(25))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 4 || image_url(attempt.url().as_str()).is_err() {
                attempt.error("image redirect refused")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|_| error("im.image_download_failed", "无法准备图片下载"))?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|_| error("im.image_download_failed", "图片下载失败，请检查网络后重试"))?;
    if !response.status().is_success() {
        return Err(error(
            "im.image_download_failed",
            "图片无法下载，服务器返回失败",
        ));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_IMAGE_BYTES as u64)
    {
        return Err(error("im.image_too_large", "图片超过 10 MB，无法处理"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| error("im.image_download_failed", "图片下载中断，请重试"))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_IMAGE_BYTES {
            return Err(error("im.image_too_large", "图片超过 10 MB，无法处理"));
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.is_empty() {
        return Err(invalid());
    }
    Ok(bytes)
}

struct DecodedImage {
    rgba: image::RgbaImage,
    format: ImageFormat,
}
fn decode(bytes: &[u8]) -> Result<DecodedImage, AppError> {
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err(invalid());
    }
    let format = image::guess_format(bytes).map_err(|_| invalid())?;
    if !matches!(
        format,
        ImageFormat::Png
            | ImageFormat::Jpeg
            | ImageFormat::Gif
            | ImageFormat::WebP
            | ImageFormat::Bmp
    ) {
        return Err(invalid());
    }
    let dimensions = ImageReader::with_format(Cursor::new(bytes), format)
        .into_dimensions()
        .map_err(|_| invalid())?;
    if dimensions.0 == 0
        || dimensions.1 == 0
        || dimensions.0 > MAX_IMAGE_SIDE
        || dimensions.1 > MAX_IMAGE_SIDE
        || u64::from(dimensions.0) * u64::from(dimensions.1) > MAX_IMAGE_PIXELS
    {
        return Err(error("im.image_too_large", "图片尺寸过大，无法处理"));
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_SIDE);
    limits.max_image_height = Some(MAX_IMAGE_SIDE);
    limits.max_alloc = Some(96 * 1024 * 1024);
    reader.limits(limits);
    let rgba = reader.decode().map_err(|_| invalid())?.to_rgba8();
    Ok(DecodedImage { rgba, format })
}
fn extension(format: ImageFormat) -> &'static str {
    match format {
        ImageFormat::Jpeg => "jpg",
        ImageFormat::Gif => "gif",
        ImageFormat::WebP => "webp",
        ImageFormat::Bmp => "bmp",
        _ => "png",
    }
}
fn filename(name: Option<&str>, format: ImageFormat) -> String {
    let name = name
        .unwrap_or("image")
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("image");
    let stem = name.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(name);
    let stem: String = stem
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
        })
        .take(80)
        .collect();
    let stem = stem.trim().trim_matches('.').trim();
    format!(
        "{}.{}",
        if stem.is_empty() { "image" } else { stem },
        extension(format)
    )
}

#[tauri::command(rename_all = "snake_case")]
pub async fn im_copy_message_image(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
    account: AccountContextDto,
    gid: String,
    message_id: String,
) -> CmdResult<ImageActionResult> {
    state
        .authorize(window.label(), "im_copy_message_image")
        .map_err(AppErrorDto::from)?;
    let account = account.into();
    let source =
        ImageSource::capture(&app, &account, &gid, &message_id).map_err(AppErrorDto::from)?;
    let bytes = download(source.url.clone())
        .await
        .map_err(AppErrorDto::from)?;
    source
        .ensure(&app, &account, &gid, &message_id)
        .map_err(AppErrorDto::from)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), AppError> {
        let image = decode(&bytes)?;
        source.ensure(&app, &account, &gid, &message_id)?;
        with_clipboard(|clipboard| {
            source.ensure(&app, &account, &gid, &message_id)?;
            clipboard
                .set_image(arboard::ImageData {
                    width: image.rgba.width() as usize,
                    height: image.rgba.height() as usize,
                    bytes: Cow::Owned(image.rgba.into_raw()),
                })
                .map_err(|_| error("im.image_copy_failed", "图片复制失败，请重试"))
        })?;
        Ok(())
    })
    .await
    .map_err(|_| AppErrorDto::from(error("im.image_copy_failed", "图片复制任务失败")))?
    .map_err(AppErrorDto::from)?;
    Ok(ImageActionResult {
        status: ImageActionStatus::Copied,
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn im_save_message_image(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
    account: AccountContextDto,
    gid: String,
    message_id: String,
) -> CmdResult<ImageActionResult> {
    state
        .authorize(window.label(), "im_save_message_image")
        .map_err(AppErrorDto::from)?;
    let account = account.into();
    let source =
        ImageSource::capture(&app, &account, &gid, &message_id).map_err(AppErrorDto::from)?;
    let bytes = download(source.url.clone())
        .await
        .map_err(AppErrorDto::from)?;
    source
        .ensure(&app, &account, &gid, &message_id)
        .map_err(AppErrorDto::from)?;
    let (bytes, format) = tauri::async_runtime::spawn_blocking(move || {
        decode(&bytes).map(|image| (bytes, image.format))
    })
    .await
    .map_err(|_| AppErrorDto::from(error("im.image_save_failed", "图片读取任务失败")))?
    .map_err(AppErrorDto::from)?;
    source
        .ensure(&app, &account, &gid, &message_id)
        .map_err(AppErrorDto::from)?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_parent(&window)
        .set_title("保存图片")
        .set_file_name(filename(source.message.media_filename.as_deref(), format))
        .add_filter("图片", &[extension(format)])
        .save_file(move |picked| {
            let _ = tx.send(picked);
        });
    let picked = rx.await.map_err(|_| {
        AppErrorDto::from(error("im.image_save_failed", "保存对话框已关闭，请重试"))
    })?;
    let Some(path) = picked else {
        return Ok(ImageActionResult {
            status: ImageActionStatus::Cancelled,
        });
    };
    let path = path
        .into_path()
        .map_err(|_| AppErrorDto::from(error("im.image_save_failed", "无法使用所选保存位置")))?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), AppError> {
        source.ensure(&app, &account, &gid, &message_id)?;
        std::fs::write(path, bytes)
            .map_err(|_| error("im.image_save_failed", "图片保存失败，请检查保存位置"))
    })
    .await
    .map_err(|_| AppErrorDto::from(error("im.image_save_failed", "图片保存任务失败")))?
    .map_err(AppErrorDto::from)?;
    Ok(ImageActionResult {
        status: ImageActionStatus::Saved,
    })
}

// Retaining one shared owner is required where the clipboard serves data lazily.
fn with_clipboard<T>(
    action: impl FnOnce(&mut arboard::Clipboard) -> Result<T, AppError>,
) -> Result<T, AppError> {
    static CLIPBOARD: OnceLock<Mutex<Option<arboard::Clipboard>>> = OnceLock::new();
    let mut slot = CLIPBOARD
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| error("host.clipboard_unavailable", "无法访问系统剪贴板"))?;
    if slot.is_none() {
        *slot = Some(
            arboard::Clipboard::new()
                .map_err(|_| error("host.clipboard_unavailable", "无法访问系统剪贴板"))?,
        );
    }
    action(slot.as_mut().unwrap())
}
fn bounded_text(text: String) -> Result<String, AppError> {
    if text.len() > MAX_CLIPBOARD_TEXT_BYTES {
        Err(error(
            "host.clipboard_text_too_large",
            "剪贴板文字超过 1 MB，无法处理",
        ))
    } else {
        Ok(text)
    }
}

#[tauri::command]
pub async fn shell_read_clipboard_text(
    window: Window,
    state: State<'_, HostState>,
) -> CmdResult<String> {
    state
        .authorize(window.label(), "shell_read_clipboard_text")
        .map_err(AppErrorDto::from)?;
    tauri::async_runtime::spawn_blocking(|| {
        with_clipboard(|clipboard| match clipboard.get_text() {
            Ok(text) => bounded_text(text),
            Err(arboard::Error::ContentNotAvailable) => Ok(String::new()),
            Err(_) => Err(error(
                "host.clipboard_unavailable",
                "读取系统剪贴板失败，请重试",
            )),
        })
    })
    .await
    .map_err(|_| AppErrorDto::from(error("host.clipboard_unavailable", "读取剪贴板任务失败")))?
    .map_err(AppErrorDto::from)
}

#[tauri::command]
pub async fn shell_write_clipboard_text(
    window: Window,
    state: State<'_, HostState>,
    text: String,
) -> CmdResult<()> {
    state
        .authorize(window.label(), "shell_write_clipboard_text")
        .map_err(AppErrorDto::from)?;
    let text = bounded_text(text).map_err(AppErrorDto::from)?;
    tauri::async_runtime::spawn_blocking(move || {
        with_clipboard(|clipboard| {
            clipboard
                .set_text(text)
                .map_err(|_| error("host.clipboard_unavailable", "写入系统剪贴板失败，请重试"))
        })
    })
    .await
    .map_err(|_| AppErrorDto::from(error("host.clipboard_unavailable", "写入剪贴板任务失败")))?
    .map_err(AppErrorDto::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn png(width: u32, height: u32) -> Vec<u8> {
        let image = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            width,
            height,
            image::Rgba([1, 2, 3, 255]),
        ));
        let mut data = Cursor::new(Vec::new());
        image.write_to(&mut data, ImageFormat::Png).unwrap();
        data.into_inner()
    }
    #[test]
    fn image_download_urls_require_https_and_an_exact_platform_host_boundary() {
        for url in [
            "https://images4.c-ctrip.com/a.png",
            "https://dimg04.tripcdn.com/a.webp",
            "https://ctrip.com/a.jpg",
        ] {
            assert!(image_url(url).is_ok(), "{url}");
        }
        for url in [
            "http://images4.c-ctrip.com/a.png",
            "https://ctrip.com.evil.test/a.png",
            "https://evilctrip.com/a.png",
            "https://127.0.0.1/a.png",
            "https://user@images4.c-ctrip.com/a.png",
            "https://images4.c-ctrip.com:8443/a.png",
            "file:///tmp/a.png",
            "data:image/png;base64,aaaa",
        ] {
            assert!(image_url(url).is_err(), "{url}");
        }
    }
    #[test]
    fn downloaded_image_must_decode_and_clipboard_is_real_rgba() {
        let decoded = decode(&png(2, 3)).unwrap();
        assert_eq!(decoded.format, ImageFormat::Png);
        assert_eq!(decoded.rgba.dimensions(), (2, 3));
        assert_eq!(decoded.rgba.as_raw().len(), 24);
        assert_eq!(&decoded.rgba.as_raw()[0..4], &[1, 2, 3, 255]);
        assert!(decode(b"<html>not an image</html>").is_err());
        assert!(decode(&[]).is_err());
        assert!(decode(&vec![0; MAX_IMAGE_BYTES + 1]).is_err());
        assert!(decode(&png(MAX_IMAGE_SIDE + 1, 1)).is_err());
    }
    fn source() -> ImageSource {
        ImageSource {
            message: serde_json::from_value(serde_json::json!({
                "gid": "room", "message_id": "server-image", "local_id": null,
                "create_time_ms": 1700000000000_i64, "sender_role": "customer", "sender_id": "customer",
                "kind": "image", "text": "", "media_url": "https://images4.c-ctrip.com/photo.png"
            })).unwrap(),
            revision: Some("service-1".into()),
            active_visit_epoch: 1,
            url: image_url("https://images4.c-ctrip.com/photo.png").unwrap(),
        }
    }
    #[test]
    fn stale_message_resource_and_service_are_rejected_but_profile_updates_are_allowed() {
        let original = source();
        let mut changed = original.clone();
        changed.revision = Some("service-2".into());
        assert!(!same_resource(&original, &changed));
        let mut changed = original.clone();
        changed.url = image_url("https://images4.c-ctrip.com/other.png").unwrap();
        assert!(!same_resource(&original, &changed));
        let mut changed = original.clone();
        changed.message.create_time_ms += 1;
        assert!(!same_resource(&original, &changed));
        let mut changed = original.clone();
        changed.message.sender_id = "other-customer".into();
        assert!(!same_resource(&original, &changed));
        let mut changed = original.clone();
        changed.message.sender_name = Some("Updated name".into());
        assert!(same_resource(&original, &changed));
    }
    #[test]
    fn account_aba_never_restores_the_old_image_action_even_with_identical_message_data() {
        let original = source();
        let mut current = original.clone();
        current.active_visit_epoch += 2;
        assert!(!same_resource(&original, &current));
        let native_source = include_str!("message_media.rs");
        let capture = native_source
            .split("    fn capture(")
            .nth(1)
            .unwrap()
            .split("    fn ensure(")
            .next()
            .unwrap();
        assert_eq!(
            capture
                .matches("crate::login::active_visit_epoch(app)")
                .count(),
            2,
            "capture checks the visit before and after cache access"
        );
    }
    #[test]
    fn clipboard_text_limit_counts_bytes_and_allows_empty_text() {
        assert!(bounded_text(String::new()).is_ok());
        assert!(bounded_text("a".repeat(MAX_CLIPBOARD_TEXT_BYTES)).is_ok());
        assert!(bounded_text("a".repeat(MAX_CLIPBOARD_TEXT_BYTES + 1)).is_err());
        assert!(bounded_text("图".repeat(MAX_CLIPBOARD_TEXT_BYTES / 3 + 1)).is_err());
    }
    #[test]
    fn saved_name_is_a_basename_with_the_actual_image_extension() {
        assert_eq!(
            filename(Some("../../secret.txt"), ImageFormat::Png),
            "secret.png"
        );
        assert_eq!(
            filename(Some("C:\\private\\photo.jpeg"), ImageFormat::WebP),
            "photo.webp"
        );
        assert_eq!(filename(Some(".."), ImageFormat::Gif), "image.gif");
        assert_eq!(
            filename(Some(" bad\n:file?.txt "), ImageFormat::Jpeg),
            "badfile.jpg"
        );
    }
}

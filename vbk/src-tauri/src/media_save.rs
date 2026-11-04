//! Image save boundary ("另存"). The standalone viewer window names only an
//! index into the gallery the host bound to it; the account, conversation,
//! message identity, source URL and destination path all stay host-owned. The
//! main window can save a local annotation export by attachment handle.
//! Display transforms are deliberately unrelated to these commands. No
//! cookies, tokens or referer are sent.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use contracts::{AccountContext, AppError};
use serde::Serialize;
use tauri::{AppHandle, Manager, State, Url, Window};
use tauri_plugin_dialog::DialogExt;

use crate::dto::{AccountContextDto, AppErrorDto};
use crate::state::HostState;
use crate::views;

const MAX_BYTES: usize = 20 * 1024 * 1024;
const COMMAND: &str = "media_save_image";
fn refused(message: &str) -> AppError {
    AppError::new("media.save_refused", message)
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct SaveImageResult {
    pub saved: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ImageKind {
    Png,
    Jpeg,
    Gif,
    Webp,
    Bmp,
}
impl ImageKind {
    fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpg",
            Self::Gif => "gif",
            Self::Webp => "webp",
            Self::Bmp => "bmp",
        }
    }
    fn detect(bytes: &[u8]) -> Result<Self, AppError> {
        if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            Ok(Self::Png)
        } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
            Ok(Self::Jpeg)
        } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
            Ok(Self::Gif)
        } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
            Ok(Self::Webp)
        } else if bytes.len() >= 14 && bytes.starts_with(b"BM") {
            Ok(Self::Bmp)
        } else {
            Err(refused("不支持保存该图片格式"))
        }
    }
}

fn image_url(raw: &str) -> Result<Url, AppError> {
    if !raw.is_ascii() || raw.bytes().any(|b| b <= 0x20 || b == 0x7f || b == b'\\') {
        return Err(refused("图片地址不受支持"));
    }
    let url = Url::parse(raw).map_err(|_| refused("图片地址不受支持"))?;
    let host = url.host_str().unwrap_or_default();
    let authority_has_userinfo = raw.split_once("://").is_some_and(|(_, tail)| {
        tail.split(['/', '?', '#'])
            .next()
            .unwrap_or_default()
            .contains('@')
    });
    let valid_labels = host.len() <= 253
        && host.split('.').all(|label| {
            !label.is_empty()
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        });
    let allowed = ["ctrip.com", "c-ctrip.com", "tripcdn.com"]
        .iter()
        .any(|root| {
            host == *root
                || host
                    .strip_suffix(root)
                    .is_some_and(|prefix| prefix.ends_with('.'))
        });
    if url.scheme() != "https"
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || authority_has_userinfo
        || !valid_labels
        || !allowed
    {
        return Err(refused("图片地址不受支持"));
    }
    Ok(url)
}
fn validate_message_id(gid: &str, message_id: &str) -> Result<(), AppError> {
    if [gid, message_id]
        .iter()
        .any(|id| id.is_empty() || id.len() > 128 || id.chars().any(char::is_control))
    {
        return Err(refused("图片消息标识无效"));
    }
    Ok(())
}
fn current_scope(
    accounts: &core_account::AccountRegistry,
    ctx: &AccountContext,
) -> Result<(), AppError> {
    accounts.validate(ctx)
}
fn validate_scope(state: &HostState, ctx: &AccountContext) -> Result<(), AppError> {
    current_scope(&state.lock().accounts, ctx)
}
fn append_chunk(bytes: &mut Vec<u8>, chunk: &[u8]) -> Result<(), AppError> {
    if chunk.len() > MAX_BYTES.saturating_sub(bytes.len()) {
        return Err(refused("图片超过保存大小限制"));
    }
    bytes.extend_from_slice(chunk);
    Ok(())
}
fn validate_response(status: reqwest::StatusCode, length: Option<u64>) -> Result<(), AppError> {
    // Unsolicited partial content is not a complete original image.
    if status != reqwest::StatusCode::OK {
        return Err(refused("图片下载失败"));
    }
    if length.is_some_and(|size| size > MAX_BYTES as u64) {
        return Err(refused("图片超过保存大小限制"));
    }
    Ok(())
}
async fn download(url: Url) -> Result<(Vec<u8>, ImageKind), AppError> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|_| refused("无法准备图片下载"))?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|_| refused("图片下载失败"))?;
    validate_response(response.status(), response.content_length())?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| refused("图片下载失败"))?
    {
        append_chunk(&mut bytes, &chunk)?;
    }
    let kind = ImageKind::detect(&bytes)?;
    Ok((bytes, kind))
}

struct PendingFile(PathBuf);
impl Drop for PendingFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
/// Same-directory create-new temp + sync + rename keeps failures from leaving a
/// partial destination. A final authorization check runs before publication.
fn write_atomic(
    path: &Path,
    bytes: &[u8],
    authorize: impl FnOnce() -> Result<(), AppError>,
) -> Result<(), AppError> {
    if path.file_name().is_none() {
        return Err(refused("无法使用该保存位置"));
    }
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| refused("无法使用该保存位置"))?;
    let temp_path = parent.join(format!(".vbooking-image-{}.tmp", uuid::Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temp_path)
        .map_err(|_| refused("无法保存图片"))?;
    let temp = PendingFile(temp_path);
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| refused("无法保存图片"))?;
    drop(file);
    authorize()?;
    fs::rename(&temp.0, path).map_err(|_| refused("无法保存图片"))?;
    Ok(())
}

/// Save the original of the image at `index` in the viewer's bound gallery.
/// Only the viewer window may call this; nothing but the index is renderer input.
#[tauri::command(rename_all = "snake_case")]
pub async fn media_save_image(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
    index: usize,
) -> Result<SaveImageResult, AppErrorDto> {
    state
        .authorize(window.label(), COMMAND)
        .map_err(AppErrorDto::from)?;
    if window.label() != views::MEDIA_VIEWER {
        return Err(refused("此窗口不能保存图片").into());
    }
    let source = crate::media_viewer::save_source(&app, index).map_err(AppErrorDto::from)?;
    let (ctx, gid, message_id) = (&source.owner, &source.gid, &source.message_id);
    validate_message_id(gid, message_id).map_err(AppErrorDto::from)?;
    validate_scope(&state, ctx).map_err(AppErrorDto::from)?;
    let raw =
        crate::adapter::cached_image_url(&app, ctx, gid, message_id).map_err(AppErrorDto::from)?;
    let url = image_url(&raw).map_err(AppErrorDto::from)?;
    let (bytes, kind) = download(url).await.map_err(AppErrorDto::from)?;
    // The visit may have ended or the gallery been replaced during the download.
    crate::media_viewer::save_source_still_bound(&app, index, &source)
        .map_err(AppErrorDto::from)?;
    validate_scope(&state, ctx).map_err(AppErrorDto::from)?;
    let extension = kind.extension();
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_parent(&window)
        .set_title("保存原图")
        .set_file_name(format!("vbooking-image.{extension}"))
        .add_filter("图片", &[extension])
        .save_file(move |picked| {
            let _ = tx.send(picked);
        });
    let Some(path) = rx.await.ok().flatten() else {
        return Ok(SaveImageResult { saved: false });
    };
    crate::media_viewer::save_source_still_bound(&app, index, &source)
        .map_err(AppErrorDto::from)?;
    let path = path
        .into_path()
        .map_err(|_| AppErrorDto::from(refused("无法使用该保存位置")))?;
    let save_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        write_atomic(&path, &bytes, || {
            validate_scope(&save_app.state::<HostState>(), &source.owner)?;
            crate::media_viewer::save_source_still_bound(&save_app, index, &source)
        })
    })
    .await
    .map_err(|_| AppErrorDto::from(refused("无法保存图片")))?
    .map_err(AppErrorDto::from)?;
    Ok(SaveImageResult { saved: true })
}

/// Save an already-local image snapshot (including a confirmed annotation
/// export). No renderer path or URL is accepted, and saving never consumes it.
#[tauri::command(rename_all = "snake_case")]
pub async fn media_save_attachment(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
    account: AccountContextDto,
    gid: String,
    attachment_id: String,
) -> Result<SaveImageResult, AppErrorDto> {
    state
        .authorize(window.label(), "media_save_attachment")
        .map_err(AppErrorDto::from)?;
    if window.label() != crate::views::MAIN {
        return Err(refused("此窗口不能保存图片").into());
    }
    let ctx: AccountContext = account.into();
    let read = || -> Result<crate::media_outbound::FrozenAttachment, AppError> {
        validate_scope(&state, &ctx)?;
        let frozen = crate::shell::frozen_attachment(&app, &attachment_id, &ctx, &gid)?;
        frozen.validate(&ctx, &gid)?;
        if frozen.dto.kind != "image" || frozen.bytes.is_empty() || frozen.bytes.len() > MAX_BYTES {
            return Err(refused("图片附件不可用"));
        }
        Ok(frozen)
    };
    let frozen = read().map_err(AppErrorDto::from)?;
    crate::adapter::validate_media_target(&app, &ctx, &gid, &frozen.target)
        .await
        .map_err(AppErrorDto::from)?;
    let extension = ImageKind::detect(&frozen.bytes)
        .map_err(AppErrorDto::from)?
        .extension();
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_parent(&window)
        .set_title("保存图片")
        .set_file_name(format!("vbooking-image.{extension}"))
        .add_filter("图片", &[extension])
        .save_file(move |picked| {
            let _ = tx.send(picked);
        });
    let Some(path) = rx.await.ok().flatten() else {
        return Ok(SaveImageResult { saved: false });
    };
    let frozen = read().map_err(AppErrorDto::from)?;
    crate::adapter::validate_media_target(&app, &ctx, &gid, &frozen.target)
        .await
        .map_err(AppErrorDto::from)?;
    let path = path
        .into_path()
        .map_err(|_| AppErrorDto::from(refused("无法使用该保存位置")))?;
    let save_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        write_atomic(&path, &frozen.bytes, || {
            validate_scope(&save_app.state::<HostState>(), &ctx)?;
            crate::shell::frozen_attachment(&save_app, &attachment_id, &ctx, &gid)?
                .validate(&ctx, &gid)
        })
    })
    .await
    .map_err(|_| AppErrorDto::from(refused("无法保存图片")))?
    .map_err(AppErrorDto::from)?;
    Ok(SaveImageResult { saved: true })
}

#[cfg(test)]
mod tests {
    use super::*;
    use contracts::Environment;
    use core_account::{AccountRegistry, Buid, UpstreamIdentity};

    #[test]
    fn url_allowlist_rejects_credentials_ip_ports_schemes_and_host_tricks() {
        for good in [
            "https://ctrip.com/image.png",
            "https://a.c-ctrip.com/a?x=1",
            "https://img.tripcdn.com:443/a",
        ] {
            assert!(image_url(good).is_ok(), "{good}");
        }
        for bad in [
            "http://ctrip.com/a",
            "https://ctrip.com:444/a",
            "https://user@ctrip.com/a",
            "https://user:pass@ctrip.com/a",
            "https://127.0.0.1/a",
            "https://[::1]/a",
            "https://ctrip.com.evil.test/a",
            "https://evilctrip.com/a",
            "https://tsim.com/a",
            "https://ctrip.com/a#fragment",
            "https://ctrip.com\\@evil.test/a",
            "https://ctrip.com/\na",
            "data:image/png;base64,abc",
            "file:///tmp/a",
            "https://tripcdn.com./a",
            "https://@ctrip.com/a",
            "https://.ctrip.com/a",
            "https://a..ctrip.com/a",
            "https://-a.ctrip.com/a",
            "https://%63trip.com@evil.test/a",
        ] {
            assert!(image_url(bad).is_err(), "{bad}");
        }
    }
    #[test]
    fn magic_allowlist_never_accepts_svg_html_or_empty_payloads() {
        for (bytes, kind) in [
            (&b"\x89PNG\r\n\x1a\n"[..], ImageKind::Png),
            (&b"\xff\xd8\xff"[..], ImageKind::Jpeg),
            (&b"GIF89a"[..], ImageKind::Gif),
            (&b"RIFF0000WEBP"[..], ImageKind::Webp),
            (&b"BM000000000000"[..], ImageKind::Bmp),
        ] {
            assert_eq!(ImageKind::detect(bytes).unwrap(), kind);
        }
        for bytes in [
            &b""[..],
            &b"<svg xmlns='http://www.w3.org/2000/svg'/>"[..],
            &b"<html>error</html>"[..],
            &b"RIFF0000AVI "[..],
            &b"GIF"[..],
        ] {
            assert!(ImageKind::detect(bytes).is_err());
        }
    }
    #[test]
    fn response_policy_rejects_redirect_partial_and_oversized_responses() {
        validate_response(reqwest::StatusCode::OK, Some(MAX_BYTES as u64)).unwrap();
        validate_response(reqwest::StatusCode::OK, None).unwrap();
        assert!(validate_response(reqwest::StatusCode::OK, Some(MAX_BYTES as u64 + 1)).is_err());
        for code in [201, 204, 206, 301, 302, 303, 307, 308, 404, 500] {
            assert!(validate_response(reqwest::StatusCode::from_u16(code).unwrap(), None).is_err());
        }
    }

    #[test]
    fn streamed_limit_is_inclusive_and_rejects_before_appending() {
        let mut bytes = vec![0; MAX_BYTES - 1];
        append_chunk(&mut bytes, &[1]).unwrap();
        assert_eq!(bytes.len(), MAX_BYTES);
        assert!(append_chunk(&mut bytes, &[2]).is_err());
        assert_eq!(bytes.len(), MAX_BYTES);
    }
    #[test]
    fn generation_and_identity_changes_fail_later_scope_checks() {
        let mut accounts = AccountRegistry::new(1);
        let env = Environment::named("test");
        let identity = || UpstreamIdentity {
            buid: Buid::new("a"),
            uid: "u".into(),
            agent_id: None,
            environment: env.clone(),
        };
        let attempt = accounts.start_login(env.clone());
        let old = accounts
            .publish_identity(&attempt.attempt_id, identity())
            .unwrap()
            .ctx;
        current_scope(&accounts, &old).unwrap();
        let attempt = accounts.start_login(env.clone());
        let fresh = accounts
            .publish_identity(&attempt.attempt_id, identity())
            .unwrap()
            .ctx;
        assert!(current_scope(&accounts, &old).is_err());
        current_scope(&accounts, &fresh).unwrap();
        let foreign = AccountContext {
            environment: Environment::named("other"),
            ..fresh
        };
        assert!(current_scope(&accounts, &foreign).is_err());
    }
    #[test]
    fn atomic_save_keeps_old_destination_and_cleans_temp_on_stale_scope() {
        let dir = std::env::temp_dir().join(format!("vbk-image-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let path = dir.join("image.png");
        fs::write(&path, b"old").unwrap();
        assert!(write_atomic(&path, b"new", || Err(refused("stale"))).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"old");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        let fresh = dir.join("fresh.png");
        write_atomic(&fresh, b"complete", || Ok(())).unwrap();
        assert_eq!(fs::read(&fresh).unwrap(), b"complete");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 2);
        fs::remove_dir_all(dir).unwrap();
    }
}

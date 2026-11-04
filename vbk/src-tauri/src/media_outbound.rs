//! Short-lived authorized handles over immutable attachment snapshots.
//! Durable leases contain no page target credentials or session generations.
use crate::adapter::display::UiMessageDto;
use crate::dto::{AccountContextDto, SendDispositionDto};
use contracts::{AccountContext, AppError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;
use std::sync::Arc;

pub use core_im::media_contract::ATTACHMENT_CONTRACT_VERSION;
use core_im::media_limits::{self, LimitViolation, MediaKind};

/// Hard bound on bytes the host freezes in memory: the direct-upload ceiling.
/// Per-kind caps (image 10 MiB, file 30 MiB, video 300 MiB) live in
/// `core_im::media_limits`; anything above this bound would need the chunked
/// upload, which is not implemented, and is refused locally.
pub const LOCAL_CAP: usize = media_limits::DIRECT_UPLOAD_MAX_BYTES as usize;
pub const CHUNK_CAP: usize = 256 * 1024;
pub const TTL_MS: i64 = 5 * 60 * 1000;

#[derive(Clone, Serialize)]
pub struct AttachmentOwner {
    pub account: AccountContextDto,
    pub gid: String,
}
/// Contract name (docs/api/media-attachment-contract.md, v1) of [`AttachmentDto`].
pub type MediaAttachmentDto = AttachmentDto;
#[derive(Clone, Serialize)]
pub struct AttachmentDto {
    pub attachment_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease_id: Option<String>,
    pub name: String,
    pub kind: String,
    pub mime: String,
    pub size: usize,
    pub content_sha256: String,
    pub owner: AttachmentOwner,
    pub supported: bool,
    /// Small composer thumbnail (`data:image/jpeg`); images only, None if undecodable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_data_url: Option<String>,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MediaTarget {
    pub target_token: String,
    pub identity_sha256: String,
    pub sender_id: String,
}
#[derive(Clone)]
pub struct FrozenAttachment {
    pub dto: AttachmentDto,
    pub target: MediaTarget,
    pub bytes: Arc<Vec<u8>>,
    pub created_ms: i64,
}
#[derive(Clone, Serialize)]
pub struct MediaSendResult {
    #[serde(skip_serializing_if = "is_false")]
    pub replay_only: bool,
    pub stage: String,
    pub kind: String,
    pub write_started: bool,
    pub disposition: Option<SendDispositionDto>,
    pub message: Option<UiMessageDto>,
    pub error: Option<String>,
}
fn is_false(value: &bool) -> bool {
    !*value
}
impl MediaSendResult {
    pub fn blocked(stage: &str, started: bool, error: &str) -> Self {
        Self {
            replay_only: false,
            stage: stage.into(),
            kind: if started { "unknown" } else { "not_submitted" }.into(),
            write_started: stage == "send" && started,
            disposition: if stage == "send" && started {
                Some(SendDispositionDto::Unknown)
            } else {
                None
            },
            message: None,
            error: Some(error.into()),
        }
    }
    pub fn replay(stage: String, started: bool, disposition: SendDispositionDto) -> Self {
        let kind = match disposition {
            SendDispositionDto::Confirmed { .. } => "confirmed",
            SendDispositionDto::Rejected { .. } => "rejected",
            _ => "unknown",
        };
        Self {
            replay_only: false,
            stage,
            kind: kind.into(),
            write_started: started,
            disposition: Some(disposition),
            message: None,
            error: None,
        }
    }
}
pub fn invalid() -> AppError {
    AppError::new(
        "media.invalid_attachment",
        "attachment format, size, scope or lifetime is invalid (nothing submitted)",
    )
}
/// Same contract code as [`invalid`], but says which check refused the attachment
/// and logs that check. Neither the path nor the file name reaches the log.
pub fn refused(check: &str, message: &str) -> AppError {
    log::warn!("attachment refused: {check}");
    AppError::new("media.invalid_attachment", message)
}
fn unreadable(step: &str, error: &std::io::Error) -> AppError {
    log::warn!(
        "attachment refused: {step} failed ({:?}, os {:?})",
        error.kind(),
        error.raw_os_error()
    );
    AppError::new(
        "media.invalid_attachment",
        "无法读取所选文件，未发送。请确认文件可访问后重新选择。",
    )
}
/// Local limit rejection: the contract code, nothing submitted.
pub fn limit_error(violation: LimitViolation) -> AppError {
    AppError::new(
        violation.code(),
        "attachment exceeds an upload limit (nothing submitted)",
    )
}
/// Size-only admission used when a file is frozen and again by `im_send_media`.
pub fn check_size(kind: &str, size: u64) -> Result<(), AppError> {
    let kind = MediaKind::parse(kind).ok_or_else(|| limit_error(LimitViolation::UnknownKind))?;
    media_limits::check_size(kind, size)
        .and_then(|_| media_limits::check_staging(size))
        .map_err(limit_error)
}
pub fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
pub fn valid_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}
fn official_url(value: Option<&str>) -> bool {
    value
        .and_then(|s| tauri::Url::parse(s).ok())
        .map(|url| {
            url.scheme() == "https"
                && url.username().is_empty()
                && url.password().is_none()
                && url.port().map_or(true, |p| p == 443)
                && url.host_str().is_some_and(|host| {
                    ["ctrip.com", "c-ctrip.com", "tripcdn.com"]
                        .iter()
                        .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
                })
        })
        .unwrap_or(false)
}
pub fn validate_body(body: &str, kind: &str, name: &str, size: usize) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };
    match kind {
        "image" => {
            value["btype"] == 1
                && official_url(value["url"].as_str())
                && official_url(value["thumbUrl"].as_str())
                && value["width"]
                    .as_f64()
                    .is_some_and(|n| n.is_finite() && n > 0.0)
                && value["height"]
                    .as_f64()
                    .is_some_and(|n| n.is_finite() && n > 0.0)
                && value["ext"]["channel"] == "im_business"
                && value["ext"]["scene"] == "cqDA0M7F6aAGHF06jzBe"
        }
        "file" => {
            value["btype"] == 5
                && official_url(value["file"]["url"].as_str())
                && value["file"]["filename"] == name
                && value["file"]["size"].as_u64() == Some(size as u64)
        }
        "video" => {
            value["btype"] == 3
                && official_url(value["video"]["url"].as_str())
                && official_url(value["video"]["cover"].as_str())
                && value["video"]["filename"]
                    .as_str()
                    .is_some_and(|s| !s.is_empty())
                && value["video"]["size"].as_u64() == Some(size as u64)
                && value["video"]["duration"]
                    .as_f64()
                    .is_some_and(|n| n.is_finite() && n > 0.0 && n <= 180.0)
        }
        _ => false,
    }
}

pub fn validate_message(
    message: &UiMessageDto,
    disposition: &SendDispositionDto,
    body: &str,
    gid: &str,
    local: &str,
    kind: &str,
    sender: &str,
) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };
    let resource = if kind == "image" {
        &value
    } else {
        &value[kind]
    };
    let id_matches = match disposition {
        SendDispositionDto::Confirmed {
            server_message_id, ..
        } => message.message_id.as_ref() == Some(server_message_id),
        _ => message.message_id.is_none(),
    };
    message.gid == gid
        && message.local_id.as_deref() == Some(local)
        && message.sender_id == sender
        && message.sender_role == "merchant_self"
        && message.kind == kind
        && message.text.is_empty()
        && message.original.is_none()
        && message.quote.is_none()
        && message.disposition.as_ref() == Some(disposition)
        && id_matches
        && message.media_url.as_deref() == resource["url"].as_str()
        && match kind {
            "image" => message.media_thumbnail.as_deref() == value["thumbUrl"].as_str(),
            "video" => {
                message.media_thumbnail.as_deref() == resource["cover"].as_str()
                    && message.media_filename.as_deref() == resource["filename"].as_str()
            }
            "file" => message.media_filename.as_deref() == resource["filename"].as_str(),
            _ => false,
        }
}
/// Composer preview only; the bytes that get sent stay the frozen original.
fn image_preview(bytes: &[u8]) -> Option<String> {
    use base64::Engine as _;
    const EDGE: u32 = 240;
    let image = image::load_from_memory(bytes).ok()?.thumbnail(EDGE, EDGE);
    let mut jpeg = Vec::new();
    image
        .into_rgb8()
        .write_to(
            &mut std::io::Cursor::new(&mut jpeg),
            image::ImageFormat::Jpeg,
        )
        .ok()?;
    Some(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(jpeg)
    ))
}
fn mime(kind: &str, bytes: &[u8]) -> Result<&'static str, AppError> {
    match kind {
        "image" if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => Ok("image/png"),
        "image" if bytes.starts_with(b"\xff\xd8\xff") => Ok("image/jpeg"),
        "image" if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") => Ok("image/gif"),
        "image" if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" => {
            Ok("image/webp")
        }
        "video" if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" => Ok("video/mp4"),
        "file" if bytes.starts_with(b"%PDF-") => Ok("application/pdf"),
        "file" => Ok("application/octet-stream"),
        "image" => Err(refused(
            "image content is not png/jpeg/gif/webp",
            "图片仅支持 PNG、JPEG、GIF、WebP，未发送。其他格式可通过“文件”发送。",
        )),
        "video" => Err(refused(
            "video content is not mp4",
            "视频仅支持 MP4，未发送。",
        )),
        _ => Err(invalid()),
    }
}
impl FrozenAttachment {
    pub fn owns(&self, account: &AccountContext, gid: &str) -> bool {
        let owner: AccountContext = self.dto.owner.account.clone().into();
        owner == *account && self.dto.owner.gid == gid
    }
    pub fn read(
        path: &Path,
        kind: &str,
        account: &AccountContext,
        gid: &str,
        target: MediaTarget,
    ) -> Result<Self, AppError> {
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(1);
        }
        let file = options.open(path).map_err(|e| unreadable("open", &e))?;
        let before = file.metadata().map_err(|e| unreadable("metadata", &e))?;
        if !before.is_file() {
            return Err(refused("not a regular file", "只能发送普通文件，未发送。"));
        }
        check_size(kind, before.len())?;
        let mut bytes = Vec::new();
        (&file)
            .take(LOCAL_CAP as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| unreadable("read", &e))?;
        let after = file.metadata().map_err(|e| unreadable("metadata", &e))?;
        if bytes.len() != before.len() as usize
            || after.len() != before.len()
            || after.modified().ok() != before.modified().ok()
        {
            return Err(refused(
                "file changed while reading",
                "文件在读取时发生了变化，未发送。请重新选择。",
            ));
        }
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .filter(|name| {
                !name.is_empty()
                    && name.len() <= 512
                    && !name
                        .chars()
                        .any(|c| c.is_control() || c == '/' || c == '\\')
            })
            .ok_or_else(|| {
                refused(
                    "file name not accepted",
                    "文件名包含不支持的字符或过长，未发送。请改名后重新选择。",
                )
            })?
            .to_string();
        if gid.is_empty() || !valid_hash(&target.identity_sha256) {
            return Err(invalid());
        }
        let mime = mime(kind, &bytes)?.to_string();
        Ok(Self {
            dto: AttachmentDto {
                attachment_id: uuid::Uuid::new_v4().to_string(),
                lease_id: None,
                name,
                kind: kind.into(),
                mime,
                size: bytes.len(),
                content_sha256: sha256(&bytes),
                owner: AttachmentOwner {
                    account: account.into(),
                    gid: gid.into(),
                },
                supported: true,
                preview_data_url: (kind == "image").then(|| image_preview(&bytes)).flatten(),
            },
            target,
            bytes: Arc::new(bytes),
            created_ms: now_ms(),
        })
    }
    /// Construct a fresh in-memory PNG handle. The annotation boundary must
    /// fully decode and validate the PNG first; this helper freezes its exact
    /// submitted bytes and never reads a path or falls back to a source image.
    pub fn from_annotated_png(
        bytes: Vec<u8>,
        account: &AccountContext,
        gid: &str,
        target: MediaTarget,
    ) -> Result<Self, AppError> {
        check_size("image", bytes.len() as u64)?;
        if bytes.is_empty()
            || !bytes.starts_with(b"\x89PNG\r\n\x1a\n")
            || gid.is_empty()
            || target.target_token.is_empty()
            || target.sender_id.is_empty()
            || !valid_hash(&target.identity_sha256)
        {
            return Err(invalid());
        }
        Ok(Self {
            dto: AttachmentDto {
                preview_data_url: None,
                attachment_id: uuid::Uuid::new_v4().to_string(),
                lease_id: None,
                name: "annotated-screenshot.png".into(),
                kind: "image".into(),
                mime: "image/png".into(),
                size: bytes.len(),
                content_sha256: sha256(&bytes),
                owner: AttachmentOwner {
                    account: account.into(),
                    gid: gid.into(),
                },
                supported: true,
            },
            target,
            bytes: Arc::new(bytes),
            created_ms: now_ms(),
        })
    }

    pub fn validate(&self, account: &AccountContext, gid: &str) -> Result<(), AppError> {
        if !self.owns(account, gid)
            || now_ms() - self.created_ms > TTL_MS
            || self.bytes.len() != self.dto.size
            || sha256(&self.bytes) != self.dto.content_sha256
        {
            return Err(invalid());
        }
        Ok(())
    }
    pub fn payload(&self) -> crate::adapter::outbound_journal::SendPayload {
        // This canonical manifest never leaves memory: only its digest is stored.
        let text = serde_json::json!({ "kind": self.dto.kind, "name": self.dto.name, "mime": self.dto.mime, "size": self.dto.size, "content_sha256": self.dto.content_sha256, "target_sha256": self.target.identity_sha256 }).to_string();
        crate::adapter::outbound_journal::SendPayload {
            gid: self.dto.owner.gid.clone(),
            text,
            original: None,
            quote_id: None,
        }
    }
}
pub fn base64(bytes: &[u8]) -> String {
    const ABC: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let a = chunk[0];
        let b = *chunk.get(1).unwrap_or(&0);
        let c = *chunk.get(2).unwrap_or(&0);
        out.push(ABC[(a >> 2) as usize] as char);
        out.push(ABC[(((a & 3) << 4) | (b >> 4)) as usize] as char);
        out.push(if chunk.len() > 1 {
            ABC[(((b & 15) << 2) | (c >> 6)) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ABC[(c & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use contracts::{AccountId, Environment};
    struct LocalFile(std::path::PathBuf);
    impl LocalFile {
        fn new(bytes: &[u8]) -> Self {
            let path = std::env::temp_dir()
                .join(format!("vbk-synthetic-media-{}.bin", uuid::Uuid::new_v4()));
            std::fs::write(&path, bytes).unwrap();
            Self(path)
        }
    }
    impl Drop for LocalFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    fn account(generation: u64) -> AccountContext {
        AccountContext::new(
            AccountId::new("synthetic-account"),
            Environment::named("synthetic-env"),
            generation,
        )
    }
    fn target() -> MediaTarget {
        MediaTarget {
            target_token: "synthetic-target".into(),
            identity_sha256: "a".repeat(64),
            sender_id: "synthetic-self".into(),
        }
    }
    #[test]
    fn snapshot_sends_selected_bytes_after_source_changes_and_same_name_never_aliases_content() {
        let file = LocalFile::new(b"%PDF- first selected bytes");
        let first = FrozenAttachment::read(&file.0, "file", &account(1), "room", target()).unwrap();
        std::fs::write(&file.0, b"%PDF- later changed bytes").unwrap();
        let second =
            FrozenAttachment::read(&file.0, "file", &account(1), "room", target()).unwrap();
        assert_eq!(first.bytes.as_slice(), b"%PDF- first selected bytes");
        assert_eq!(first.dto.name, second.dto.name);
        assert_ne!(first.dto.attachment_id, second.dto.attachment_id);
        assert_ne!(first.dto.content_sha256, second.dto.content_sha256);
        assert_eq!(first.dto.mime, "application/pdf");
        first.validate(&account(1), "room").unwrap();
        assert_ne!(first.payload().text, second.payload().text);
    }
    #[test]
    fn generic_text_and_binary_files_preserve_raw_bytes_without_fabricating_mime_from_extension() {
        for bytes in [
            b"synthetic plain text".as_slice(),
            b"\x00\x01\xff\x00".as_slice(),
        ] {
            let file = LocalFile::new(bytes);
            let frozen =
                FrozenAttachment::read(&file.0, "file", &account(1), "room", target()).unwrap();
            assert_eq!(frozen.dto.mime, "application/octet-stream");
            assert_eq!(frozen.bytes.as_slice(), bytes);
            assert_eq!(frozen.dto.size, bytes.len());
        }
    }
    #[test]
    fn snapshot_rejects_size_format_expiry_and_every_foreign_owner_before_staging() {
        for bytes in [Vec::new(), vec![0; LOCAL_CAP + 1]] {
            let file = LocalFile::new(&bytes);
            assert!(
                FrozenAttachment::read(&file.0, "file", &account(1), "room", target()).is_err()
            );
        }
        // Per-kind caps: 10 MiB image / 30 MiB file, each with its own code.
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        png.resize(media_limits::IMAGE_MAX_BYTES as usize + 1, 0);
        let file = LocalFile::new(&png);
        let denied = FrozenAttachment::read(&file.0, "image", &account(1), "room", target())
            .err()
            .expect("image over 10 MiB is refused");
        assert_eq!(denied.code, "media.too_large");
        png.truncate(media_limits::IMAGE_MAX_BYTES as usize);
        let file = LocalFile::new(&png);
        assert!(FrozenAttachment::read(&file.0, "image", &account(1), "room", target()).is_ok());
        // A file between 10 and 30 MiB is accepted (the old flat cap was 10 MiB).
        let file = LocalFile::new(&vec![7u8; media_limits::IMAGE_MAX_BYTES as usize + 1]);
        assert!(FrozenAttachment::read(&file.0, "file", &account(1), "room", target()).is_ok());
        assert_eq!(
            check_size("audio", 1).err().unwrap().code,
            "media.unknown_kind"
        );
        assert_eq!(
            check_size("video", LOCAL_CAP as u64 + 1)
                .err()
                .unwrap()
                .code,
            "media.chunked_upload_unsupported"
        );
        let file = LocalFile::new(b"arbitrary bytes named like an image");
        let image = FrozenAttachment::read(&file.0, "image", &account(1), "room", target())
            .err()
            .expect("unsupported image content is refused");
        assert_eq!(image.code, "media.invalid_attachment");
        assert!(image.message.contains("PNG"));
        let video = FrozenAttachment::read(&file.0, "video", &account(1), "room", target())
            .err()
            .expect("unsupported video content is refused");
        assert_eq!(video.code, "media.invalid_attachment");
        assert!(video.message.contains("MP4"));
        let missing = std::env::temp_dir().join(format!("vbk-missing-{}", uuid::Uuid::new_v4()));
        let unreadable = FrozenAttachment::read(&missing, "file", &account(1), "room", target())
            .err()
            .expect("an unreadable path is refused");
        assert_eq!(unreadable.code, "media.invalid_attachment");
        assert!(unreadable.message.contains("无法读取"));
        let mut frozen =
            FrozenAttachment::read(&file.0, "file", &account(1), "room", target()).unwrap();
        assert!(frozen.validate(&account(2), "room").is_err());
        assert!(frozen.validate(&account(1), "other-room").is_err());
        let other = AccountContext::new(
            AccountId::new("other"),
            Environment::named("synthetic-env"),
            1,
        );
        assert!(frozen.validate(&other, "room").is_err());
        let other = AccountContext::new(
            AccountId::new("synthetic-account"),
            Environment::named("other-env"),
            1,
        );
        assert!(frozen.validate(&other, "room").is_err());
        frozen.created_ms -= TTL_MS + 1;
        assert!(frozen.validate(&account(1), "room").is_err());
    }
    #[test]
    fn host_accepts_only_exact_typed_official_media_bodies_and_bounded_local_transfer_encoding() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        let body = r#"{"btype":5,"file":{"filename":"synthetic.bin","url":"https://static.tripcdn.com/synthetic.bin","size":4}}"#;
        assert!(validate_body(body, "file", "synthetic.bin", 4));
        assert!(!validate_body(body, "image", "synthetic.bin", 4));
        assert!(!validate_body(body, "file", "another.bin", 4));
        assert!(!validate_body(body, "file", "synthetic.bin", 5));
        assert!(!validate_body(
            &body.replace("static.tripcdn.com", "tripcdn.com.evil.invalid"),
            "file",
            "synthetic.bin",
            4
        ));
        assert!(!validate_body(
            &body.replace("https://", "file://"),
            "file",
            "synthetic.bin",
            4
        ));
        assert!(!validate_body(
            &body.replace("https://", "https://user:secret@"),
            "file",
            "synthetic.bin",
            4
        ));
    }
}

//! Bounded local annotation boundary. No paths, upload, or send operations.
//! Canvas renders in the main window; the host validates source identity,
//! geometry and fully decoded PNGs before freezing a new independent handle.
use std::{
    io::Cursor,
    sync::{Arc, OnceLock},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use contracts::{AccountContext, AppError};
use image::{codecs::png::PngDecoder, DynamicImage, ImageDecoder};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State, Window};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::{
    dto::{AccountContextDto, AppErrorDto},
    media_outbound::{self, AttachmentDto, FrozenAttachment, MediaTarget},
    state::HostState,
};

pub const MAX_DIMENSION: u32 = 8192;
pub const MAX_PIXELS: u64 = 16 * 1024 * 1024;
pub const MAX_PNG_BYTES: usize = 10 * 1024 * 1024;
const MAX_BASE64_BYTES: usize = MAX_PNG_BYTES.div_ceil(3) * 4;
const MAX_ALLOC: u64 = 128 * 1024 * 1024;
const ERROR: &str = "media.annotation";
static WORKERS: OnceLock<Arc<Semaphore>> = OnceLock::new();

fn invalid(message: &str) -> AppError {
    AppError::new(ERROR, message)
}
fn slot() -> Result<OwnedSemaphorePermit, AppError> {
    WORKERS
        .get_or_init(|| Arc::new(Semaphore::new(2)))
        .clone()
        .try_acquire_owned()
        .map_err(|_| invalid("image editor is busy; retry shortly").retryable())
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Point {
    x: f64,
    y: f64,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Color {
    red: u8,
    green: u8,
    blue: u8,
    alpha: u8,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Stroke {
    color: Color,
    width: f64,
}
#[derive(Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Annotation {
    Rectangle {
        bounds: Rect,
        stroke: Stroke,
    },
    Ellipse {
        bounds: Rect,
        stroke: Stroke,
    },
    Arrow {
        from: Point,
        to: Point,
        head_length: f64,
        stroke: Stroke,
    },
    Pen {
        points: Vec<Point>,
        stroke: Stroke,
    },
    Text {
        bounds: Rect,
        text: String,
        font_size: f64,
        color: Color,
    },
    Mosaic {
        bounds: Rect,
        block_size: u16,
    },
}
impl From<Point> for core_media::Point {
    fn from(p: Point) -> Self {
        Self { x: p.x, y: p.y }
    }
}
impl From<Rect> for core_media::Rect {
    fn from(r: Rect) -> Self {
        Self {
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
        }
    }
}
impl From<Color> for core_media::Rgba {
    fn from(c: Color) -> Self {
        Self {
            red: c.red,
            green: c.green,
            blue: c.blue,
            alpha: c.alpha,
        }
    }
}
impl From<Stroke> for core_media::Stroke {
    fn from(s: Stroke) -> Self {
        Self {
            color: s.color.into(),
            width: s.width,
        }
    }
}
impl From<Annotation> for core_media::Annotation {
    fn from(a: Annotation) -> Self {
        match a {
            Annotation::Rectangle { bounds, stroke } => Self::Rectangle {
                bounds: bounds.into(),
                stroke: stroke.into(),
            },
            Annotation::Ellipse { bounds, stroke } => Self::Ellipse {
                bounds: bounds.into(),
                stroke: stroke.into(),
            },
            Annotation::Arrow {
                from,
                to,
                head_length,
                stroke,
            } => Self::Arrow {
                from: from.into(),
                to: to.into(),
                head_length,
                stroke: stroke.into(),
            },
            Annotation::Pen { points, stroke } => Self::Pen {
                points: points.into_iter().map(Into::into).collect(),
                stroke: stroke.into(),
            },
            Annotation::Text {
                bounds,
                text,
                font_size,
                color,
            } => Self::Text {
                bounds: bounds.into(),
                text,
                font_size,
                color: color.into(),
            },
            Annotation::Mosaic { bounds, block_size } => Self::Mosaic {
                bounds: bounds.into(),
                block_size,
            },
        }
    }
}

#[derive(Serialize)]
pub struct AnnotationSource {
    source_hash: String,
    mime: &'static str,
    width: u32,
    height: u32,
    data_base64: String,
}

fn dimensions(bytes: &[u8]) -> Result<(u32, u32), AppError> {
    if bytes.is_empty() || bytes.len() > MAX_PNG_BYTES || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(invalid(
            "only bounded PNG screenshots are supported; HEIC and other formats are not supported",
        ));
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_DIMENSION);
    limits.max_image_height = Some(MAX_DIMENSION);
    limits.max_alloc = Some(MAX_ALLOC);
    let decoder = PngDecoder::with_limits(Cursor::new(bytes), limits)
        .map_err(|_| invalid("PNG is invalid or exceeds decoder limits"))?;
    if decoder
        .is_apng()
        .map_err(|_| invalid("invalid PNG animation metadata"))?
    {
        return Err(invalid(
            "animated PNG is not supported by the screenshot editor",
        ));
    }
    let size = decoder.dimensions();
    if size.0 == 0 || size.1 == 0 || u64::from(size.0) * u64::from(size.1) > MAX_PIXELS {
        return Err(invalid("image exceeds editor pixel limits"));
    }
    // Header checks alone do not validate compressed pixels or prevent bombs.
    DynamicImage::from_decoder(decoder)
        .map_err(|_| invalid("PNG pixels could not be decoded within limits"))?;
    Ok(size)
}

fn source_payload(
    source: &FrozenAttachment,
    account: &AccountContext,
    gid: &str,
) -> Result<AnnotationSource, AppError> {
    source.validate(account, gid)?;
    if source.dto.kind != "image" || source.dto.mime != "image/png" {
        return Err(invalid(
            "only PNG screenshots can be annotated; HEIC and other formats are not supported",
        ));
    }
    let (width, height) = dimensions(&source.bytes)?;
    Ok(AnnotationSource {
        source_hash: source.dto.content_sha256.clone(),
        mime: "image/png",
        width,
        height,
        data_base64: media_outbound::base64(&source.bytes),
    })
}

fn annotation_limits(annotations: &[Annotation]) -> Result<(), AppError> {
    if annotations.len() > core_media::MAX_ANNOTATIONS {
        return Err(invalid("too many annotations"));
    }
    let mut total_points = 0;
    let mut total_text = 0;
    for annotation in annotations {
        match annotation {
            Annotation::Pen { points, .. } => {
                if points.len() > core_media::MAX_PATH_POINTS {
                    return Err(invalid("pen path exceeds point limits"));
                }
                total_points += points.len();
            }
            Annotation::Text { text, .. } => {
                if text.len() > core_media::MAX_TEXT_BYTES {
                    return Err(invalid("annotation text exceeds limits"));
                }
                total_text += text.len();
            }
            _ => {}
        }
    }
    if total_points > core_media::MAX_DOCUMENT_POINTS
        || total_text > core_media::MAX_DOCUMENT_TEXT_BYTES
    {
        return Err(invalid("annotation document exceeds limits"));
    }
    Ok(())
}

struct ApplyInput {
    source_hash: String,
    annotations: Vec<Annotation>,
    png_base64: String,
    width: u32,
    height: u32,
}
fn build_derived(
    source: &FrozenAttachment,
    account: &AccountContext,
    gid: &str,
    target: MediaTarget,
    input: ApplyInput,
) -> Result<FrozenAttachment, AppError> {
    source.validate(account, gid)?;
    if source.dto.kind != "image"
        || source.dto.mime != "image/png"
        || input.source_hash != source.dto.content_sha256
        || input.png_base64.len() > MAX_BASE64_BYTES
        || input.annotations.len() > core_media::MAX_ANNOTATIONS
        || source.target.target_token == target.target_token
        || source.target.identity_sha256 != target.identity_sha256
        || source.target.sender_id != target.sender_id
    {
        return Err(invalid(
            "annotation source, owner, target or export request is invalid",
        ));
    }
    let size = dimensions(&source.bytes)?;
    if size != (input.width, input.height) {
        return Err(invalid("export dimensions must match the source image"));
    }
    let has_annotations = !input.annotations.is_empty();
    annotation_limits(&input.annotations)?;
    let canvas = core_media::Canvas::new(size.0, size.1)
        .map_err(|_| invalid("invalid annotation canvas"))?;
    let mut document = core_media::Document::new(canvas);
    for annotation in input.annotations {
        document
            .add(annotation.into())
            .map_err(|_| invalid("annotation geometry, style or resource limits are invalid"))?;
    }
    let bytes = STANDARD
        .decode(input.png_base64)
        .map_err(|_| invalid("invalid PNG base64"))?;
    if dimensions(&bytes)? != size {
        return Err(invalid(
            "encoded PNG dimensions do not match the source image",
        ));
    }
    if has_annotations && media_outbound::sha256(&bytes) == source.dto.content_sha256 {
        return Err(invalid(
            "could not confirm changes: annotated PNG is identical to the source",
        ));
    }
    FrozenAttachment::from_annotated_png(bytes, account, gid, target)
}

fn authorize(
    state: &HostState,
    window: &Window,
    command: &str,
    account: &AccountContext,
) -> Result<(), AppError> {
    // Keep a main-only check here as well as the capability and view registry.
    if window.label() != crate::views::MAIN {
        return Err(media_outbound::invalid());
    }
    state.authorize(window.label(), command)?;
    state.lock().accounts.validate(account)?;
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn media_annotation_source(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
    account: AccountContextDto,
    gid: String,
    attachment_id: String,
) -> Result<AnnotationSource, AppErrorDto> {
    let account: AccountContext = account.into();
    authorize(&state, &window, "media_annotation_source", &account)?;
    let source = crate::shell::frozen_attachment(&app, &attachment_id, &account, &gid)?;
    crate::shell::ensure_annotation_source_live(&app, &source)?;
    crate::adapter::validate_media_target(&app, &account, &gid, &source.target).await?;
    let permit = slot()?;
    let worker_source = source.clone();
    let worker_account = account.clone();
    let worker_gid = gid.clone();
    let payload = tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        source_payload(&worker_source, &worker_account, &worker_gid)
    })
    .await
    .map_err(|_| invalid("annotation source worker failed"))??;
    authorize(&state, &window, "media_annotation_source", &account)?;
    crate::adapter::validate_media_target(&app, &account, &gid, &source.target).await?;
    authorize(&state, &window, "media_annotation_source", &account)?;
    crate::shell::ensure_annotation_source_live(&app, &source)?;
    Ok(payload)
}

#[tauri::command(rename_all = "snake_case")]
#[allow(clippy::too_many_arguments)]
pub async fn media_annotation_apply(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
    account: AccountContextDto,
    gid: String,
    attachment_id: String,
    source_hash: String,
    annotations: Vec<Annotation>,
    png_base64: String,
    width: u32,
    height: u32,
) -> Result<AttachmentDto, AppErrorDto> {
    let account: AccountContext = account.into();
    authorize(&state, &window, "media_annotation_apply", &account)?;
    if annotations.len() > core_media::MAX_ANNOTATIONS || png_base64.len() > MAX_BASE64_BYTES {
        return Err(invalid("annotation request exceeds limits").into());
    }
    annotation_limits(&annotations)?;
    let source = crate::shell::frozen_attachment(&app, &attachment_id, &account, &gid)?;
    crate::shell::ensure_annotation_source_live(&app, &source)?;
    if source_hash != source.dto.content_sha256 {
        return Err(invalid("annotation source hash changed").into());
    }
    crate::adapter::validate_media_target(&app, &account, &gid, &source.target).await?;
    let target = crate::adapter::capture_media_target(&app, &account, &gid).await?;
    let result: Result<AttachmentDto, AppError> = async {
        let permit = slot()?;
        let worker_source = source.clone();
        let worker_account = account.clone();
        let worker_gid = gid.clone();
        let worker_target = target.clone();
        let derived = tauri::async_runtime::spawn_blocking(move || {
            let _permit = permit;
            build_derived(
                &worker_source,
                &worker_account,
                &worker_gid,
                worker_target,
                ApplyInput {
                    source_hash,
                    annotations,
                    png_base64,
                    width,
                    height,
                },
            )
        })
        .await
        .map_err(|_| invalid("annotation export worker failed"))??;
        authorize(&state, &window, "media_annotation_apply", &account)?;
        crate::adapter::validate_media_target(&app, &account, &gid, &source.target).await?;
        crate::adapter::validate_media_target(&app, &account, &gid, &target).await?;
        authorize(&state, &window, "media_annotation_apply", &account)?;
        crate::shell::register_derived_attachment(&app, &source, derived)
    }
    .await;
    if result.is_err() {
        crate::adapter::release_media_target(&app, &account, &gid, &target).await;
    }
    result.map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgba};
    use serde_json::json;

    fn account(generation: u64) -> AccountContext {
        AccountContext::new(
            contracts::AccountId::new("synthetic-account"),
            contracts::Environment::named("synthetic-env"),
            generation,
        )
    }
    fn target(token: &str) -> MediaTarget {
        MediaTarget {
            target_token: token.into(),
            identity_sha256: "a".repeat(64),
            sender_id: "synthetic-self".into(),
        }
    }
    fn png(width: u32, height: u32, red: u8) -> Vec<u8> {
        let image: ImageBuffer<Rgba<u8>, _> =
            ImageBuffer::from_pixel(width, height, Rgba([red, 32, 64, 255]));
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        bytes.into_inner()
    }
    fn source() -> FrozenAttachment {
        FrozenAttachment::from_annotated_png(
            png(32, 32, 0),
            &account(1),
            "room",
            target("original-target"),
        )
        .unwrap()
    }
    fn annotations() -> Vec<Annotation> {
        serde_json::from_value(json!([
            {"type":"rectangle", "bounds":{"x":2,"y":2,"width":12,"height":12},"stroke":{"color":{"red":255,"green":0,"blue":0,"alpha":255},"width":2}},
            {"type":"ellipse", "bounds":{"x":2,"y":2,"width":12,"height":12},"stroke":{"color":{"red":255,"green":0,"blue":0,"alpha":255},"width":2}},
            {"type":"arrow", "from":{"x":4,"y":4},"to":{"x":20,"y":20},"head_length":4,"stroke":{"color":{"red":255,"green":0,"blue":0,"alpha":255},"width":2}},
            {"type":"pen", "points":[{"x":4,"y":4}],"stroke":{"color":{"red":255,"green":0,"blue":0,"alpha":255},"width":2}},
            {"type":"text", "bounds":{"x":2,"y":2,"width":12,"height":12},"text":"标注","font_size":6,"color":{"red":255,"green":0,"blue":0,"alpha":255}},
            {"type":"mosaic", "bounds":{"x":2,"y":2,"width":12,"height":12},"block_size":4}
        ])).unwrap()
    }
    fn input(source: &FrozenAttachment) -> ApplyInput {
        ApplyInput {
            source_hash: source.dto.content_sha256.clone(),
            annotations: annotations(),
            png_base64: STANDARD.encode(png(32, 32, 255)),
            width: 32,
            height: 32,
        }
    }
    fn apply(source: &FrozenAttachment, input: ApplyInput) -> Result<FrozenAttachment, AppError> {
        build_derived(source, &account(1), "room", target("derived-target"), input)
    }

    #[test]
    fn source_is_exact_png_and_six_shape_wire_types_build_a_fresh_frozen_handle() {
        let source = source();
        let payload = source_payload(&source, &account(1), "room").unwrap();
        assert_eq!((payload.width, payload.height), (32, 32));
        assert_eq!(payload.source_hash, source.dto.content_sha256);
        assert_eq!(STANDARD.decode(payload.data_base64).unwrap(), *source.bytes);
        for annotation in annotations() {
            let mut input = input(&source);
            input.annotations = vec![annotation];
            let derived = apply(&source, input).unwrap();
            assert_ne!(derived.dto.attachment_id, source.dto.attachment_id);
            assert_ne!(derived.dto.content_sha256, source.dto.content_sha256);
            assert_ne!(derived.target.target_token, source.target.target_token);
            assert_eq!(
                derived.target.identity_sha256,
                source.target.identity_sha256
            );
            assert_eq!(derived.bytes.as_slice(), png(32, 32, 255));
            derived.validate(&account(1), "room").unwrap();
        }
    }

    #[test]
    fn exact_owner_generation_gid_expiry_and_consumption_gate_source_and_apply() {
        let source = source();
        for (owner, gid) in [
            (account(2), "room"),
            (account(1), "other-room"),
            (
                AccountContext::new(
                    contracts::AccountId::new("foreign"),
                    contracts::Environment::named("synthetic-env"),
                    1,
                ),
                "room",
            ),
        ] {
            assert!(source_payload(&source, &owner, gid).is_err());
            assert!(
                build_derived(&source, &owner, gid, target("derived"), input(&source)).is_err()
            );
        }
        let mut expired = source.clone();
        expired.created_ms -= media_outbound::TTL_MS + 1;
        assert!(source_payload(&expired, &account(1), "room").is_err());
        assert!(apply(&expired, input(&expired)).is_err());
        let mut consumed = source.clone();
        consumed.bytes = Arc::new(Vec::new());
        assert!(source_payload(&consumed, &account(1), "room").is_err());
        assert!(apply(&consumed, input(&consumed)).is_err());
    }

    #[test]
    fn hash_and_claimed_or_encoded_dimensions_must_match_without_original_fallback() {
        let source = source();
        let mut wrong_hash = input(&source);
        wrong_hash.source_hash = "b".repeat(64);
        assert!(apply(&source, wrong_hash).is_err());
        let mut wrong_claim = input(&source);
        wrong_claim.width = 31;
        assert!(apply(&source, wrong_claim).is_err());
        let mut wrong_pixels = input(&source);
        wrong_pixels.png_base64 = STANDARD.encode(png(16, 16, 255));
        assert!(apply(&source, wrong_pixels).is_err());
        let mut unrendered = input(&source);
        unrendered.png_base64 = STANDARD.encode(source.bytes.as_slice());
        let error = apply(&source, unrendered).err().unwrap();
        assert!(error.message.contains("could not confirm changes"));
        let mut broken_render = input(&source);
        broken_render.png_base64 = "broken".into();
        assert!(apply(&source, broken_render).is_err());
        assert_eq!(*source.bytes, png(32, 32, 0));
    }

    #[test]
    fn explicit_confirmation_without_annotations_still_creates_independent_handle() {
        let source = source();
        let mut request = input(&source);
        request.annotations.clear();
        request.png_base64 = STANDARD.encode(source.bytes.as_slice());
        let derived = apply(&source, request).unwrap();
        assert_ne!(derived.dto.attachment_id, source.dto.attachment_id);
        assert_ne!(derived.target.target_token, source.target.target_token);
        assert_eq!(derived.bytes.as_slice(), source.bytes.as_slice());
    }

    #[test]
    fn source_and_new_target_must_share_identity_but_never_share_token() {
        let source = source();
        assert!(build_derived(
            &source,
            &account(1),
            "room",
            source.target.clone(),
            input(&source)
        )
        .is_err());
        let mut other_identity = target("independent");
        other_identity.identity_sha256 = "b".repeat(64);
        assert!(
            build_derived(&source, &account(1), "room", other_identity, input(&source)).is_err()
        );
        let mut other_sender = target("independent");
        other_sender.sender_id = "another-self".into();
        assert!(build_derived(&source, &account(1), "room", other_sender, input(&source)).is_err());
    }

    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = !0u32;
        for &byte in bytes {
            crc ^= u32::from(byte);
            for _ in 0..8 {
                crc = (crc >> 1) ^ (0xedb88320 & (0u32.wrapping_sub(crc & 1)));
            }
        }
        !crc
    }
    fn replace_size(mut bytes: Vec<u8>, width: u32, height: u32) -> Vec<u8> {
        bytes[16..20].copy_from_slice(&width.to_be_bytes());
        bytes[20..24].copy_from_slice(&height.to_be_bytes());
        let crc = crc32(&bytes[12..29]);
        bytes[29..33].copy_from_slice(&crc.to_be_bytes());
        bytes
    }
    #[test]
    fn decoder_rejects_dimension_bombs_pixel_bombs_truncated_data_and_unsupported_formats() {
        let valid = png(32, 32, 0);
        assert!(dimensions(&replace_size(valid.clone(), MAX_DIMENSION + 1, 32)).is_err());
        let error = dimensions(&replace_size(valid.clone(), 8192, 8192)).unwrap_err();
        assert!(error.message.contains("pixel limits"));
        let mut animated = valid.clone();
        let mut animation = b"acTL".to_vec();
        animation.extend_from_slice(&1u32.to_be_bytes());
        animation.extend_from_slice(&0u32.to_be_bytes());
        let mut chunk = 8u32.to_be_bytes().to_vec();
        chunk.extend_from_slice(&animation);
        chunk.extend_from_slice(&crc32(&animation).to_be_bytes());
        animated.splice(33..33, chunk);
        assert!(dimensions(&animated)
            .unwrap_err()
            .message
            .contains("animated PNG"));
        assert!(dimensions(&valid[..33]).is_err());
        assert!(dimensions(b"\0\0\0\x18ftypheic").is_err());
        let mut unsupported = source();
        unsupported.dto.mime = "image/heic".into();
        assert!(source_payload(&unsupported, &account(1), "room")
            .err()
            .unwrap()
            .message
            .contains("HEIC"));
        assert!(dimensions(&vec![0; MAX_PNG_BYTES + 1]).is_err());
        let mut corrupt = valid;
        // Preserve PNG header/dimensions; damage compressed pixels.
        let idat = corrupt.windows(4).position(|s| s == b"IDAT").unwrap();
        corrupt[idat + 5] ^= 0xff;
        assert!(dimensions(&corrupt).is_err());
    }

    #[test]
    fn geometry_wire_and_document_limits_are_enforced_before_export() {
        let source = source();
        let mut request = input(&source);
        request.annotations = vec![Annotation::Mosaic {
            bounds: Rect {
                x: 30.0,
                y: 30.0,
                width: 8.0,
                height: 8.0,
            },
            block_size: 4,
        }];
        assert!(apply(&source, request).is_err());
        let mut request = input(&source);
        request.annotations = vec![Annotation::Pen {
            points: vec![Point { x: 4.0, y: 4.0 }; core_media::MAX_PATH_POINTS + 1],
            stroke: Stroke {
                color: Color {
                    red: 255,
                    green: 0,
                    blue: 0,
                    alpha: 255,
                },
                width: 2.0,
            },
        }];
        assert!(apply(&source, request).is_err());
        assert!(serde_json::from_value::<Annotation>(json!({"type":"mosaic","bounds":{"x":1,"y":1,"width":2,"height":2},"block_size":2,"untrusted":true})).is_err());
        let mut request = input(&source);
        request.annotations = vec![annotations()[0].clone(); core_media::MAX_ANNOTATIONS + 1];
        assert!(apply(&source, request).is_err());
        let mut request = input(&source);
        request.png_base64 = "A".repeat(MAX_BASE64_BYTES + 1);
        assert!(apply(&source, request).is_err());
    }

    #[test]
    fn decoder_slot_is_held_by_worker_even_if_async_caller_stops_waiting() {
        use std::{sync::mpsc, time::Duration};
        let permit = slot().unwrap();
        let second = slot().unwrap();
        let (started, start_rx) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let (finished, finish_rx) = mpsc::channel();
        let worker = tauri::async_runtime::spawn_blocking(move || {
            let held = permit;
            started.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            drop(held);
            finished.send(()).unwrap();
        });
        start_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        // Dropping the command's await handle cannot admit a third decoder
        // while the detached blocking worker still owns its permit.
        drop(worker);
        assert!(slot().is_err());
        release.send(()).unwrap();
        finish_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(slot().is_ok());
        drop(second);
    }
    #[test]
    fn tauri_annotation_commands_keep_the_shared_wire_argument_names() {
        // Exercise the macro declaration boundary that helper tests bypass.
        // Tauri otherwise rewrites attachment_id/source_hash/png_base64 to
        // camelCase, while the shared DTO/client intentionally sends snake_case.
        let source = include_str!("media_annotation.rs");
        for command in ["media_annotation_source", "media_annotation_apply"] {
            let signature = format!("pub async fn {command}(");
            let declaration = &source[..source.find(&signature).unwrap()];
            assert!(declaration
                .rsplit("#[tauri::command")
                .next()
                .unwrap()
                .starts_with(r#"(rename_all = "snake_case")]"#));
        }
        let wire = include_str!("../../ui/packages/ipc/src/annotation.ts");
        for field in ["attachment_id", "source_hash", "png_base64"] {
            assert!(wire.contains(&format!("{field}: string")));
        }
    }
}

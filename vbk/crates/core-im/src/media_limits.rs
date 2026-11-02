//! Official upload limits as pure, std-only functions (I-14).
//!
//! Source of the numbers: the official desktop client (图片 10 MiB、文件
//! 30 MiB、视频 300 MiB 且 ≤ 3 分钟、单次 ≤ 10 个文件、视频分片 5 MiB、直传阈值
//! 30 MiB). Every check here runs locally *before* anything is staged,
//! uploaded or journaled, so a violation is always "nothing submitted".
//! The host (`media_outbound.rs`) and the TS mirror
//! (`web-adapter/src/media-limits.ts`) both follow this table; the contract
//! tests lock the three copies together.

pub const MIB: u64 = 1024 * 1024;
pub const IMAGE_MAX_BYTES: u64 = 10 * MIB;
pub const FILE_MAX_BYTES: u64 = 30 * MIB;
pub const VIDEO_MAX_BYTES: u64 = 300 * MIB;
/// Video duration limit, milliseconds (three minutes, inclusive).
pub const VIDEO_MAX_DURATION_MS: u64 = 180_000;
/// Maximum number of attachments in one send action.
pub const MAX_FILES_PER_SEND: usize = 10;
/// Part size of the chunked video upload.
pub const VIDEO_CHUNK_BYTES: u64 = 5 * MIB;
/// Largest body that is uploaded in one request (inclusive). Anything larger
/// must be chunked.
pub const DIRECT_UPLOAD_MAX_BYTES: u64 = 30 * MIB;

/// Local rejection codes. Every one means "nothing was submitted".
pub mod codes {
    pub const MEDIA_EMPTY: &str = "media.empty";
    pub const MEDIA_TOO_LARGE: &str = "media.too_large";
    pub const MEDIA_VIDEO_TOO_LONG: &str = "media.video_too_long";
    pub const MEDIA_VIDEO_DURATION_UNKNOWN: &str = "media.video_duration_unknown";
    pub const MEDIA_TOO_MANY_FILES: &str = "media.too_many_files";
    pub const MEDIA_CHUNKED_UNSUPPORTED: &str = "media.chunked_upload_unsupported";
    pub const MEDIA_UNKNOWN_KIND: &str = "media.unknown_kind";
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaKind {
    Image,
    File,
    Video,
}

impl MediaKind {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "image" => Some(Self::Image),
            "file" => Some(Self::File),
            "video" => Some(Self::Video),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::File => "file",
            Self::Video => "video",
        }
    }
    pub fn max_bytes(self) -> u64 {
        match self {
            Self::Image => IMAGE_MAX_BYTES,
            Self::File => FILE_MAX_BYTES,
            Self::Video => VIDEO_MAX_BYTES,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LimitViolation {
    UnknownKind,
    Empty,
    TooLarge {
        kind: MediaKind,
        size: u64,
        max: u64,
    },
    VideoTooLong {
        duration_ms: u64,
        max_ms: u64,
    },
    /// A video whose duration could not be decoded is never uploaded.
    VideoDurationUnknown,
    TooManyFiles {
        count: usize,
        max: usize,
    },
    /// Within the official limit but above what this build can stage:
    /// chunked upload is specified (5 MiB parts) but not implemented.
    ChunkedUnsupported {
        size: u64,
    },
}

impl LimitViolation {
    pub fn code(&self) -> &'static str {
        match self {
            Self::UnknownKind => codes::MEDIA_UNKNOWN_KIND,
            Self::Empty => codes::MEDIA_EMPTY,
            Self::TooLarge { .. } => codes::MEDIA_TOO_LARGE,
            Self::VideoTooLong { .. } => codes::MEDIA_VIDEO_TOO_LONG,
            Self::VideoDurationUnknown => codes::MEDIA_VIDEO_DURATION_UNKNOWN,
            Self::TooManyFiles { .. } => codes::MEDIA_TOO_MANY_FILES,
            Self::ChunkedUnsupported { .. } => codes::MEDIA_CHUNKED_UNSUPPORTED,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UploadPlan {
    /// One request carrying the whole body.
    Direct,
    /// Sequential parts of `chunk_bytes`; `chunks` is the part count.
    Chunked { chunk_bytes: u64, chunks: u64 },
}

/// Size/duration admission for one attachment. `duration_ms` is only
/// consulted for video; `None` for a video is a rejection.
pub fn check_attachment(
    kind: MediaKind,
    size: u64,
    duration_ms: Option<u64>,
) -> Result<(), LimitViolation> {
    if size == 0 {
        return Err(LimitViolation::Empty);
    }
    if size > kind.max_bytes() {
        return Err(LimitViolation::TooLarge {
            kind,
            size,
            max: kind.max_bytes(),
        });
    }
    if kind == MediaKind::Video {
        match duration_ms {
            None | Some(0) => return Err(LimitViolation::VideoDurationUnknown),
            Some(d) if d > VIDEO_MAX_DURATION_MS => {
                return Err(LimitViolation::VideoTooLong {
                    duration_ms: d,
                    max_ms: VIDEO_MAX_DURATION_MS,
                })
            }
            Some(_) => {}
        }
    }
    Ok(())
}

/// Same, from the wire spelling of the kind.
pub fn check_attachment_str(
    kind: &str,
    size: u64,
    duration_ms: Option<u64>,
) -> Result<(), LimitViolation> {
    check_attachment(
        MediaKind::parse(kind).ok_or(LimitViolation::UnknownKind)?,
        size,
        duration_ms,
    )
}

/// At most [`MAX_FILES_PER_SEND`] attachments per send action (`count == 0`
/// is not a violation: there is simply nothing to send).
pub fn check_batch(count: usize) -> Result<(), LimitViolation> {
    if count > MAX_FILES_PER_SEND {
        Err(LimitViolation::TooManyFiles {
            count,
            max: MAX_FILES_PER_SEND,
        })
    } else {
        Ok(())
    }
}

/// Official upload shape for an attachment already admitted by
/// [`check_attachment`]: ≤ 30 MiB direct, larger (video only, since image and
/// file caps are ≤ 30 MiB) in 5 MiB parts.
pub fn plan_upload(size: u64) -> UploadPlan {
    if size <= DIRECT_UPLOAD_MAX_BYTES {
        UploadPlan::Direct
    } else {
        UploadPlan::Chunked {
            chunk_bytes: VIDEO_CHUNK_BYTES,
            chunks: size.div_ceil(VIDEO_CHUNK_BYTES),
        }
    }
}

/// Byte range `[start, end)` of part `index` of a chunked upload.
pub fn chunk_range(size: u64, index: u64) -> Option<(u64, u64)> {
    let start = index.checked_mul(VIDEO_CHUNK_BYTES)?;
    if start >= size {
        return None;
    }
    Some((start, (start + VIDEO_CHUNK_BYTES).min(size)))
}

/// What this build can actually send: [`check_attachment`] plus a refusal of
/// anything [`plan_upload`] would chunk, because chunked upload is not
/// implemented yet. Remove the second step when it is.
pub fn check_sendable(
    kind: MediaKind,
    size: u64,
    duration_ms: Option<u64>,
) -> Result<(), LimitViolation> {
    check_attachment(kind, size, duration_ms)?;
    match plan_upload(size) {
        UploadPlan::Direct => Ok(()),
        UploadPlan::Chunked { .. } => Err(LimitViolation::ChunkedUnsupported { size }),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    fn official_table_is_exact() {
        assert_eq!(IMAGE_MAX_BYTES, 10_485_760);
        assert_eq!(FILE_MAX_BYTES, 31_457_280);
        assert_eq!(VIDEO_MAX_BYTES, 314_572_800);
        assert_eq!(VIDEO_CHUNK_BYTES, 5_242_880);
        assert_eq!(DIRECT_UPLOAD_MAX_BYTES, 31_457_280);
        assert_eq!(VIDEO_MAX_DURATION_MS, 180_000);
        assert_eq!(MAX_FILES_PER_SEND, 10);
    }

    #[test]
    fn size_boundaries_are_inclusive_per_kind() {
        for (kind, max) in [
            (MediaKind::Image, IMAGE_MAX_BYTES),
            (MediaKind::File, FILE_MAX_BYTES),
            (MediaKind::Video, VIDEO_MAX_BYTES),
        ] {
            let d = Some(1000);
            assert_eq!(check_attachment(kind, max, d), Ok(()));
            assert_eq!(check_attachment(kind, 1, d), Ok(()));
            assert_eq!(
                check_attachment(kind, max + 1, d),
                Err(LimitViolation::TooLarge {
                    kind,
                    size: max + 1,
                    max
                })
            );
            assert_eq!(check_attachment(kind, 0, d), Err(LimitViolation::Empty));
        }
        // An image-sized limit does not leak into files and vice versa.
        assert!(check_attachment(MediaKind::Image, 10 * MIB + 1, None).is_err());
        assert!(check_attachment(MediaKind::File, 10 * MIB + 1, None).is_ok());
    }

    #[test]
    fn video_duration_is_mandatory_and_capped_at_three_minutes() {
        let size = MIB;
        assert_eq!(
            check_attachment(MediaKind::Video, size, Some(180_000)),
            Ok(())
        );
        assert_eq!(
            check_attachment(MediaKind::Video, size, Some(180_001)),
            Err(LimitViolation::VideoTooLong {
                duration_ms: 180_001,
                max_ms: 180_000
            })
        );
        for missing in [None, Some(0)] {
            assert_eq!(
                check_attachment(MediaKind::Video, size, missing),
                Err(LimitViolation::VideoDurationUnknown)
            );
        }
        // Duration is irrelevant for image/file.
        assert_eq!(check_attachment(MediaKind::File, size, None), Ok(()));
        assert_eq!(
            check_attachment(MediaKind::Image, size, Some(999_999)),
            Ok(())
        );
    }

    #[test]
    fn batch_cap_is_ten() {
        assert_eq!(check_batch(0), Ok(()));
        assert_eq!(check_batch(10), Ok(()));
        assert_eq!(
            check_batch(11),
            Err(LimitViolation::TooManyFiles { count: 11, max: 10 })
        );
    }

    #[test]
    fn direct_threshold_and_five_mib_parts() {
        assert_eq!(plan_upload(1), UploadPlan::Direct);
        assert_eq!(plan_upload(30 * MIB), UploadPlan::Direct);
        assert_eq!(
            plan_upload(30 * MIB + 1),
            UploadPlan::Chunked {
                chunk_bytes: 5 * MIB,
                chunks: 7
            }
        );
        assert_eq!(
            plan_upload(300 * MIB),
            UploadPlan::Chunked {
                chunk_bytes: 5 * MIB,
                chunks: 60
            }
        );
    }

    #[test]
    fn chunk_ranges_tile_the_body_exactly() {
        for size in [30 * MIB + 1, 35 * MIB, 300 * MIB, 300 * MIB - 7] {
            let UploadPlan::Chunked { chunks, .. } = plan_upload(size) else {
                panic!("expected chunked")
            };
            let mut next = 0;
            for i in 0..chunks {
                let (s, e) = chunk_range(size, i).unwrap();
                assert_eq!(s, next);
                assert!(e > s && e - s <= VIDEO_CHUNK_BYTES);
                next = e;
            }
            assert_eq!(next, size);
            assert_eq!(chunk_range(size, chunks), None);
        }
        assert_eq!(chunk_range(10, u64::MAX), None);
    }

    #[test]
    fn sendable_refuses_what_only_chunking_could_carry() {
        assert_eq!(check_sendable(MediaKind::Video, 30 * MIB, Some(1)), Ok(()));
        let big = 30 * MIB + 1;
        let err = check_sendable(MediaKind::Video, big, Some(1)).unwrap_err();
        assert_eq!(err, LimitViolation::ChunkedUnsupported { size: big });
        assert_eq!(err.code(), codes::MEDIA_CHUNKED_UNSUPPORTED);
        // Over the official cap is the more specific error.
        assert_eq!(
            check_sendable(MediaKind::Video, 300 * MIB + 1, Some(1))
                .unwrap_err()
                .code(),
            codes::MEDIA_TOO_LARGE
        );
    }

    #[test]
    fn wire_kinds_round_trip_and_unknown_kind_is_rejected() {
        for k in [MediaKind::Image, MediaKind::File, MediaKind::Video] {
            assert_eq!(MediaKind::parse(k.as_str()), Some(k));
        }
        assert_eq!(
            check_attachment_str("audio", 1, None),
            Err(LimitViolation::UnknownKind)
        );
        assert_eq!(check_attachment_str("file", 1, None), Ok(()));
    }
}

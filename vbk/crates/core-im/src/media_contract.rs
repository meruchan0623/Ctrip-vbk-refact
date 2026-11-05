//! Attachment registration contract, version 1 (I-14), std-only.
//!
//! The prose is `docs/api/media-attachment-contract.md`; this module is its
//! machine-checkable twin. The tests at the bottom parse the document and
//! fail when either side drifts, so a field, code or limit can only change
//! together with `ATTACHMENT_CONTRACT_VERSION` and a notice to I-05b (recovery
//! boundary).

use crate::media_limits::{self, MediaKind};

/// Bump on *any* change to the DTO fields, error codes, send-result values,
/// upload authorization model or unknown semantics below.
pub const ATTACHMENT_CONTRACT_VERSION: u32 = 1;

/// Wire fields of `MediaAttachmentDto` (Rust `AttachmentDto`, TS `UiAttachment`).
pub const ATTACHMENT_DTO_FIELDS: [&str; 8] = [
    "attachment_id",
    "name",
    "kind",
    "mime",
    "size",
    "content_sha256",
    "owner",
    "supported",
];
/// Fields of `owner`.
pub const ATTACHMENT_OWNER_FIELDS: [&str; 2] = ["account", "gid"];
/// Wire fields of the `im_send_media` result (`MediaSendResult`).
pub const SEND_RESULT_FIELDS: [&str; 7] = [
    "replay_only",
    "stage",
    "kind",
    "write_started",
    "disposition",
    "message",
    "error",
];
pub const SEND_STAGES: [&str; 3] = ["prepare", "upload", "send"];
pub const SEND_RESULT_KINDS: [&str; 4] = ["not_submitted", "unknown", "confirmed", "rejected"];

/// Error codes of the media path. Local rejections (first group) always mean
/// "nothing was submitted".
pub mod codes {
    pub use crate::media_limits::codes::*;
    /// Format, size, scope or lifetime of a registered attachment is invalid.
    pub const MEDIA_INVALID_ATTACHMENT: &str = "media.invalid_attachment";
    /// Terminal `rejected` disposition recorded for a failed upload.
    pub const MEDIA_UPLOAD_REJECTED: &str = "media.upload_rejected";
    /// The record was committed but the follow-up durability barrier failed.
    /// Distinct from `unknown`: the host *knows* what it wrote and that no
    /// dispatch was admitted on this call; the row is neither rolled back
    /// nor reported as an unknown send.
    pub const IM_JOURNAL_BARRIER_FAILED: &str = "im.journal_barrier_failed";
    pub const IM_INTENT_CONFLICT: &str = "im.intent_conflict";
}

/// Every code the contract promises, in document order.
pub const ERROR_CODES: [&str; 13] = [
    codes::MEDIA_INVALID_ATTACHMENT,
    codes::MEDIA_EMPTY,
    codes::MEDIA_TOO_LARGE,
    codes::MEDIA_VIDEO_TOO_LONG,
    codes::MEDIA_VIDEO_DURATION_UNKNOWN,
    codes::MEDIA_TOO_MANY_FILES,
    codes::MEDIA_CHUNKED_UNSUPPORTED,
    codes::MEDIA_UNKNOWN_KIND,
    codes::MEDIA_UPLOAD_REJECTED,
    codes::IM_JOURNAL_BARRIER_FAILED,
    codes::IM_INTENT_CONFLICT,
    "im.journal_unavailable",
    "im.journal_corrupt",
];

/// How an upload is authorized. Image and video need a short-lived token from
/// `16037/uploadTokenCreate` plus `Authorization` and `Content-MD5` headers;
/// a plain file upload has none of these. They are two models, never one
/// shared token flow.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UploadAuth {
    Token {
        token_channel: &'static str,
        token_type: &'static str,
    },
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UploadRoute {
    pub auth: UploadAuth,
    /// Path on `nephele.ctrip.com`, without query.
    pub path: &'static str,
    /// `channel` query parameter.
    pub channel: &'static str,
    pub authorization_header: bool,
    pub content_md5_header: bool,
}

pub const NEPHELE_HOST: &str = "nephele.ctrip.com";
pub const TOKEN_ENDPOINT: &str = "16037/uploadTokenCreate";

pub fn upload_route(kind: MediaKind) -> UploadRoute {
    match kind {
        MediaKind::Image => UploadRoute {
            auth: UploadAuth::Token {
                token_channel: "im_business",
                token_type: "img",
            },
            path: "/image/v2/api/upload",
            channel: "im_business",
            authorization_header: true,
            content_md5_header: true,
        },
        MediaKind::File => UploadRoute {
            auth: UploadAuth::None,
            path: "/file/v1/api/upload",
            channel: "im",
            authorization_header: false,
            content_md5_header: false,
        },
        MediaKind::Video => UploadRoute {
            auth: UploadAuth::Token {
                token_channel: "im",
                token_type: "video",
            },
            path: "/video/v3/api/upload",
            channel: "im",
            authorization_header: true,
            content_md5_header: true,
        },
    }
}

/// What a caller may do next with the same `local_id`, given a recorded
/// outcome (`MediaSendResult.kind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Next {
    /// Nothing was submitted and no journal record exists: the same intent may
    /// be sent again, reusing the same `local_id`.
    RetrySameLocalId,
    /// Terminal. The recorded result is replayed; no upload, no send. A new
    /// send is a new intent with a new `local_id`, started by the user.
    ReplayRecorded,
    /// `unknown`: never replayed, never auto-resolved. Only read-only lookup
    /// and a human decision; a later send is a new intent.
    VerifyOnly,
}

pub fn next_action(kind: &str) -> Option<Next> {
    match kind {
        "not_submitted" => Some(Next::RetrySameLocalId),
        "confirmed" | "rejected" => Some(Next::ReplayRecorded),
        "unknown" => Some(Next::VerifyOnly),
        _ => None,
    }
}

/// Only `not_submitted` may reach the upstream again.
pub fn may_reach_upstream_again(kind: &str) -> bool {
    next_action(kind) == Some(Next::RetrySameLocalId)
}

/// Re-exported so the host has one import for the whole contract surface.
pub use media_limits::LimitViolation;

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    const DOC: &str = include_str!("../../../../docs/api/media-attachment-contract.md");

    #[test]
    fn version_is_frozen_at_one_and_declared_in_the_document() {
        assert_eq!(ATTACHMENT_CONTRACT_VERSION, 1);
        assert!(DOC.contains("ATTACHMENT_CONTRACT_VERSION = 1"));
    }

    #[test]
    fn document_lists_every_field_code_and_value_of_the_contract() {
        let mut names: Vec<&str> = Vec::new();
        names.extend(ATTACHMENT_DTO_FIELDS);
        names.extend(ATTACHMENT_OWNER_FIELDS);
        names.extend(SEND_RESULT_FIELDS);
        names.extend(SEND_STAGES);
        names.extend(SEND_RESULT_KINDS);
        names.extend(ERROR_CODES);
        for n in names {
            assert!(DOC.contains(&format!("`{n}`")), "contract doc lacks `{n}`");
        }
    }

    #[test]
    fn document_states_the_limits_that_the_code_enforces() {
        use media_limits::*;
        for needle in [
            format!("`IMAGE_MAX_BYTES` = {IMAGE_MAX_BYTES}"),
            format!("`FILE_MAX_BYTES` = {FILE_MAX_BYTES}"),
            format!("`VIDEO_MAX_BYTES` = {VIDEO_MAX_BYTES}"),
            format!("`VIDEO_MAX_DURATION_MS` = {VIDEO_MAX_DURATION_MS}"),
            format!("`MAX_FILES_PER_SEND` = {MAX_FILES_PER_SEND}"),
            format!("`VIDEO_CHUNK_BYTES` = {VIDEO_CHUNK_BYTES}"),
            format!("`DIRECT_UPLOAD_MAX_BYTES` = {DIRECT_UPLOAD_MAX_BYTES}"),
        ] {
            assert!(DOC.contains(&needle), "contract doc lacks {needle}");
        }
    }

    #[test]
    fn image_and_file_uploads_are_two_authorization_models() {
        let image = upload_route(MediaKind::Image);
        assert_eq!(
            image.auth,
            UploadAuth::Token {
                token_channel: "im_business",
                token_type: "img"
            }
        );
        assert!(image.authorization_header && image.content_md5_header);
        assert_eq!(image.path, "/image/v2/api/upload");

        let file = upload_route(MediaKind::File);
        assert_eq!(file.auth, UploadAuth::None);
        assert!(!file.authorization_header && !file.content_md5_header);
        assert_eq!(file.path, "/file/v1/api/upload");

        assert_ne!(image.auth, file.auth);
        for route in [image, file, upload_route(MediaKind::Video)] {
            assert!(DOC.contains(route.path), "doc lacks route {}", route.path);
        }
        assert!(DOC.contains(NEPHELE_HOST) && DOC.contains(TOKEN_ENDPOINT));
    }

    #[test]
    fn unknown_is_never_replayed_and_only_not_submitted_may_retry() {
        assert_eq!(next_action("unknown"), Some(Next::VerifyOnly));
        assert!(!may_reach_upstream_again("unknown"));
        assert!(!may_reach_upstream_again("confirmed"));
        assert!(!may_reach_upstream_again("rejected"));
        assert!(may_reach_upstream_again("not_submitted"));
        assert_eq!(next_action("anything-else"), None);
        for kind in SEND_RESULT_KINDS {
            assert!(next_action(kind).is_some());
        }
    }

    #[test]
    fn barrier_failure_has_its_own_code_distinct_from_unknown_and_io() {
        assert_eq!(
            codes::IM_JOURNAL_BARRIER_FAILED,
            "im.journal_barrier_failed"
        );
        assert_ne!(codes::IM_JOURNAL_BARRIER_FAILED, "im.journal_io");
        assert!(!SEND_RESULT_KINDS.contains(&codes::IM_JOURNAL_BARRIER_FAILED));
        let mut seen = std::collections::BTreeSet::new();
        assert!(
            ERROR_CODES.iter().all(|c| seen.insert(*c)),
            "duplicate code"
        );
    }
}

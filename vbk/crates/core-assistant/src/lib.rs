//! Merchant assistant: TSim identity, outbound translation and package lookup clients (std-only).
//!
//! This crate is **pure**: it builds [`request::TsimRequest`] values
//! (method, URL, headers, body) and parses/classifies responses; the host
//! performs the HTTP calls with `follow_redirects = false` and a 2 MiB body
//! limit. Nothing here stores a password, logs a token or touches Ctrip
//! cookies — TSim identity is separate from the Ctrip account.
//!
//! * [`session`] — login (multipart, no bearer), profile, refresh, logout;
//!   `success/data` envelope; `TsimSession` with the 5-minutes-before-`exp`
//!   refresh rule and the 30-minute fallback; HTTP status mapping
//!   (401/423 clear the session, 403 is not a logout, 429/5xx are not a
//!   customer-send failure).
//! * [`translate`] — `/agent/translate` with exactly the six documented
//!   fields, echo verification, result binding (F12), the
//!   `ReplaceDraft`/`SendDirect` state machine and a per-account cache with
//!   single-flight.
//! * [`package`] — `perform → dataplan-list → detail (+ live-detail,
//!   cdr-more)` with the raw `code/result` envelope, id validation and
//!   percent-encoding, the 60 s reuse cache, ICCID/EID recognition and the
//!   separate server/client permission rules.
//! * [`language`] — script-based customer language suggestion.
//! * [`request`], [`codec`] — request model, redacting `Debug`, percent
//!   encoding, Base64url and ISO-8601 helpers.
//!
//! Sources: docs/api/external-tsim.md, docs/dev/09-assistant.md, plan
//! AST-02..AST-06.

pub mod codec;
pub mod language;
pub mod package;
pub mod request;
pub mod session;
pub mod translate;

pub use codec::{base64url_decode, encode_query, parse_iso8601_ms, percent_encode};
pub use language::{suggest_language, Confidence, Lang, LanguageSuggestion};
pub use package::{
    cdr_more_request, client_gate_allows, dataplan_list_request, detail_request, id_from_json,
    live_detail_request, parse_dataplan_list, parse_detail, parse_perform, parse_supplement,
    perform_request, recognize_identifiers, server_rule_allows, validate_order_nums,
    validate_query_id, IdentifierCandidate, IdentifierKind, PackageCache, PackagePermission,
};
pub use request::{
    validate_boundary, Body, Method, MultipartPart, SecretString, TsimRequest, API_ORIGIN,
    MAX_RESPONSE_BYTES,
};
pub use session::{
    codes, jwt_exp_ms, login, logout, map_http_status, parse_envelope, parse_login_response,
    parse_logout_response, parse_profile_response, parse_refresh_response, profile, refresh,
    LoginForm, Profile, StatusError, TokenData, TsimSession,
};
pub use translate::{
    accept_result, on_send_pressed, parse_translate_response, translate_request, CacheClaim,
    Draft, OutboundMode, SendPlan, TranslateParams, TranslationBinding, TranslationCache,
    TranslationState, TARGET_LANGS,
};

//! Endpoint policy registry, SOA response classification and ClockService (std-only).
//!
//! This crate is **pure**: it opens no sockets and ships no HTTP client. The
//! host / WebView performs requests; core-net
//!
//! * registers the 72 observed `method + host + path` combinations with their
//!   auth template, side effect, retry policy, response envelope and scope
//!   ([`endpoint`]);
//! * classifies responses so that HTTP 200 alone is never success and the
//!   not-logged-in diagnosis maps to `account.ticket_expired` ([`soa`]);
//! * validates the official IM / login / order-detail URLs with exact origin
//!   matching ([`url`]);
//! * builds request-context values (trace id, SOA query, Nephele
//!   authorization, MD5) from injected inputs ([`context`], [`md5`]);
//! * owns time for IM / notify through a deterministic [`clock::ClockService`]
//!   and the reconcile generation counter;
//! * models connectivity and the F14 rule that offline never implies an
//!   expired ticket ([`status`]).
//!
//! Sources: docs/dev/06-net.md, docs/api/{README,authentication,transports}.md,
//! docs/plan/00-master-development-plan.md NET-01/NET-04/NET-05, docs/dev/04,
//! docs/research/2026-10-30-web-order-conversation.md §3.

pub mod clock;
pub mod context;
pub mod endpoint;
pub mod md5;
pub mod soa;
pub mod status;
pub mod url;

pub use clock::{parse_soa_timestamp, ClockService, ReconcileCoordinator, ReconcileReason};
pub use context::{
    base64_encode, format_local_yyyymmddhhmm, nephele_authorization, nephele_random_string,
    soa_query, trace_id, NEPHELE_RANDOM_ALPHABET,
};
pub use endpoint::{
    AuthKind, EndpointPolicy, EndpointRegistry, EndpointScope, Method, ResponseKind, RetryPolicy,
    SideEffect,
};
pub use md5::md5_hex;
pub use soa::{
    classify_biz_status, classify_nephele, classify_response_error_code, classify_soa,
    classify_write_timeout, net_codes, NepheleOutcome, SoaOutcome, AUTH_FILTER_EXCEPTION,
};
pub use status::{report_outcome, NetEvent, NetStatus, NetStatusMachine};
pub use url::{
    order_detail_url, parse_https_url, validate_navigation_origin, validate_official_im_url,
    validate_order_id, HttpsUrl, ImLaunchUrl, UrlPolicy, LOGIN_PAGE_URL, ORDER_DETAIL_BASE_URL,
    VBOOKING_ORIGIN,
};

/// Classified result for any registered endpoint, dispatched by its
/// [`ResponseKind`].
#[derive(Debug, Clone, PartialEq)]
pub enum Classified {
    Soa(SoaOutcome),
    Nephele(NepheleOutcome),
    /// HTML / raw body: only the HTTP status is checked here; the adapter
    /// validates the document itself. `ok` is true for 2xx.
    Document { status: u16, ok: bool },
}

impl Classified {
    pub fn is_success(&self) -> bool {
        match self {
            Classified::Soa(o) => o.is_success(),
            Classified::Nephele(o) => o.is_success(),
            Classified::Document { ok, .. } => *ok,
        }
    }

    pub fn to_app_error(&self) -> Option<contracts::AppError> {
        match self {
            Classified::Soa(o) => o.to_app_error(),
            Classified::Nephele(o) => o.to_app_error(),
            Classified::Document { status, ok } => (!ok).then(|| {
                contracts::AppError::new(net_codes::NET_HTTP_ERROR, format!("http status {status}"))
            }),
        }
    }
}

/// Runs the classifier that the endpoint's `response_kind` prescribes.
pub fn classify_for(policy: &EndpointPolicy, http_status: u16, body: &str) -> Classified {
    match policy.response_kind {
        ResponseKind::SoaAck => Classified::Soa(classify_soa(http_status, body)),
        ResponseKind::SoaBizStatus => Classified::Soa(classify_biz_status(http_status, body)),
        ResponseKind::SoaResponseErrorCode => {
            Classified::Soa(classify_response_error_code(http_status, body))
        }
        ResponseKind::NepheleCode => Classified::Nephele(classify_nephele(http_status, body)),
        ResponseKind::Html | ResponseKind::Raw => Classified::Document {
            status: http_status,
            ok: (200..300).contains(&http_status),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispatch_by_response_kind() {
        let r = EndpointRegistry::official();
        let star = r.by_id("m:16037/setWorkSheetStar").expect("star");
        let body = r#"{"ResponseStatus":{"Ack":"Success"},"bizResponseStatus":{"resultCode":"FAIL"}}"#;
        assert!(!classify_for(star, 200, body).is_success());
        let list = r.by_id("m:16037/getConversationList").expect("list");
        assert!(classify_for(list, 200, r#"{"ResponseStatus":{"Ack":"Success"}}"#).is_success());
        let img = r.by_id("nephele:image/v2/api/upload").expect("img");
        assert!(!classify_for(img, 200, r#"{"Code":500}"#).is_success());
        let html = r.by_id("vbooking:tour/im/ex-area/b").expect("html");
        assert!(classify_for(html, 200, "<html></html>").is_success());
        assert!(!classify_for(html, 302, "").is_success());
        assert!(classify_for(html, 302, "").to_app_error().is_some());
    }
}

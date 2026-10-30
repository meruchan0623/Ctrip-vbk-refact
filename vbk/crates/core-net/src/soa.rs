//! Response classification (plan NET-01; authentication.md "SOA：Cookie、
//! 请求头和业务结果").
//!
//! HTTP 200 is never success on its own. Every classifier checks the HTTP
//! status, then the envelope (`ResponseStatus.Ack`, `bizResponseStatus`,
//! Nephele `Code`), then the fields the endpoint needs. The not-logged-in
//! diagnosis `AccountsMobileRequestFilterException` is mapped to
//! `account.ticket_expired` and reported to core-account, which decides
//! whether the credential is really gone (archive §4.5: not every error is
//! an expired ticket).

use contracts::json::JsonValue;
use contracts::{codes, AppError};

use crate::endpoint::SideEffect;

/// Error diagnostic that marks a request as not logged in.
pub const AUTH_FILTER_EXCEPTION: &str = "AccountsMobileRequestFilterException";

/// Crate-level error codes (`net.*`), in addition to `contracts::codes`.
pub mod net_codes {
    pub const NET_HTTP_ERROR: &str = "net.http_error";
    pub const NET_MALFORMED_RESPONSE: &str = "net.malformed_response";
    pub const NET_BUSINESS_FAILURE: &str = "net.business_failure";
    pub const NET_ENDPOINT_UNREGISTERED: &str = "net.endpoint_unregistered";
    pub const NET_ENDPOINT_NOT_IN_SCOPE: &str = "net.endpoint_not_in_scope";
    pub const NET_URL_REJECTED: &str = "net.url_rejected";
}

/// Outcome of a SOA (`ResponseStatus`) response.
#[derive(Debug, Clone, PartialEq)]
pub enum SoaOutcome {
    /// HTTP 2xx, `Ack == "Success"` and (where applicable) the business
    /// status is successful. `body` is the parsed document for the endpoint
    /// adapter to read its fields from.
    Success { body: JsonValue },
    /// The server answered but reported a business failure.
    BusinessFailure { ack: String, errors: Vec<String> },
    /// Not logged in (`AccountsMobileRequestFilterException`); maps to
    /// `account.ticket_expired`.
    AuthInvalid,
    /// Non-2xx HTTP status.
    HttpError(u16),
    /// Body is not JSON or lacks the envelope.
    Malformed,
}

impl SoaOutcome {
    pub fn is_success(&self) -> bool {
        matches!(self, SoaOutcome::Success { .. })
    }

    pub fn kind_name(&self) -> &'static str {
        match self {
            SoaOutcome::Success { .. } => "success",
            SoaOutcome::BusinessFailure { .. } => "business_failure",
            SoaOutcome::AuthInvalid => "auth_invalid",
            SoaOutcome::HttpError(_) => "http_error",
            SoaOutcome::Malformed => "malformed",
        }
    }

    /// `None` for success; otherwise the `AppError` to report. Messages
    /// carry error codes only, never body text.
    pub fn to_app_error(&self) -> Option<AppError> {
        match self {
            SoaOutcome::Success { .. } => None,
            SoaOutcome::BusinessFailure { ack, errors } => Some(
                AppError::new(net_codes::NET_BUSINESS_FAILURE, format!("ack={ack}"))
                    .with_detail(errors.join(",")),
            ),
            SoaOutcome::AuthInvalid => Some(AppError::new(
                codes::ACCOUNT_TICKET_EXPIRED,
                "server reported not logged in",
            )),
            SoaOutcome::HttpError(status) => Some(
                AppError::new(net_codes::NET_HTTP_ERROR, format!("http status {status}"))
                    .with_detail(status.to_string()),
            ),
            SoaOutcome::Malformed => Some(AppError::new(
                net_codes::NET_MALFORMED_RESPONSE,
                "response body is not a SOA envelope",
            )),
        }
    }
}

fn is_2xx(status: u16) -> bool {
    (200..300).contains(&status)
}

/// Collects `ErrorCode` / `Message` strings of `ResponseStatus.Errors`
/// (including nested `ErrorFields`) and the `Value`s of
/// `ResponseStatus.Extension`.
fn collect_diagnostics(rs: &JsonValue) -> (Vec<String>, bool) {
    let mut errors = Vec::new();
    let mut auth = false;
    let mut push = |s: &str, errors: &mut Vec<String>| {
        if s.contains(AUTH_FILTER_EXCEPTION) {
            auth = true;
        }
        if !s.is_empty() {
            errors.push(s.to_string());
        }
    };
    if let Some(list) = rs.get("Errors").and_then(JsonValue::as_array) {
        for e in list {
            for key in ["ErrorCode", "Message", "ErrorClassification"] {
                if let Some(s) = e.get(key).and_then(JsonValue::as_str) {
                    push(s, &mut errors);
                }
            }
            if let Some(fields) = e.get("ErrorFields").and_then(JsonValue::as_array) {
                for f in fields {
                    for key in ["ErrorCode", "Message"] {
                        if let Some(s) = f.get(key).and_then(JsonValue::as_str) {
                            push(s, &mut errors);
                        }
                    }
                }
            }
        }
    }
    if let Some(ext) = rs.get("Extension").and_then(JsonValue::as_array) {
        for e in ext {
            if let Some(v) = e.get("Value").and_then(JsonValue::as_str) {
                if v.contains(AUTH_FILTER_EXCEPTION) {
                    auth = true;
                    errors.push(AUTH_FILTER_EXCEPTION.to_string());
                }
            }
        }
    }
    errors.dedup();
    (errors, auth)
}

/// Classifies a `ResponseStatus.Ack` envelope.
pub fn classify_soa(http_status: u16, body: &str) -> SoaOutcome {
    if !is_2xx(http_status) {
        return SoaOutcome::HttpError(http_status);
    }
    let Ok(doc) = JsonValue::parse(body) else {
        return SoaOutcome::Malformed;
    };
    let Some(rs) = doc.get("ResponseStatus") else {
        return SoaOutcome::Malformed;
    };
    if rs.as_object().is_none() {
        return SoaOutcome::Malformed;
    }
    let (errors, auth) = collect_diagnostics(rs);
    if auth {
        return SoaOutcome::AuthInvalid;
    }
    match rs.get("Ack").and_then(JsonValue::as_str) {
        Some("Success") => SoaOutcome::Success { body: doc },
        Some(other) => SoaOutcome::BusinessFailure {
            ack: other.to_string(),
            errors,
        },
        None => SoaOutcome::Malformed,
    }
}

/// `Ack == Success` **and** `bizResponseStatus.resultCode == "SUCCESS"`
/// (16037 write/read endpoints such as `setWorkSheetStar`).
pub fn classify_biz_status(http_status: u16, body: &str) -> SoaOutcome {
    let outcome = classify_soa(http_status, body);
    let SoaOutcome::Success { body } = outcome else {
        return outcome;
    };
    match body.path("bizResponseStatus.resultCode").and_then(JsonValue::as_str) {
        Some("SUCCESS") => SoaOutcome::Success { body },
        Some(code) => SoaOutcome::BusinessFailure {
            ack: "Success".to_string(),
            errors: vec![format!("bizResponseStatus.resultCode={code}")],
        },
        None => SoaOutcome::Malformed,
    }
}

/// `Ack == Success` **and** `response.errorCode == 0` (sec-m 14361 order
/// endpoints such as `searchorderlist` / `createimchat`).
pub fn classify_response_error_code(http_status: u16, body: &str) -> SoaOutcome {
    let outcome = classify_soa(http_status, body);
    let SoaOutcome::Success { body } = outcome else {
        return outcome;
    };
    match body.path("response.errorCode").and_then(JsonValue::as_i64) {
        Some(0) => SoaOutcome::Success { body },
        Some(code) => SoaOutcome::BusinessFailure {
            ack: "Success".to_string(),
            errors: vec![format!("response.errorCode={code}")],
        },
        None => SoaOutcome::Malformed,
    }
}

/// Outcome of a Nephele upload (`Code: 2000` + `Content.url/file_name`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NepheleOutcome {
    Success { url: String, file_name: String },
    Failure { code: i64, message: String },
    HttpError(u16),
    Malformed,
}

impl NepheleOutcome {
    pub fn is_success(&self) -> bool {
        matches!(self, NepheleOutcome::Success { .. })
    }

    pub fn to_app_error(&self) -> Option<AppError> {
        match self {
            NepheleOutcome::Success { .. } => None,
            NepheleOutcome::Failure { code, .. } => Some(
                AppError::new(net_codes::NET_BUSINESS_FAILURE, format!("nephele code {code}"))
                    .with_detail(code.to_string()),
            ),
            NepheleOutcome::HttpError(s) => Some(AppError::new(
                net_codes::NET_HTTP_ERROR,
                format!("http status {s}"),
            )),
            NepheleOutcome::Malformed => Some(AppError::new(
                net_codes::NET_MALFORMED_RESPONSE,
                "nephele response lacks Code/Content",
            )),
        }
    }
}

/// Nephele upload success code.
pub const NEPHELE_OK: i64 = 2000;

pub fn classify_nephele(http_status: u16, body: &str) -> NepheleOutcome {
    if !is_2xx(http_status) {
        return NepheleOutcome::HttpError(http_status);
    }
    let Ok(doc) = JsonValue::parse(body) else {
        return NepheleOutcome::Malformed;
    };
    let Some(code) = doc.get("Code").and_then(JsonValue::as_i64) else {
        return NepheleOutcome::Malformed;
    };
    if code != NEPHELE_OK {
        let message = doc
            .get("Message")
            .and_then(JsonValue::as_str)
            .unwrap_or("")
            .to_string();
        return NepheleOutcome::Failure { code, message };
    }
    let url = doc.path("Content.url").and_then(JsonValue::as_str);
    let file_name = doc.path("Content.file_name").and_then(JsonValue::as_str);
    match (url, file_name) {
        (Some(u), Some(f)) if !u.is_empty() && !f.is_empty() => NepheleOutcome::Success {
            url: u.to_string(),
            file_name: f.to_string(),
        },
        _ => NepheleOutcome::Malformed,
    }
}

/// Timeout / disconnect semantics: a write whose request left the client
/// may have been executed. The result is **unknown**, never a failure that
/// authorises a resend (`retryable = false`). Reads report `net.timeout`;
/// bounded re-reads are governed by the endpoint's `RetryPolicy`, not by
/// this hint.
pub fn classify_write_timeout(side_effect: SideEffect) -> AppError {
    match side_effect {
        SideEffect::Write | SideEffect::MayCreateConversation => AppError::new(
            codes::IM_SEND_UNKNOWN,
            "write timed out: outcome unknown, reconcile before any retry",
        ),
        SideEffect::ReadOnly => AppError::new(codes::NET_TIMEOUT, "read timed out"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OK: &str = r#"{"ResponseStatus":{"Timestamp":"/Date(1761800000000+0800)/","Ack":"Success","Extension":[{"Id":"CLOGGING_TRACE_ID","Value":"1"}]},"conversationList":[]}"#;

    /// Shape of evidence 43 (auth failure with preserved error code); values
    /// are synthetic.
    const AUTH_FAIL: &str = r#"{"ResponseStatus":{"Timestamp":"/Date(1761800000000+0800)/","Ack":"Failure","Errors":[{"Message":null,"ErrorCode":"AccountsMobileRequestFilterException","StackTrace":null,"SeverityCode":"Error","ErrorFields":[{"FieldName":null,"ErrorCode":"101","Message":"x"}],"ErrorClassification":"FrameworkError"}],"Build":null,"Version":null,"Extension":[{"Id":"CLOGGING_TRACE_ID","Version":null,"ContentType":null,"Value":"1"}]}}"#;

    #[test]
    fn http_200_alone_is_never_success() {
        assert_eq!(classify_soa(200, ""), SoaOutcome::Malformed);
        assert_eq!(classify_soa(200, "{}"), SoaOutcome::Malformed);
        assert_eq!(classify_soa(200, "<html></html>"), SoaOutcome::Malformed);
        assert_eq!(classify_soa(200, r#"{"ResponseStatus":"x"}"#), SoaOutcome::Malformed);
        assert_eq!(classify_soa(200, r#"{"ResponseStatus":{}}"#), SoaOutcome::Malformed);
    }

    #[test]
    fn success_and_http_error() {
        let out = classify_soa(200, OK);
        assert!(out.is_success());
        assert!(out.to_app_error().is_none());
        assert_eq!(classify_soa(500, OK), SoaOutcome::HttpError(500));
        assert_eq!(classify_soa(302, OK), SoaOutcome::HttpError(302));
        let e = classify_soa(503, OK).to_app_error().expect("err");
        assert!(e.is(net_codes::NET_HTTP_ERROR));
        assert!(!e.retryable);
    }

    #[test]
    fn ack_failure_with_auth_filter_exception_is_auth_invalid() {
        let out = classify_soa(200, AUTH_FAIL);
        assert_eq!(out, SoaOutcome::AuthInvalid);
        let e = out.to_app_error().expect("err");
        assert!(e.is(codes::ACCOUNT_TICKET_EXPIRED));
        // Also detected through Extension values.
        let ext = r#"{"ResponseStatus":{"Ack":"Failure","Extension":[{"Id":"x","Value":"AccountsMobileRequestFilterException: not logged in"}]}}"#;
        assert_eq!(classify_soa(200, ext), SoaOutcome::AuthInvalid);
    }

    #[test]
    fn other_failures_are_business_failures_not_ticket_expired() {
        let body = r#"{"ResponseStatus":{"Ack":"Failure","Errors":[{"ErrorCode":"SomeOtherError","Message":"bad"}]}}"#;
        match classify_soa(200, body) {
            SoaOutcome::BusinessFailure { ack, errors } => {
                assert_eq!(ack, "Failure");
                assert_eq!(errors, vec!["SomeOtherError".to_string(), "bad".to_string()]);
            }
            other => panic!("unexpected {other:?}"),
        }
        let e = classify_soa(200, body).to_app_error().expect("err");
        assert!(e.is(net_codes::NET_BUSINESS_FAILURE));
        assert!(!e.message.contains("bad"), "message must not carry body text");
    }

    #[test]
    fn biz_status_requires_success_code() {
        let ok = r#"{"ResponseStatus":{"Ack":"Success"},"bizResponseStatus":{"resultCode":"SUCCESS"}}"#;
        assert!(classify_biz_status(200, ok).is_success());
        let fail = r#"{"ResponseStatus":{"Ack":"Success"},"bizResponseStatus":{"resultCode":"NO_PERMISSION"}}"#;
        assert!(matches!(
            classify_biz_status(200, fail),
            SoaOutcome::BusinessFailure { .. }
        ));
        let missing = r#"{"ResponseStatus":{"Ack":"Success"}}"#;
        assert_eq!(classify_biz_status(200, missing), SoaOutcome::Malformed);
        assert_eq!(classify_biz_status(200, AUTH_FAIL), SoaOutcome::AuthInvalid);
    }

    #[test]
    fn response_error_code_requires_zero() {
        let ok = r#"{"ResponseStatus":{"Ack":"Success"},"response":{"errorCode":0,"errorMsg":""},"url":"https://imvendor.ctrip.com/main"}"#;
        assert!(classify_response_error_code(200, ok).is_success());
        let fail = r#"{"ResponseStatus":{"Ack":"Success"},"response":{"errorCode":1001,"errorMsg":"no permission"}}"#;
        assert!(matches!(
            classify_response_error_code(200, fail),
            SoaOutcome::BusinessFailure { .. }
        ));
        assert_eq!(
            classify_response_error_code(200, r#"{"ResponseStatus":{"Ack":"Success"}}"#),
            SoaOutcome::Malformed
        );
    }

    #[test]
    fn nephele_classification() {
        let ok = r#"{"Code":2000,"Message":"","Content":{"url":"https://dimg.example/a.png","file_name":"a.png"}}"#;
        assert_eq!(
            classify_nephele(200, ok),
            NepheleOutcome::Success {
                url: "https://dimg.example/a.png".into(),
                file_name: "a.png".into()
            }
        );
        let fail = r#"{"Code":4001,"Message":"auth failed"}"#;
        assert_eq!(
            classify_nephele(200, fail),
            NepheleOutcome::Failure {
                code: 4001,
                message: "auth failed".into()
            }
        );
        assert_eq!(classify_nephele(200, r#"{"Code":2000}"#), NepheleOutcome::Malformed);
        assert_eq!(classify_nephele(200, "not json"), NepheleOutcome::Malformed);
        assert_eq!(classify_nephele(403, ok), NepheleOutcome::HttpError(403));
        assert!(classify_nephele(200, fail).to_app_error().is_some());
    }

    #[test]
    fn write_timeout_is_unknown_and_not_retryable() {
        let e = classify_write_timeout(SideEffect::Write);
        assert!(e.is(codes::IM_SEND_UNKNOWN));
        assert!(!e.retryable);
        let e = classify_write_timeout(SideEffect::MayCreateConversation);
        assert!(e.is(codes::IM_SEND_UNKNOWN));
        assert!(!e.retryable);
        let e = classify_write_timeout(SideEffect::ReadOnly);
        assert!(e.is(codes::NET_TIMEOUT));
        assert!(!e.retryable);
    }
}

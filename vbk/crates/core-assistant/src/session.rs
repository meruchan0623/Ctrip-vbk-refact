//! TSim identity: login / profile / refresh / logout request builders,
//! `success/data` envelope parsing, `TsimSession` and the refresh rule
//! (external-tsim.md "登录、身份、刷新与登出", plan AST-03).

use contracts::json::JsonValue;
use contracts::AppError;

use crate::codec::{base64url_decode, parse_iso8601_ms};
use crate::request::{validate_boundary, MultipartPart, SecretString, TsimRequest};

/// Assistant error codes (`assistant.*`).
pub mod codes {
    /// 401 / 423: the local session has been cleared.
    pub const SESSION_CLEARED: &str = "assistant.session_cleared";
    /// 403: not permitted; the session stays.
    pub const FORBIDDEN: &str = "assistant.forbidden";
    /// 422 / 413 or client-side validation failure.
    pub const INVALID_INPUT: &str = "assistant.invalid_input";
    /// 429 / 5xx: TSim unavailable; never a customer-send failure.
    pub const SERVICE_UNAVAILABLE: &str = "assistant.service_unavailable";
    /// Any other non-2xx status.
    pub const HTTP_ERROR: &str = "assistant.http_error";
    /// Body is not the expected envelope.
    pub const MALFORMED_RESPONSE: &str = "assistant.malformed_response";
    /// `success:false` (or package `code` failure) reported by TSim.
    pub const UPSTREAM_FAILURE: &str = "assistant.upstream_failure";
    /// Echoed draft id / version differ from the request.
    pub const TRANSLATION_MISMATCH: &str = "assistant.translation_mismatch";
    /// Result belongs to another conversation / draft version / generation.
    pub const STALE_BINDING: &str = "assistant.stale_binding";
    /// No active TSim session. The value matches the code the UI already
    /// branches on (`ui/apps/main/main.ts` shows "需先登录 TSim").
    pub const NOT_LOGGED_IN: &str = "assistant.tsim_unauthenticated";
    /// Login rejected (401 on `/agent/login`): wrong user name or password.
    pub const BAD_CREDENTIALS: &str = "assistant.tsim_bad_credentials";
    /// The package chain returned no data plan for the identifier.
    pub const PACKAGE_NOT_FOUND: &str = "assistant.package_not_found";
    /// Local permission gate failed.
    pub const PERMISSION_DENIED: &str = "assistant.permission_denied";
}

/// HTTP status mapping result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusError {
    pub error: AppError,
    /// Whether the caller must drop the local session (401 / 423).
    pub clears_session: bool,
}

/// Maps a non-2xx status to its error; `None` for 2xx.
pub fn map_http_status(status: u16) -> Option<StatusError> {
    if (200..300).contains(&status) {
        return None;
    }
    let (code, msg, clears, retryable) = match status {
        401 | 423 => (
            codes::SESSION_CLEARED,
            "tsim session invalid or locked",
            true,
            false,
        ),
        403 => (
            codes::FORBIDDEN,
            "tsim forbidden (not a logout)",
            false,
            false,
        ),
        422 | 413 => (
            codes::INVALID_INPUT,
            "tsim rejected the input",
            false,
            false,
        ),
        429 | 500..=599 => (codes::SERVICE_UNAVAILABLE, "tsim unavailable", false, true),
        _ => (
            codes::HTTP_ERROR,
            "unexpected tsim http status",
            false,
            false,
        ),
    };
    let mut error = AppError::new(code, msg).with_detail(status.to_string());
    if retryable {
        error = error.retryable();
    }
    Some(StatusError {
        error,
        clears_session: clears,
    })
}

fn malformed(what: &str) -> AppError {
    AppError::new(codes::MALFORMED_RESPONSE, format!("tsim response: {what}"))
}

/// Parses the `APIResponse{success, message, data}` envelope and returns
/// `data` when `success == true`. Status errors take precedence.
pub fn parse_envelope(status: u16, body: &str) -> Result<JsonValue, AppError> {
    if let Some(e) = map_http_status(status) {
        return Err(e.error);
    }
    let doc = JsonValue::parse(body).map_err(|_| malformed("not json"))?;
    if doc.as_object().is_none() {
        return Err(malformed("not an object"));
    }
    match doc.get("success").and_then(JsonValue::as_bool) {
        Some(true) => Ok(doc.get("data").cloned().unwrap_or(JsonValue::Null)),
        Some(false) => {
            let message = doc
                .get("message")
                .and_then(JsonValue::as_str)
                .unwrap_or("")
                .to_string();
            Err(
                AppError::new(codes::UPSTREAM_FAILURE, "tsim reported failure")
                    .with_detail(truncate(&message, 200)),
            )
        }
        None => Err(malformed("missing success flag")),
    }
}

fn truncate(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// Login form. `Debug` never prints the password.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoginForm {
    pub username: String,
    pub password: SecretString,
}

/// `POST /agent/login` — multipart, no bearer.
pub fn login(form: &LoginForm, boundary: &str) -> Result<TsimRequest, AppError> {
    if form.username.trim().is_empty() || form.password.is_empty() {
        return Err(AppError::new(
            codes::INVALID_INPUT,
            "username and password are required",
        ));
    }
    let parts = vec![
        MultipartPart::text("username", form.username.clone()),
        MultipartPart::secret("password", &form.password),
    ];
    validate_boundary(boundary, &parts)
        .map_err(|m| AppError::new(codes::INVALID_INPUT, format!("multipart boundary: {m}")))?;
    Ok(TsimRequest::post_multipart(
        "/agent/login",
        boundary.to_string(),
        parts,
    ))
}

/// `GET /agent/profile`.
pub fn profile(access_token: &str) -> TsimRequest {
    TsimRequest::get("/agent/profile", access_token)
}

/// `POST /agent/auth/refresh` — bearer, empty body.
pub fn refresh(access_token: &str) -> TsimRequest {
    TsimRequest::post_empty("/agent/auth/refresh", access_token)
}

/// `POST /agent/logout` — bearer, empty body.
pub fn logout(access_token: &str) -> TsimRequest {
    TsimRequest::post_empty("/agent/logout", access_token)
}

/// Token data returned by login and refresh.
#[derive(Clone, PartialEq, Eq)]
pub struct TokenData {
    pub access_token: SecretString,
    pub token_type: String,
    pub session_ref: String,
    /// From `expires_at` (ISO) when present.
    pub expires_at_ms: Option<i64>,
}

impl std::fmt::Debug for TokenData {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TokenData")
            .field("access_token", &self.access_token)
            .field("token_type", &self.token_type)
            .field("session_ref", &self.session_ref)
            .field("expires_at_ms", &self.expires_at_ms)
            .finish()
    }
}

fn parse_token_data(data: &JsonValue, require_expires: bool) -> Result<TokenData, AppError> {
    let access_token = data
        .get("access_token")
        .and_then(JsonValue::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| malformed("missing access_token"))?;
    let token_type = data
        .get("token_type")
        .and_then(JsonValue::as_str)
        .unwrap_or("bearer")
        .to_string();
    if !token_type.eq_ignore_ascii_case("bearer") {
        return Err(malformed("unexpected token_type"));
    }
    let session_ref = data
        .get("session_ref")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| malformed("missing session_ref"))?
        .to_string();
    let expires_at_ms = match data.get("expires_at") {
        Some(JsonValue::String(s)) => {
            Some(parse_iso8601_ms(s).ok_or_else(|| malformed("expires_at not iso-8601"))?)
        }
        Some(JsonValue::Null) | None if !require_expires => None,
        _ => return Err(malformed("expires_at")),
    };
    Ok(TokenData {
        access_token: SecretString::new(access_token),
        token_type,
        session_ref,
        expires_at_ms,
    })
}

/// `success:true, data:{access_token, token_type:"bearer", session_ref}`.
/// A 401 on the login route means rejected credentials (there is no session
/// to clear yet), so it maps to [`codes::BAD_CREDENTIALS`].
pub fn parse_login_response(status: u16, body: &str) -> Result<TokenData, AppError> {
    if status == 401 {
        return Err(
            AppError::new(codes::BAD_CREDENTIALS, "tsim rejected the credentials")
                .with_detail("401"),
        );
    }
    let data = parse_envelope(status, body)?;
    parse_token_data(&data, false)
}

/// `success:true, data:{access_token, token_type, expires_at, session_ref}`.
pub fn parse_refresh_response(status: u16, body: &str) -> Result<TokenData, AppError> {
    let data = parse_envelope(status, body)?;
    parse_token_data(&data, true)
}

/// Fields of `/agent/profile` the client reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Profile {
    pub id: String,
    pub is_active: bool,
    pub permissions: Vec<String>,
    /// Opaque `outbound_wait` (seconds); `None` when absent or not numeric.
    pub outbound_wait: Option<i64>,
}

pub fn parse_profile_response(status: u16, body: &str) -> Result<Profile, AppError> {
    let data = parse_envelope(status, body)?;
    let id = match data.get("id") {
        Some(JsonValue::String(s)) => s.clone(),
        Some(n @ JsonValue::Number { .. }) => n
            .as_i64()
            .map(|i| i.to_string())
            .ok_or_else(|| malformed("id"))?,
        _ => return Err(malformed("missing id")),
    };
    let is_active = data
        .get("is_active")
        .and_then(JsonValue::as_bool)
        .unwrap_or(false);
    let permissions = data
        .get("permissions")
        .and_then(JsonValue::as_array)
        .map(|a| {
            a.iter()
                .filter_map(JsonValue::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let outbound_wait = data.get("outbound_wait").and_then(JsonValue::as_i64);
    Ok(Profile {
        id,
        is_active,
        permissions,
        outbound_wait,
    })
}

/// `success:true, message, data:null`.
pub fn parse_logout_response(status: u16, body: &str) -> Result<(), AppError> {
    parse_envelope(status, body).map(|_| ())
}

/// Refresh lead time before JWT `exp`.
pub const REFRESH_LEAD_MS: i64 = 5 * 60 * 1000;
/// Client-side refresh cycle when the JWT expiry is unreadable.
pub const FALLBACK_REFRESH_CYCLE_MS: i64 = 30 * 60 * 1000;

/// Decodes the JWT payload (base64url, no signature check — the token is
/// opaque to us) and returns `exp` in milliseconds.
pub fn jwt_exp_ms(token: &str) -> Option<i64> {
    let mut parts = token.split('.');
    let _header = parts.next()?;
    let payload = parts.next()?;
    let bytes = base64url_decode(payload)?;
    let text = std::str::from_utf8(&bytes).ok()?;
    let doc = JsonValue::parse(text).ok()?;
    let exp = doc.get("exp")?.as_i64()?;
    exp.checked_mul(1000)
}

/// Active TSim session. `Debug` redacts the token.
#[derive(Clone, PartialEq, Eq)]
pub struct TsimSession {
    pub access_token: SecretString,
    /// JWT `exp` when decodable, else the server `expires_at`, else `None`.
    pub expires_at_ms: Option<i64>,
    pub session_ref: String,
    pub permissions: Vec<String>,
    pub outbound_wait: Option<i64>,
    pub is_active: bool,
    /// When the current token was obtained (login or refresh).
    pub issued_at_ms: i64,
    /// Bumps on login, refresh, logout and permission change; stale results
    /// compare against it.
    pub generation: u64,
}

impl std::fmt::Debug for TsimSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TsimSession")
            .field("access_token", &self.access_token)
            .field("expires_at_ms", &self.expires_at_ms)
            .field("session_ref", &self.session_ref)
            .field("permissions", &self.permissions)
            .field("outbound_wait", &self.outbound_wait)
            .field("is_active", &self.is_active)
            .field("issued_at_ms", &self.issued_at_ms)
            .field("generation", &self.generation)
            .finish()
    }
}

impl TsimSession {
    /// Builds a session from login/refresh token data; permissions are
    /// filled by [`TsimSession::apply_profile`].
    pub fn from_token(token: TokenData, now_ms: i64, generation: u64) -> Self {
        let expires_at_ms = jwt_exp_ms(token.access_token.expose()).or(token.expires_at_ms);
        Self {
            access_token: token.access_token,
            expires_at_ms,
            session_ref: token.session_ref,
            permissions: Vec::new(),
            outbound_wait: None,
            is_active: true,
            issued_at_ms: now_ms,
            generation,
        }
    }

    pub fn apply_profile(&mut self, p: &Profile) {
        if self.permissions != p.permissions || self.is_active != p.is_active {
            self.generation += 1;
        }
        self.permissions = p.permissions.clone();
        self.is_active = p.is_active;
        self.outbound_wait = p.outbound_wait;
    }

    /// Replaces the token after a successful refresh.
    pub fn apply_refresh(&mut self, token: TokenData, now_ms: i64) {
        let expires_at_ms = jwt_exp_ms(token.access_token.expose()).or(token.expires_at_ms);
        self.access_token = token.access_token;
        self.session_ref = token.session_ref;
        self.expires_at_ms = expires_at_ms;
        self.issued_at_ms = now_ms;
        self.generation += 1;
    }

    pub fn has_permission(&self, perm: &str) -> bool {
        self.permissions.iter().any(|p| p == perm)
    }

    /// Instant at which a refresh should run: `exp − 5 min`, or
    /// `issued_at + 30 min` when the expiry is unknown.
    pub fn refresh_deadline_ms(&self) -> i64 {
        // `exp` comes from an untrusted JWT payload: saturate at the limits.
        match self.expires_at_ms {
            Some(exp) => exp.saturating_sub(REFRESH_LEAD_MS),
            None => self.issued_at_ms.saturating_add(FALLBACK_REFRESH_CYCLE_MS),
        }
    }

    pub fn refresh_due(&self, now_ms: i64) -> bool {
        now_ms >= self.refresh_deadline_ms()
    }

    /// Token already past its expiry (no grace).
    pub fn is_expired(&self, now_ms: i64) -> bool {
        matches!(self.expires_at_ms, Some(exp) if now_ms >= exp)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::request::Body;

    fn jwt_with_exp(exp_s: i64) -> String {
        // header "{}" and payload {"exp":N}; signature irrelevant.
        fn b64url(s: &str) -> String {
            const A: &[u8; 64] =
                b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
            let b = s.as_bytes();
            let mut out = String::new();
            for chunk in b.chunks(3) {
                let n = (chunk[0] as u32) << 16
                    | (chunk.get(1).copied().unwrap_or(0) as u32) << 8
                    | chunk.get(2).copied().unwrap_or(0) as u32;
                out.push(A[((n >> 18) & 63) as usize] as char);
                out.push(A[((n >> 12) & 63) as usize] as char);
                if chunk.len() > 1 {
                    out.push(A[((n >> 6) & 63) as usize] as char);
                }
                if chunk.len() > 2 {
                    out.push(A[(n & 63) as usize] as char);
                }
            }
            out
        }
        format!(
            "{}.{}.sig",
            b64url("{\"alg\":\"HS256\"}"),
            b64url(&format!("{{\"exp\":{exp_s},\"sub\":\"a\"}}"))
        )
    }

    #[test]
    fn login_request_shape() {
        let form = LoginForm {
            username: "alice".into(),
            password: SecretString::new("secret-pw"),
        };
        let r = login(&form, "BoundaryXYZ").expect("request");
        assert_eq!(r.url, "https://csapi.tsim.tech/agent/login");
        assert!(
            r.header("Authorization").is_none(),
            "login carries no bearer"
        );
        assert_eq!(
            r.header("Content-Type"),
            Some("multipart/form-data; boundary=BoundaryXYZ")
        );
        let expected = "--BoundaryXYZ\r\nContent-Disposition: form-data; name=\"username\"\r\n\r\nalice\r\n--BoundaryXYZ\r\nContent-Disposition: form-data; name=\"password\"\r\n\r\nsecret-pw\r\n--BoundaryXYZ--\r\n";
        assert_eq!(r.body.encode(), expected.as_bytes());
        assert!(matches!(r.body, Body::Multipart { .. }));
        assert!(!format!("{r:?}").contains("secret-pw"));
        assert!(!format!("{form:?}").contains("secret-pw"));
        assert!(login(
            &LoginForm {
                username: "".into(),
                password: SecretString::new("x")
            },
            "b"
        )
        .is_err());
        assert!(login(&form, "bad boundary").is_err());
    }

    #[test]
    fn other_identity_requests() {
        let p = profile("tok");
        assert_eq!(p.method, crate::request::Method::Get);
        assert_eq!(p.url, "https://csapi.tsim.tech/agent/profile");
        assert_eq!(p.body, Body::Empty);
        let r = refresh("tok");
        assert_eq!(r.method, crate::request::Method::Post);
        assert_eq!(r.url, "https://csapi.tsim.tech/agent/auth/refresh");
        assert_eq!(r.body, Body::Empty);
        assert_eq!(r.header("Authorization"), Some("Bearer tok"));
        assert_eq!(logout("tok").url, "https://csapi.tsim.tech/agent/logout");
    }

    #[test]
    fn status_mapping() {
        let e = map_http_status(401).expect("401");
        assert!(e.clears_session);
        assert!(e.error.is(codes::SESSION_CLEARED));
        let e = map_http_status(423).expect("423");
        assert!(e.clears_session);
        let e = map_http_status(403).expect("403");
        assert!(!e.clears_session);
        assert!(e.error.is(codes::FORBIDDEN));
        assert!(map_http_status(422)
            .expect("422")
            .error
            .is(codes::INVALID_INPUT));
        assert!(map_http_status(413)
            .expect("413")
            .error
            .is(codes::INVALID_INPUT));
        for s in [429, 500, 503] {
            let e = map_http_status(s).expect("unavailable");
            assert!(e.error.is(codes::SERVICE_UNAVAILABLE), "{s}");
            assert!(!e.clears_session);
            assert!(e.error.retryable);
        }
        assert!(map_http_status(404)
            .expect("404")
            .error
            .is(codes::HTTP_ERROR));
        assert!(map_http_status(200).is_none());
        assert!(map_http_status(204).is_none());
    }

    #[test]
    fn envelope_parsing() {
        let ok = r#"{"success":true,"message":"ok","data":{"access_token":"t1","token_type":"bearer","session_ref":"s1"}}"#;
        let t = parse_login_response(200, ok).expect("login");
        assert_eq!(t.access_token.expose(), "t1");
        assert_eq!(t.session_ref, "s1");
        assert_eq!(t.expires_at_ms, None);
        assert!(!format!("{t:?}").contains("t1"));
        let fail = r#"{"success":false,"message":"bad credentials","data":null}"#;
        let e = parse_login_response(200, fail).expect_err("fail");
        assert!(e.is(codes::UPSTREAM_FAILURE));
        assert!(parse_login_response(200, "{}").is_err());
        assert!(parse_login_response(200, "[]").is_err());
        assert!(parse_login_response(200, "nope").is_err());
        assert!(parse_login_response(401, ok)
            .expect_err("401")
            .is(codes::BAD_CREDENTIALS));
        assert!(parse_login_response(423, ok)
            .expect_err("423")
            .is(codes::SESSION_CLEARED));
        // Refresh requires expires_at.
        let refresh_ok = r#"{"success":true,"data":{"access_token":"t2","token_type":"bearer","expires_at":"2026-10-30T12:00:00Z","session_ref":"s2"}}"#;
        let t = parse_refresh_response(200, refresh_ok).expect("refresh");
        assert_eq!(t.expires_at_ms, Some(1_793_361_600_000));
        assert!(parse_refresh_response(200, ok).is_err());
        let bad_type =
            r#"{"success":true,"data":{"access_token":"t","token_type":"mac","session_ref":"s"}}"#;
        assert!(parse_login_response(200, bad_type).is_err());
        // Profile.
        let prof = r#"{"success":true,"data":{"id":7,"is_active":true,"permissions":["complaint_records","x"],"outbound_wait":3,"extra":1}}"#;
        let p = parse_profile_response(200, prof).expect("profile");
        assert_eq!(p.id, "7");
        assert!(p.is_active);
        assert_eq!(
            p.permissions,
            vec!["complaint_records".to_string(), "x".to_string()]
        );
        assert_eq!(p.outbound_wait, Some(3));
        assert!(
            parse_logout_response(200, r#"{"success":true,"message":"bye","data":null}"#).is_ok()
        );
    }

    #[test]
    fn jwt_exp_and_refresh_rule() {
        let exp_s = 1_793_361_600; // 2026-10-30T12:00:00Z
        let token = jwt_with_exp(exp_s);
        assert_eq!(jwt_exp_ms(&token), Some(exp_s * 1000));
        assert_eq!(jwt_exp_ms("not.a-jwt"), None);
        assert_eq!(jwt_exp_ms("a.b.c"), None);
        assert_eq!(jwt_exp_ms("x"), None);

        let data = TokenData {
            access_token: SecretString::new(token.clone()),
            token_type: "bearer".into(),
            session_ref: "s".into(),
            expires_at_ms: None,
        };
        let now = exp_s * 1000 - 60 * 60 * 1000; // one hour before exp
        let s = TsimSession::from_token(data, now, 1);
        assert_eq!(s.expires_at_ms, Some(exp_s * 1000));
        assert_eq!(s.refresh_deadline_ms(), exp_s * 1000 - REFRESH_LEAD_MS);
        assert!(!s.refresh_due(exp_s * 1000 - REFRESH_LEAD_MS - 1));
        assert!(s.refresh_due(exp_s * 1000 - REFRESH_LEAD_MS));
        assert!(!s.is_expired(exp_s * 1000 - 1));
        assert!(s.is_expired(exp_s * 1000));

        // Opaque token: 30-minute client cycle from issue time.
        let opaque = TokenData {
            access_token: SecretString::new("opaque-token"),
            token_type: "bearer".into(),
            session_ref: "s".into(),
            expires_at_ms: None,
        };
        let s = TsimSession::from_token(opaque, 1_000_000, 1);
        assert_eq!(s.expires_at_ms, None);
        assert_eq!(
            s.refresh_deadline_ms(),
            1_000_000 + FALLBACK_REFRESH_CYCLE_MS
        );
        assert!(!s.refresh_due(1_000_000 + FALLBACK_REFRESH_CYCLE_MS - 1));
        assert!(s.refresh_due(1_000_000 + FALLBACK_REFRESH_CYCLE_MS));
        assert!(!s.is_expired(i64::MAX));

        // Server expires_at used when the JWT is unreadable.
        let with_iso = TokenData {
            access_token: SecretString::new("opaque"),
            token_type: "bearer".into(),
            session_ref: "s".into(),
            expires_at_ms: Some(5_000_000),
        };
        let s = TsimSession::from_token(with_iso, 0, 1);
        assert_eq!(s.refresh_deadline_ms(), 5_000_000 - REFRESH_LEAD_MS);
    }

    #[test]
    fn profile_and_refresh_bump_generation() {
        let data = TokenData {
            access_token: SecretString::new("t"),
            token_type: "bearer".into(),
            session_ref: "s".into(),
            expires_at_ms: None,
        };
        let mut s = TsimSession::from_token(data, 0, 1);
        s.apply_profile(&Profile {
            id: "1".into(),
            is_active: true,
            permissions: vec!["complaint_records".into()],
            outbound_wait: None,
        });
        assert_eq!(s.generation, 2);
        assert!(s.has_permission("complaint_records"));
        s.apply_profile(&Profile {
            id: "1".into(),
            is_active: true,
            permissions: vec!["complaint_records".into()],
            outbound_wait: Some(1),
        });
        assert_eq!(s.generation, 2, "unchanged permissions keep the generation");
        s.apply_refresh(
            TokenData {
                access_token: SecretString::new("t2"),
                token_type: "bearer".into(),
                session_ref: "s2".into(),
                expires_at_ms: Some(99),
            },
            10,
        );
        assert_eq!(s.generation, 3);
        assert_eq!(s.issued_at_ms, 10);
        assert_eq!(s.expires_at_ms, Some(99));
        assert!(!format!("{s:?}").contains("t2"));
    }

    #[test]
    fn hostile_exp_values_saturate_the_refresh_deadline() {
        // QA regression: `exp - REFRESH_LEAD_MS` overflowed for a JWT whose
        // `exp` is near i64::MIN / 1000.
        for exp in [i64::MIN, i64::MIN + 1, -1, 0, i64::MAX] {
            let s = TsimSession::from_token(
                TokenData {
                    access_token: SecretString::new("opaque"),
                    token_type: "bearer".into(),
                    session_ref: "s".into(),
                    expires_at_ms: Some(exp),
                },
                i64::MAX,
                1,
            );
            let d = s.refresh_deadline_ms();
            assert!(d <= exp);
            assert!(s.refresh_due(i64::MAX));
        }
        let s = TsimSession::from_token(
            TokenData {
                access_token: SecretString::new("opaque"),
                token_type: "bearer".into(),
                session_ref: "s".into(),
                expires_at_ms: None,
            },
            i64::MAX,
            1,
        );
        assert_eq!(s.refresh_deadline_ms(), i64::MAX);
        let token = jwt_with_exp(-9_223_372_036_854_775);
        assert_eq!(jwt_exp_ms(&token), Some(-9_223_372_036_854_775_000));
        let s = TsimSession::from_token(
            TokenData {
                access_token: SecretString::new(token),
                token_type: "bearer".into(),
                session_ref: "s".into(),
                expires_at_ms: None,
            },
            0,
            1,
        );
        assert_eq!(s.refresh_deadline_ms(), i64::MIN);
    }
}

//! Import an existing bearer only after authoritative server checks. JWT decode
//! remains expiry scheduling only; it never authenticates an imported identity.
use crate::session::codes;
use crate::{parse_envelope, parse_profile_response, profile, Profile, TsimRequest};
use contracts::{json::JsonValue, AppError};

pub fn validate_access_token(token: &str) -> Result<(), AppError> {
    if token.is_empty() || token.len() > 16_384 || !token.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(AppError::new(
            codes::INVALID_INPUT,
            "invalid imported token format",
        ));
    }
    Ok(())
}
pub fn profile_request(token: &str) -> Result<TsimRequest, AppError> {
    validate_access_token(token)?;
    Ok(profile(token))
}
pub fn status_request(token: &str) -> Result<TsimRequest, AppError> {
    validate_access_token(token)?;
    Ok(TsimRequest::get("/agent/auth/session-status", token))
}
#[derive(Debug)]
pub struct VerifiedProfile {
    pub profile: Profile,
    pub username: String,
}
pub fn parse_profile(status: u16, body: &str) -> Result<VerifiedProfile, AppError> {
    let profile = parse_profile_response(status, body)?;
    let data = parse_envelope(status, body)?;
    if profile.id.trim().is_empty()
        || profile.id.len() > 128
        || profile.id.chars().any(char::is_control)
    {
        return Err(AppError::new(
            codes::MALFORMED_RESPONSE,
            "verified profile identity is invalid",
        ));
    }
    let username = data
        .get("username")
        .and_then(JsonValue::as_str)
        .filter(|s| {
            !s.trim().is_empty() && s.chars().count() <= 256 && !s.chars().any(char::is_control)
        })
        .ok_or_else(|| {
            AppError::new(
                codes::MALFORMED_RESPONSE,
                "verified profile is missing a username",
            )
        })?
        .to_owned();
    let permissions = data
        .get("permissions")
        .and_then(JsonValue::as_array)
        .ok_or_else(|| {
            AppError::new(
                codes::MALFORMED_RESPONSE,
                "verified profile has no permission list",
            )
        })?;
    if permissions.len() > 512
        || permissions.iter().any(|p| {
            p.as_str().map_or(true, |s| {
                s.is_empty()
                    || s.len() > 128
                    || !s
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.')
            })
        })
    {
        return Err(AppError::new(
            codes::MALFORMED_RESPONSE,
            "verified permission list is invalid",
        ));
    }
    if !profile.is_active {
        return Err(AppError::new(
            codes::FORBIDDEN,
            "imported account is inactive",
        ));
    }
    if !crate::client_gate_allows(&profile.permissions) {
        return Err(AppError::new(
            codes::PERMISSION_DENIED,
            "imported account has no package lookup permission",
        ));
    }
    Ok(VerifiedProfile { profile, username })
}
pub fn parse_session_ref(status: u16, body: &str) -> Result<String, AppError> {
    let data = parse_envelope(status, body)?;
    if data.get("state").and_then(JsonValue::as_str) != Some("active") {
        return Err(AppError::new(
            codes::NOT_LOGGED_IN,
            "imported session is not active",
        ));
    }
    data.get("session_ref")
        .and_then(JsonValue::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 2048 && s.bytes().all(|b| b.is_ascii_graphic()))
        .map(str::to_owned)
        .ok_or_else(|| {
            AppError::new(
                codes::MALFORMED_RESPONSE,
                "verified session reference is missing",
            )
        })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    #[test]
    fn import_accepts_only_server_active_state_and_never_infers_a_reference_from_jwt_claims() {
        assert_eq!(
            parse_session_ref(
                200,
                r#"{"success":true,"data":{"state":"active","session_ref":"server-reference"}}"#
            )
            .unwrap(),
            "server-reference"
        );
        for state in ["expired", "invalid", "revoked", "inactive", "ACTIVE", ""] {
            assert!(parse_session_ref(200, &format!(r#"{{"success":true,"data":{{"state":"{state}","session_ref":"server-reference"}}}}"#)).is_err(), "{state}");
        }
        for body in [
            r#"{"success":true,"data":{"state":"active","sid":"jwt-sid"}}"#,
            r#"{"success":true,"data":{"state":"active","session_ref":""}}"#,
            r#"{"success":false,"data":{"state":"active","session_ref":"r"}}"#,
        ] {
            assert!(parse_session_ref(200, body).is_err());
        }
    }
    #[test]
    fn import_requests_are_fixed_origin_read_only_and_secret_debug_is_redacted() {
        let token = "SYNTHETIC_IMPORT_TOKEN";
        let request = status_request(token).unwrap();
        assert_eq!(
            request.url,
            "https://csapi.tsim.tech/agent/auth/session-status"
        );
        assert_eq!(request.method, crate::Method::Get);
        assert_eq!(
            request.header("Authorization"),
            Some("Bearer SYNTHETIC_IMPORT_TOKEN")
        );
        assert!(!request.follow_redirects);
        assert!(!format!("{request:?}").contains(token));
        assert_eq!(
            profile_request(token).unwrap().url,
            "https://csapi.tsim.tech/agent/profile"
        );
        for invalid in [
            "",
            "Bearer token",
            "token\r\nHeader:value",
            "token\t",
            "令牌",
        ] {
            assert!(status_request(invalid).is_err());
        }
        assert!(status_request(&"x".repeat(16_385)).is_err());
    }
    #[test]
    fn imported_profile_requires_authoritative_username_active_identity_and_real_permission() {
        let body = r#"{"success":true,"data":{"id":7,"username":"server-user","is_active":true,"permissions":["complaint_records"]}}"#;
        assert_eq!(parse_profile(200, body).unwrap().username, "server-user");
        for bad in [
            body.replace("server-user", ""),
            body.replace(r#""is_active":true"#, r#""is_active":false"#),
            body.replace("complaint_records", "translate"),
            body.replace(r#"["complaint_records"]"#, "null"),
            body.replace(r#""id":7,"#, ""),
        ] {
            assert!(parse_profile(200, &bad).is_err());
        }
        assert!(parse_profile(401, body).is_err());
    }
}

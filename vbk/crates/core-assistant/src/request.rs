//! `TsimRequest`: the pure description of an HTTP request the host performs
//! (external-tsim.md "公共 Header 与身份"). No sockets here.

use std::fmt;

/// Fixed TSim API origin (external-tsim.md).
pub const API_ORIGIN: &str = "https://csapi.tsim.tech";
/// Response body limit (2 MiB).
pub const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Method {
    Get,
    Post,
}

impl Method {
    pub fn as_str(self) -> &'static str {
        match self {
            Method::Get => "GET",
            Method::Post => "POST",
        }
    }
}

/// A string whose `Debug` output is always redacted (passwords, tokens).
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct SecretString(String);

impl SecretString {
    pub fn new(s: impl Into<String>) -> Self {
        Self(s.into())
    }

    /// Explicit accessor; the only way to read the value.
    pub fn expose(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Debug for SecretString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<redacted>")
    }
}

impl From<&str> for SecretString {
    fn from(s: &str) -> Self {
        Self(s.to_string())
    }
}

impl From<String> for SecretString {
    fn from(s: String) -> Self {
        Self(s)
    }
}

/// One text part of a `multipart/form-data` body.
#[derive(Clone, PartialEq, Eq)]
pub struct MultipartPart {
    pub name: String,
    pub value: String,
    /// Redacted in `Debug` (e.g. `password`).
    pub sensitive: bool,
}

impl MultipartPart {
    pub fn text(name: impl Into<String>, value: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            value: value.into(),
            sensitive: false,
        }
    }

    pub fn secret(name: impl Into<String>, value: &SecretString) -> Self {
        Self {
            name: name.into(),
            value: value.expose().to_string(),
            sensitive: true,
        }
    }
}

impl fmt::Debug for MultipartPart {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut d = f.debug_struct("MultipartPart");
        d.field("name", &self.name);
        if self.sensitive {
            d.field("value", &"<redacted>");
        } else {
            d.field("value", &self.value);
        }
        d.finish()
    }
}

/// Request body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Body {
    /// Serialized JSON document; `Content-Type: application/json`.
    Json(String),
    /// `multipart/form-data; boundary=<boundary>`.
    Multipart {
        boundary: String,
        parts: Vec<MultipartPart>,
    },
    Empty,
}

/// Boundary rules (RFC 2046 §5.1.1): 1–70 chars of a safe subset; must not
/// occur in any part value.
pub fn validate_boundary(boundary: &str, parts: &[MultipartPart]) -> Result<(), &'static str> {
    if boundary.is_empty() || boundary.len() > 70 {
        return Err("boundary length must be 1..=70");
    }
    if !boundary.bytes().all(|b| {
        b.is_ascii_alphanumeric()
            || matches!(
                b,
                b'-' | b'_' | b'\'' | b'(' | b')' | b'+' | b',' | b'.' | b'/' | b':' | b'=' | b'?'
            )
    }) || boundary.ends_with(' ')
    {
        return Err("boundary contains an invalid character");
    }
    if parts
        .iter()
        .any(|p| p.value.contains(boundary) || p.name.contains(boundary))
    {
        return Err("boundary occurs in a part");
    }
    Ok(())
}

impl Body {
    pub fn content_type(&self) -> Option<String> {
        match self {
            Body::Json(_) => Some("application/json".to_string()),
            Body::Multipart { boundary, .. } => {
                Some(format!("multipart/form-data; boundary={boundary}"))
            }
            Body::Empty => None,
        }
    }

    /// Serializes the body to the exact bytes the host must send.
    ///
    /// Multipart layout (CRLF line ends):
    /// ```text
    /// --{boundary}\r\n
    /// Content-Disposition: form-data; name="{name}"\r\n
    /// \r\n
    /// {value}\r\n
    /// ...
    /// --{boundary}--\r\n
    /// ```
    pub fn encode(&self) -> Vec<u8> {
        match self {
            Body::Json(s) => s.as_bytes().to_vec(),
            Body::Empty => Vec::new(),
            Body::Multipart { boundary, parts } => {
                let mut out = Vec::new();
                for p in parts {
                    out.extend_from_slice(b"--");
                    out.extend_from_slice(boundary.as_bytes());
                    out.extend_from_slice(b"\r\nContent-Disposition: form-data; name=\"");
                    out.extend_from_slice(escape_disposition(&p.name).as_bytes());
                    out.extend_from_slice(b"\"\r\n\r\n");
                    out.extend_from_slice(p.value.as_bytes());
                    out.extend_from_slice(b"\r\n");
                }
                out.extend_from_slice(b"--");
                out.extend_from_slice(boundary.as_bytes());
                out.extend_from_slice(b"--\r\n");
                out
            }
        }
    }
}

fn escape_disposition(name: &str) -> String {
    name.replace('"', "%22")
        .replace('\r', "%0D")
        .replace('\n', "%0A")
}

/// Fully described request. `Debug` is safe to log: the bearer token and
/// sensitive multipart parts are redacted.
#[derive(Clone, PartialEq, Eq)]
pub struct TsimRequest {
    pub method: Method,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Body,
    pub max_response_bytes: usize,
    pub follow_redirects: bool,
}

impl fmt::Debug for TsimRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let headers: Vec<(String, String)> = self
            .headers
            .iter()
            .map(|(k, v)| {
                if k.eq_ignore_ascii_case("authorization") {
                    (k.clone(), "<redacted>".to_string())
                } else {
                    (k.clone(), v.clone())
                }
            })
            .collect();
        let body = match &self.body {
            Body::Json(_) => "Json(<omitted>)".to_string(),
            other => format!("{other:?}"),
        };
        f.debug_struct("TsimRequest")
            .field("method", &self.method)
            .field("url", &self.url)
            .field("headers", &headers)
            .field("body", &body)
            .field("max_response_bytes", &self.max_response_bytes)
            .field("follow_redirects", &self.follow_redirects)
            .finish()
    }
}

impl TsimRequest {
    fn base(method: Method, url: String, bearer: Option<&str>, body: Body) -> Self {
        let mut headers = vec![("Accept".to_string(), "application/json".to_string())];
        if let Some(t) = bearer {
            headers.push(("Authorization".to_string(), format!("Bearer {t}")));
        }
        if let Some(ct) = body.content_type() {
            headers.push(("Content-Type".to_string(), ct));
        }
        Self {
            method,
            url,
            headers,
            body,
            max_response_bytes: MAX_RESPONSE_BYTES,
            follow_redirects: false,
        }
    }

    pub fn get(path_and_query: &str, bearer: &str) -> Self {
        Self::base(
            Method::Get,
            format!("{API_ORIGIN}{path_and_query}"),
            Some(bearer),
            Body::Empty,
        )
    }

    pub fn post_json(path: &str, bearer: &str, json: String) -> Self {
        Self::base(
            Method::Post,
            format!("{API_ORIGIN}{path}"),
            Some(bearer),
            Body::Json(json),
        )
    }

    pub fn post_empty(path: &str, bearer: &str) -> Self {
        Self::base(
            Method::Post,
            format!("{API_ORIGIN}{path}"),
            Some(bearer),
            Body::Empty,
        )
    }

    /// Multipart POST without bearer (login).
    pub fn post_multipart(path: &str, boundary: String, parts: Vec<MultipartPart>) -> Self {
        Self::base(
            Method::Post,
            format!("{API_ORIGIN}{path}"),
            None,
            Body::Multipart { boundary, parts },
        )
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multipart_exact_layout() {
        let parts = vec![
            MultipartPart::text("username", "alice"),
            MultipartPart::secret("password", &SecretString::new("p@ss")),
        ];
        let body = Body::Multipart {
            boundary: "XbOuNdArY".into(),
            parts,
        };
        let expected = "--XbOuNdArY\r\nContent-Disposition: form-data; name=\"username\"\r\n\r\nalice\r\n--XbOuNdArY\r\nContent-Disposition: form-data; name=\"password\"\r\n\r\np@ss\r\n--XbOuNdArY--\r\n";
        assert_eq!(body.encode(), expected.as_bytes());
        assert_eq!(
            body.content_type().as_deref(),
            Some("multipart/form-data; boundary=XbOuNdArY")
        );
        let dbg = format!("{body:?}");
        assert!(dbg.contains("alice"));
        assert!(!dbg.contains("p@ss"));
        assert!(dbg.contains("<redacted>"));
    }

    #[test]
    fn boundary_validation() {
        assert!(validate_boundary("abc-123", &[]).is_ok());
        assert!(validate_boundary("", &[]).is_err());
        assert!(validate_boundary(&"a".repeat(71), &[]).is_err());
        assert!(validate_boundary("a b", &[]).is_err());
        assert!(validate_boundary("abc", &[MultipartPart::text("x", "xxabcxx")]).is_err());
    }

    #[test]
    fn request_debug_redacts_bearer() {
        let r = TsimRequest::get("/agent/profile", "tok-123");
        assert_eq!(r.header("Authorization"), Some("Bearer tok-123"));
        assert_eq!(r.header("accept"), Some("application/json"));
        assert!(r.header("Content-Type").is_none());
        let dbg = format!("{r:?}");
        assert!(!dbg.contains("tok-123"));
        assert!(!r.follow_redirects);
        assert_eq!(r.max_response_bytes, 2 * 1024 * 1024);
        assert_eq!(r.url, "https://csapi.tsim.tech/agent/profile");
        let p = TsimRequest::post_json("/x", "t", "{\"secret\":1}".into());
        assert!(!format!("{p:?}").contains("secret"));
        assert_eq!(p.header("Content-Type"), Some("application/json"));
    }

    #[test]
    fn secret_string_redacts() {
        let s = SecretString::new("hunter2");
        assert_eq!(format!("{s:?}"), "<redacted>");
        assert_eq!(s.expose(), "hunter2");
    }
}

//! HTTP execution of `core_assistant::TsimRequest` values.
//!
//! The executor is a trait so the service logic is testable offline; the
//! production implementation uses reqwest with redirects disabled, HTTPS
//! only, the TSim origin pinned and the 2 MiB response limit enforced while
//! streaming. Nothing here logs URLs, headers or bodies (they carry the
//! bearer token, identifiers or draft text).

use std::future::Future;
use std::time::Duration;

use contracts::{codes, AppError};
use core_assistant::{Body, Method, TsimRequest, API_ORIGIN};

/// Status and body of a completed exchange (any status, 2xx or not).
#[derive(Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

impl std::fmt::Debug for HttpResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Bodies may contain tokens or customer text.
        f.debug_struct("HttpResponse")
            .field("status", &self.status)
            .field("body_len", &self.body.len())
            .finish()
    }
}

/// Performs one request. Transport failures map to `net.*` codes; a timeout
/// is reported as `net.timeout` and is never retried by the caller.
pub trait Executor: Send + Sync + 'static {
    fn execute(
        &self,
        req: &TsimRequest,
    ) -> impl Future<Output = Result<HttpResponse, AppError>> + Send;
}

/// Total request timeout.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Rejects anything that is not `https://csapi.tsim.tech/...`.
pub fn check_origin(url: &str) -> Result<(), AppError> {
    let ok = url
        .strip_prefix(API_ORIGIN)
        .is_some_and(|rest| rest.starts_with('/'));
    if ok {
        Ok(())
    } else {
        Err(AppError::new(
            codes::HOST_URL_REJECTED,
            "tsim request outside the fixed api origin",
        ))
    }
}

/// Appends `chunk` to `buf` unless the total would exceed `limit`.
pub fn append_limited(buf: &mut Vec<u8>, chunk: &[u8], limit: usize) -> Result<(), AppError> {
    if buf.len().saturating_add(chunk.len()) > limit {
        return Err(AppError::new(
            codes::NET_PAYLOAD_TOO_LARGE,
            "tsim response exceeds 2 MiB",
        ));
    }
    buf.extend_from_slice(chunk);
    Ok(())
}

fn transport_error(e: &reqwest::Error) -> AppError {
    if e.is_timeout() {
        AppError::new(codes::NET_TIMEOUT, "tsim request timed out").retryable()
    } else if e.is_connect() {
        AppError::new(codes::NET_OFFLINE, "tsim unreachable").retryable()
    } else if e.is_redirect() {
        AppError::new(codes::HOST_URL_REJECTED, "tsim redirect refused")
    } else {
        AppError::new(codes::NET_OFFLINE, "tsim transport error").retryable()
    }
}

/// Production executor.
#[derive(Clone)]
pub struct ReqwestExecutor {
    client: reqwest::Client,
}

impl ReqwestExecutor {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .https_only(true)
            .timeout(REQUEST_TIMEOUT)
            .connect_timeout(CONNECT_TIMEOUT)
            .build()
            .unwrap_or_else(|e| {
                log::warn!(
                    "assistant: http client builder failed ({}); using defaults",
                    transport_error(&e).code
                );
                reqwest::Client::new()
            });
        Self { client }
    }
}

impl Default for ReqwestExecutor {
    fn default() -> Self {
        Self::new()
    }
}

async fn send(client: reqwest::Client, req: TsimRequest) -> Result<HttpResponse, AppError> {
    check_origin(&req.url)?;
    let method = match req.method {
        Method::Get => reqwest::Method::GET,
        Method::Post => reqwest::Method::POST,
    };
    let mut rb = client.request(method, &req.url);
    for (k, v) in &req.headers {
        rb = rb.header(k.as_str(), v.as_str());
    }
    if !matches!(req.body, Body::Empty) {
        rb = rb.body(req.body.encode());
    }
    let mut resp = rb.send().await.map_err(|e| transport_error(&e))?;
    let status = resp.status().as_u16();
    if resp
        .content_length()
        .is_some_and(|n| n > req.max_response_bytes as u64)
    {
        return Err(AppError::new(
            codes::NET_PAYLOAD_TOO_LARGE,
            "tsim response exceeds 2 MiB",
        ));
    }
    let mut buf = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| transport_error(&e))? {
        append_limited(&mut buf, &chunk, req.max_response_bytes)?;
    }
    Ok(HttpResponse {
        status,
        body: String::from_utf8_lossy(&buf).into_owned(),
    })
}

impl Executor for ReqwestExecutor {
    fn execute(
        &self,
        req: &TsimRequest,
    ) -> impl Future<Output = Result<HttpResponse, AppError>> + Send {
        send(self.client.clone(), req.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_is_pinned() {
        assert!(check_origin("https://csapi.tsim.tech/agent/login").is_ok());
        assert!(check_origin("https://csapi.tsim.tech").is_err());
        assert!(check_origin("https://csapi.tsim.tech.evil.example/agent").is_err());
        assert!(check_origin("http://csapi.tsim.tech/agent").is_err());
        assert!(check_origin("https://csapi.tsim.tech@evil.example/").is_err());
    }

    #[test]
    fn body_limit() {
        let mut buf = Vec::new();
        append_limited(&mut buf, &[0; 6], 10).expect("fits");
        append_limited(&mut buf, &[0; 4], 10).expect("exactly the limit");
        let e = append_limited(&mut buf, &[0; 1], 10).expect_err("over");
        assert!(e.is(codes::NET_PAYLOAD_TOO_LARGE));
        assert_eq!(buf.len(), 10);
    }

    #[test]
    fn response_debug_hides_body() {
        let r = HttpResponse {
            status: 200,
            body: "secret-token".into(),
        };
        assert!(!format!("{r:?}").contains("secret"));
    }
}

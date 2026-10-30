//! Unified `AppError` (archive §4.4).
//!
//! `retryable` is a hint only: it never authorizes an automatic retry of a
//! write whose outcome is unknown. User-facing copy is looked up by `code`
//! on the UI side; `message` is for developers and must never contain
//! cookies, tickets, tokens or customer text.

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppError {
    /// Stable string code, prefixed by module: `account.*`, `net.*`, `im.*`,
    /// `notify.*`, `store.*`, `assistant.*`, `order.*`, `host.*`.
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub detail: Option<String>,
}

impl AppError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable: false,
            detail: None,
        }
    }

    pub fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    pub fn is(&self, code: &str) -> bool {
        self.code == code
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}

/// Cross-module error codes. Module-private codes live in their own crates
/// but must keep the prefix convention.
pub mod codes {
    pub const NET_OFFLINE: &str = "net.offline";
    pub const NET_TIMEOUT: &str = "net.timeout";
    pub const NET_PAYLOAD_TOO_LARGE: &str = "net.payload_too_large";
    /// Mapped by core-net from the server's not-logged-in response
    /// (e.g. `AccountsMobileRequestFilterException`) and reported to
    /// core-account.
    pub const ACCOUNT_TICKET_EXPIRED: &str = "account.ticket_expired";
    /// The caller's `session_generation` is older than the current one.
    pub const ACCOUNT_STALE_GENERATION: &str = "account.stale_generation";
    pub const ACCOUNT_UNKNOWN: &str = "account.unknown";
    /// The source view is not authorized for the requested scope.
    pub const HOST_VIEW_UNAUTHORIZED: &str = "host.view_unauthorized";
    /// A write finished with an unknown outcome; reconcile before retrying.
    pub const IM_SEND_UNKNOWN: &str = "im.send_unknown";
    pub const IM_PERMISSION_DENIED: &str = "im.permission_denied";
    pub const NOTIFY_ROUND_VERSION_MISMATCH: &str = "notify.round_version_mismatch";
    pub const STORE_IO: &str = "store.io";
    pub const STORE_CORRUPT: &str = "store.corrupt";
    /// The account's official-page webview is not connected yet.
    pub const ADAPTER_NOT_READY: &str = "adapter.not_ready";
    /// The page did not answer an `adapter://request` in time.
    pub const ADAPTER_TIMEOUT: &str = "adapter.timeout";
    /// The page reported an upstream business failure.
    pub const ADAPTER_FAILED: &str = "adapter.failed";
    /// Feature wired but not implemented on this platform/build.
    pub const HOST_UNSUPPORTED: &str = "host.unsupported";
    /// URL rejected by the host's official-origin policy.
    pub const HOST_URL_REJECTED: &str = "host.url_rejected";
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builder_and_display() {
        let e = AppError::new(codes::NET_TIMEOUT, "request timed out")
            .retryable()
            .with_detail("endpoint=getConversationList");
        assert!(e.retryable);
        assert!(e.is(codes::NET_TIMEOUT));
        assert_eq!(e.to_string(), "net.timeout: request timed out");
        assert_eq!(e.detail.as_deref(), Some("endpoint=getConversationList"));
    }
}

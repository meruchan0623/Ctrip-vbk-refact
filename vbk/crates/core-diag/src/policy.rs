//! Field allow-list. A key not listed here is *always* masked, whatever its
//! value looks like (default-deny): a developer adding a new field to a
//! `diag_log!` call cannot leak it by forgetting to register it.

use crate::detect::{self, basename};
use crate::sha256::{hex_prefix, sha256};
use crate::value::Value;

/// How a registered key is rendered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Policy {
    /// Account identifier -> first 8 hex of salted SHA-256.
    AccountHash,
    /// Conversation gid -> `ab***yz` (never the whole id).
    GidMask,
    /// Opaque id / code: `[A-Za-z0-9_.:-]{1,64}` only.
    Token,
    /// Like `Token` but `/` is allowed (API endpoint names).
    Endpoint,
    /// Counter / timestamp: must be an integer.
    Int,
    /// Must be a bool.
    Bool,
    /// URL: scheme + host + path, query/fragment/userinfo stripped.
    Url,
    /// File path: file name only, directory becomes `<dir>`.
    Path,
    /// Free text: regex-style masker, truncated to 512 chars.
    Text,
}

/// The registered keys. Anything else is masked.
pub const ALLOW_LIST: &[(&str, Policy)] = &[
    ("account", Policy::AccountHash),
    ("account_id", Policy::AccountHash),
    ("accountid", Policy::AccountHash),
    ("buid", Policy::AccountHash),
    ("uid", Policy::AccountHash),
    ("gid", Policy::GidMask),
    ("msg_id", Policy::Token),
    ("msgid", Policy::Token),
    ("server_msg_id", Policy::Token),
    ("local_id", Policy::Token),
    ("round_id", Policy::Token),
    ("request_id", Policy::Token),
    ("trace_id", Policy::Token),
    ("error_code", Policy::Token),
    ("code", Policy::Token),
    ("result_code", Policy::Token),
    ("status", Policy::Token),
    ("endpoint", Policy::Endpoint),
    ("count", Policy::Int),
    ("len", Policy::Int),
    ("bytes", Policy::Int),
    ("size", Policy::Int),
    ("attempt", Policy::Int),
    ("retry", Policy::Int),
    ("duration_ms", Policy::Int),
    ("elapsed_ms", Policy::Int),
    ("queue_len", Policy::Int),
    ("pending", Policy::Int),
    ("unread", Policy::Int),
    ("generation", Policy::Int),
    ("http_status", Policy::Int),
    ("ts", Policy::Int),
    ("ts_ms", Policy::Int),
    ("at_ms", Policy::Int),
    ("server_ts", Policy::Int),
    ("ok", Policy::Bool),
    ("success", Policy::Bool),
    ("connected", Policy::Bool),
    ("online", Policy::Bool),
    ("url", Policy::Url),
    ("path", Policy::Path),
    ("file", Policy::Path),
    ("error", Policy::Text),
    ("reason", Policy::Text),
];

/// Longest rendered free-text / value, in chars.
pub const MAX_TEXT_CHARS: usize = 512;

/// Policy for `key` (case-insensitive), if registered.
pub fn policy_of(key: &str) -> Option<Policy> {
    let k = key.to_ascii_lowercase();
    ALLOW_LIST.iter().find(|(n, _)| *n == k).map(|(_, p)| *p)
}

/// Stable, non-reversible tag for an account id: 8 hex chars of
/// `SHA-256(salt ":" id)`. The salt keeps low-entropy numeric ids from being
/// recovered by a table lookup of the log alone.
pub fn account_tag(salt: &str, id: &str) -> String {
    let mut buf = Vec::with_capacity(salt.len() + id.len() + 1);
    buf.extend_from_slice(salt.as_bytes());
    buf.push(b':');
    buf.extend_from_slice(id.as_bytes());
    hex_prefix(&sha256(&buf), 8)
}

/// `ab***yz` for long ids, `***` for short ones.
pub fn mask_gid(gid: &str) -> String {
    let chars: Vec<char> = gid.chars().collect();
    if chars.len() < 9 {
        return "***".to_string();
    }
    let head: String = chars[..2].iter().collect();
    let tail: String = chars[chars.len() - 2..].iter().collect();
    format!("{head}***{tail}")
}

/// Truncates to `max` chars (no marker needed to stay within the bound).
pub fn truncate_chars(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((idx, _)) => s[..idx].to_string(),
        None => s.to_string(),
    }
}

/// Free-text masker used for `log::*` bridging and `Text` fields: mask all
/// sensitive shapes, neutralise control characters, cut to 512 chars.
pub fn sanitize_text(raw: &str) -> String {
    // Bound the work first; the tail beyond this is dropped by truncation
    // anyway (masking only ever shortens or keeps length-ish).
    let bounded = truncate_chars(raw, 64 * 1024);
    let (masked, _) = detect::mask(&bounded);
    let cleaned: String = masked
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    truncate_chars(&cleaned, MAX_TEXT_CHARS)
}

fn redacted(v: &Value) -> String {
    format!("<redacted:{}>", v.type_label())
}

fn token_ok(s: &str, allow_slash: bool) -> bool {
    !s.is_empty()
        && s.chars().count() <= 64
        && s.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(c, '_' | '.' | ':' | '-')
                || (allow_slash && c == '/')
        })
        && detect::detect(s).is_empty()
}

fn as_text(v: &Value) -> Option<String> {
    match v {
        Value::Str(s) => Some(s.clone()),
        Value::Int(i) => Some(i.to_string()),
        Value::Bool(_) => None,
    }
}

/// Renders one field to its final (already safe) string. Never returns the
/// raw value of an unregistered key or of a registered key whose value does
/// not fit its policy.
pub fn render_field(key: &str, value: &Value, salt: &str) -> String {
    let Some(policy) = policy_of(key) else {
        return redacted(value);
    };
    match (policy, value) {
        (Policy::AccountHash, v) => match as_text(v) {
            Some(s) if !s.is_empty() => account_tag(salt, &s),
            _ => redacted(value),
        },
        (Policy::GidMask, v) => match as_text(v) {
            Some(s) => mask_gid(&s),
            None => redacted(value),
        },
        (Policy::Token, v) | (Policy::Endpoint, v) => match as_text(v) {
            Some(s) if token_ok(&s, policy == Policy::Endpoint) => s,
            _ => redacted(value),
        },
        (Policy::Int, Value::Int(i)) => i.to_string(),
        (Policy::Bool, Value::Bool(b)) => b.to_string(),
        (Policy::Url, Value::Str(s)) => sanitize_text(s),
        (Policy::Path, Value::Str(s)) => {
            let base = basename(s);
            if base.is_empty() {
                "<dir>".to_string()
            } else if s.contains('/') || s.contains('\\') {
                sanitize_text(&format!("<dir>/{base}"))
            } else {
                sanitize_text(base)
            }
        }
        (Policy::Text, Value::Str(s)) => sanitize_text(s),
        _ => redacted(value),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_tag_is_8_hex_stable_and_salted() {
        let a = account_tag("s", "12345678");
        assert_eq!(a.len(), 8);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(a, account_tag("s", "12345678"));
        assert_ne!(a, account_tag("t", "12345678"));
        assert_ne!(a, account_tag("s", "12345679"));
    }

    #[test]
    fn gid_mask_never_shows_middle() {
        assert_eq!(mask_gid("abcdefghijkl"), "ab***kl");
        assert_eq!(mask_gid("short"), "***");
    }

    #[test]
    fn truncation_is_by_chars() {
        let s = "界".repeat(600);
        assert_eq!(truncate_chars(&s, 512).chars().count(), 512);
        assert_eq!(sanitize_text(&s).chars().count(), 512);
    }
}

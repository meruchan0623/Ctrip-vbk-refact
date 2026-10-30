//! URL validation for official pages (docs/dev/04, research
//! 2026-10-30-web-order-conversation §3).
//!
//! Rules: `https` only; the host must **equal** an allowed host (no suffix /
//! contains matching, no userinfo, only the default port); the path must be
//! in the allowed list; the query is parsed into typed fields and unknown
//! parameters are preserved together with the raw URL — the client never
//! rebuilds a "similar-looking" URL.

use contracts::AppError;

use crate::soa::net_codes;

/// Official IM launch hosts.
pub const IM_HOST_IMVENDOR: &str = "imvendor.ctrip.com";
pub const IM_HOST_VBOOKING: &str = "vbooking.ctrip.com";
/// Official IM launch paths.
pub const IM_PATH_MAIN: &str = "/main";
pub const IM_PATH_VBK_MAIN: &str = "/vbk/im/main";

/// Official login page (authentication.md "登录范围").
pub const LOGIN_PAGE_URL: &str = "https://vbooking.ctrip.com/ivbk/accountV2/login";
/// Order detail page base (docs/dev/04 "网页高级操作").
pub const ORDER_DETAIL_BASE_URL: &str = "https://vbooking.ctrip.com/ticket_order/order/detail";
pub const VBOOKING_ORIGIN: &str = "https://vbooking.ctrip.com";

/// Allowed hosts and paths for an IM launch URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UrlPolicy {
    /// Lower-case host names compared for exact equality.
    pub allowed_hosts: Vec<String>,
    /// Exact paths.
    pub allowed_paths: Vec<String>,
}

impl Default for UrlPolicy {
    fn default() -> Self {
        Self::official_im()
    }
}

impl UrlPolicy {
    pub fn official_im() -> Self {
        Self {
            allowed_hosts: vec![IM_HOST_IMVENDOR.to_string(), IM_HOST_VBOOKING.to_string()],
            allowed_paths: vec![IM_PATH_MAIN.to_string(), IM_PATH_VBK_MAIN.to_string()],
        }
    }
}

/// Typed view of the IM launch URL returned by `14361/createimchat`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ImLaunchUrl {
    pub raw: String,
    pub host: String,
    pub path: String,
    /// `initChat` (`2` = customer conversation branch in the sample).
    pub init_chat: Option<String>,
    /// `serviceType`, e.g. `1513`; opaque, per business line.
    pub service_type: Option<String>,
    /// `vendorRole`, e.g. `VBK`.
    pub vendor_role: Option<String>,
    /// `currentTab`, e.g. `BC`.
    pub current_tab: Option<String>,
    /// `accountsource`.
    pub account_source: Option<String>,
    /// `client-source`, e.g. `pc-1001`.
    pub client_source: Option<String>,
    pub lang: Option<String>,
    pub vendor_ref_id: Option<String>,
    pub thread_id: Option<String>,
    pub order_no: Option<String>,
    pub ext_params: Option<String>,
    pub target_gid: Option<String>,
    /// Parameters not typed above (and repeated typed keys), in order.
    pub unknown: Vec<(String, String)>,
}

fn rejected(reason: &str) -> AppError {
    AppError::new(net_codes::NET_URL_REJECTED, format!("url rejected: {reason}"))
}

/// Parsed pieces of an https URL after structural validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpsUrl {
    pub host: String,
    pub path: String,
    pub query: Vec<(String, String)>,
}

impl HttpsUrl {
    pub fn origin(&self) -> String {
        format!("https://{}", self.host)
    }
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Percent-decodes a query component (`+` → space). Invalid escapes are
/// kept literally; invalid UTF-8 is replaced.
pub fn percent_decode_query(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 2 < b.len() => {
                match (hex_val(b[i + 1]), hex_val(b[i + 2])) {
                    (Some(h), Some(l)) => {
                        out.push((h << 4) | l);
                        i += 3;
                    }
                    _ => {
                        out.push(b'%');
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn valid_host_chars(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'.')
        && !host.starts_with('.')
        && !host.ends_with('.')
        && !host.contains("..")
}

/// Structural validation shared by every validator: https scheme, no
/// userinfo, no explicit non-default port, sane characters, no fragment
/// tricks. Returns the lower-cased host, the path and the decoded query.
pub fn parse_https_url(url: &str) -> Result<HttpsUrl, AppError> {
    if url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(rejected("control or whitespace character"));
    }
    if url.contains('\\') {
        return Err(rejected("backslash"));
    }
    // Scheme must be exactly "https" (case-insensitive) followed by "://".
    let Some(idx) = url.find("://") else {
        return Err(rejected("missing scheme"));
    };
    if !url[..idx].eq_ignore_ascii_case("https") {
        return Err(rejected("scheme is not https"));
    }
    let rest = &url[idx + 3..];
    let end_authority = rest
        .find(['/', '?', '#'])
        .unwrap_or(rest.len());
    let authority = &rest[..end_authority];
    let after = &rest[end_authority..];
    if authority.contains('@') {
        return Err(rejected("userinfo not allowed"));
    }
    let (host, port) = match authority.find(':') {
        Some(p) => (&authority[..p], Some(&authority[p + 1..])),
        None => (authority, None),
    };
    if let Some(p) = port {
        if p != "443" {
            return Err(rejected("non-default port"));
        }
    }
    if host.starts_with('[') {
        return Err(rejected("ip literal host"));
    }
    if !valid_host_chars(host) {
        return Err(rejected("invalid host"));
    }
    let host = host.to_ascii_lowercase();
    // Split path / query / fragment.
    let (path_query, _fragment) = match after.find('#') {
        Some(h) => (&after[..h], Some(&after[h + 1..])),
        None => (after, None),
    };
    let (path, query_str) = match path_query.find('?') {
        Some(q) => (&path_query[..q], Some(&path_query[q + 1..])),
        None => (path_query, None),
    };
    let path = if path.is_empty() { "/".to_string() } else { path.to_string() };
    if path.contains("/../") || path.ends_with("/..") || path.contains("/./") || path.contains("//") {
        return Err(rejected("dot segments or empty segments in path"));
    }
    if path.to_ascii_lowercase().contains("%2f") || path.to_ascii_lowercase().contains("%5c") {
        return Err(rejected("encoded slash in path"));
    }
    let mut query = Vec::new();
    if let Some(q) = query_str {
        for pair in q.split('&') {
            if pair.is_empty() {
                continue;
            }
            let (k, v) = match pair.find('=') {
                Some(e) => (&pair[..e], &pair[e + 1..]),
                None => (pair, ""),
            };
            query.push((percent_decode_query(k), percent_decode_query(v)));
        }
    }
    Ok(HttpsUrl { host, path, query })
}

/// Validates the IM URL returned by the server and parses it into typed
/// fields. Any deviation from the policy fails with `net.url_rejected`.
pub fn validate_official_im_url(url: &str, policy: &UrlPolicy) -> Result<ImLaunchUrl, AppError> {
    let parsed = parse_https_url(url)?;
    if !policy.allowed_hosts.iter().any(|h| h.eq_ignore_ascii_case(&parsed.host)) {
        return Err(rejected("host not allowed"));
    }
    if !policy.allowed_paths.iter().any(|p| p == &parsed.path) {
        return Err(rejected("path not allowed"));
    }
    let mut out = ImLaunchUrl {
        raw: url.to_string(),
        host: parsed.host,
        path: parsed.path,
        ..ImLaunchUrl::default()
    };
    for (k, v) in parsed.query {
        let slot: Option<&mut Option<String>> = match k.as_str() {
            "initChat" => Some(&mut out.init_chat),
            "serviceType" => Some(&mut out.service_type),
            "vendorRole" => Some(&mut out.vendor_role),
            "currentTab" => Some(&mut out.current_tab),
            "accountsource" => Some(&mut out.account_source),
            "client-source" => Some(&mut out.client_source),
            "lang" => Some(&mut out.lang),
            "vendorRefId" => Some(&mut out.vendor_ref_id),
            "threadId" => Some(&mut out.thread_id),
            "orderNo" => Some(&mut out.order_no),
            "extParams" => Some(&mut out.ext_params),
            "targetGid" => Some(&mut out.target_gid),
            _ => None,
        };
        match slot {
            Some(s) if s.is_none() => *s = Some(v),
            _ => out.unknown.push((k, v)),
        }
    }
    Ok(out)
}

/// Validates that `url` is https and its host exactly matches one of
/// `allowed_https_origins` (each given as `https://host`). Used for the
/// official login page and the order detail page before navigation.
pub fn validate_navigation_origin(url: &str, allowed_https_origins: &[&str]) -> Result<HttpsUrl, AppError> {
    let parsed = parse_https_url(url)?;
    let origin = parsed.origin();
    let ok = allowed_https_origins.iter().any(|o| {
        let o = o.trim_end_matches('/');
        o.eq_ignore_ascii_case(&origin)
    });
    if ok {
        Ok(parsed)
    } else {
        Err(rejected("origin not allowed"))
    }
}

/// Maximum accepted order id length.
pub const MAX_ORDER_ID_LEN: usize = 64;

/// Order ids are opaque strings of `[0-9A-Za-z_-]` (the official page uses
/// numeric `ttdOrderId`; letters are tolerated for other id forms) — nothing
/// that could alter the URL.
pub fn validate_order_id(order_id: &str) -> Result<&str, AppError> {
    if order_id.is_empty() || order_id.len() > MAX_ORDER_ID_LEN {
        return Err(rejected("order id length"));
    }
    if !order_id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(rejected("order id charset"));
    }
    Ok(order_id)
}

/// `https://vbooking.ctrip.com/ticket_order/order/detail?orderId={id}`.
pub fn order_detail_url(order_id: &str) -> Result<String, AppError> {
    let id = validate_order_id(order_id)?;
    let url = format!("{ORDER_DETAIL_BASE_URL}?orderId={id}");
    // Defensive: the result must itself pass navigation validation.
    validate_navigation_origin(&url, &[VBOOKING_ORIGIN])?;
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(url: &str) -> ImLaunchUrl {
        validate_official_im_url(url, &UrlPolicy::default()).expect("valid")
    }

    fn bad(url: &str) {
        let r = validate_official_im_url(url, &UrlPolicy::default());
        assert!(r.is_err(), "expected rejection: {url}");
        assert!(r.err().map(|e| e.is(net_codes::NET_URL_REJECTED)).unwrap_or(false));
    }

    #[test]
    fn positive_matrix() {
        let u = ok("https://imvendor.ctrip.com/main?initChat=2&serviceType=1513&vendorRole=VBK&currentTab=BC&accountsource=VBK&client-source=pc-1001&lang=&vendorRefId=r1&threadId=t1&orderNo=o1&extParams=%7B%22a%22%3A1%7D&targetGid=&foo=bar&foo=baz");
        assert_eq!(u.host, "imvendor.ctrip.com");
        assert_eq!(u.path, "/main");
        assert_eq!(u.init_chat.as_deref(), Some("2"));
        assert_eq!(u.service_type.as_deref(), Some("1513"));
        assert_eq!(u.vendor_role.as_deref(), Some("VBK"));
        assert_eq!(u.current_tab.as_deref(), Some("BC"));
        assert_eq!(u.account_source.as_deref(), Some("VBK"));
        assert_eq!(u.client_source.as_deref(), Some("pc-1001"));
        assert_eq!(u.lang.as_deref(), Some(""));
        assert_eq!(u.vendor_ref_id.as_deref(), Some("r1"));
        assert_eq!(u.thread_id.as_deref(), Some("t1"));
        assert_eq!(u.order_no.as_deref(), Some("o1"));
        assert_eq!(u.ext_params.as_deref(), Some("{\"a\":1}"));
        assert_eq!(u.target_gid.as_deref(), Some(""));
        assert_eq!(
            u.unknown,
            vec![
                ("foo".to_string(), "bar".to_string()),
                ("foo".to_string(), "baz".to_string())
            ]
        );
        assert!(u.raw.starts_with("https://imvendor.ctrip.com/main?"));

        let v = ok("https://vbooking.ctrip.com/vbk/im/main");
        assert_eq!(v.path, "/vbk/im/main");
        assert!(v.unknown.is_empty());
        // Default port and upper-case host/scheme are the same origin.
        let w = ok("HTTPS://IMVENDOR.ctrip.com:443/main?initChat=2");
        assert_eq!(w.host, "imvendor.ctrip.com");
        // Fragment is ignored, not a reason to reject.
        assert_eq!(ok("https://imvendor.ctrip.com/main#x").path, "/main");
        // Repeated typed key goes to unknown, first wins.
        let d = ok("https://imvendor.ctrip.com/main?initChat=2&initChat=3");
        assert_eq!(d.init_chat.as_deref(), Some("2"));
        assert_eq!(d.unknown, vec![("initChat".to_string(), "3".to_string())]);
    }

    #[test]
    fn negative_matrix() {
        bad("http://imvendor.ctrip.com/main");
        bad("https://evil-imvendor.ctrip.com/main");
        bad("https://imvendor.ctrip.com.evil.com/main");
        bad("https://evil.com/imvendor.ctrip.com/main");
        bad("https://imvendor.ctrip.com@evil.com/main");
        bad("https://evil.com@imvendor.ctrip.com/main");
        bad("https://user:pw@imvendor.ctrip.com/main");
        bad("https://imvendor.ctrip.com:8443/main");
        bad("https://imvendor.ctrip.com./main");
        bad("https://imvendor.ctrip.com/other");
        bad("https://imvendor.ctrip.com/main/");
        bad("https://vbooking.ctrip.com/main/../main");
        bad("https://imvendor.ctrip.com/%6Dain");
        bad("https://imvendor.ctrip.com\\@evil.com/main");
        bad("https://imvendor.ctrip.com/main?x=1\n");
        bad("https://imvendor.ctrip.com /main");
        bad("javascript:alert(1)");
        bad("//imvendor.ctrip.com/main");
        bad("https:///main");
        bad("https://[::1]/main");
        bad("");
    }

    #[test]
    fn navigation_origin() {
        let p = validate_navigation_origin(LOGIN_PAGE_URL, &[VBOOKING_ORIGIN]).expect("login page");
        assert_eq!(p.path, "/ivbk/accountV2/login");
        assert!(validate_navigation_origin("https://vbooking.ctrip.com.evil.com/ivbk", &[VBOOKING_ORIGIN]).is_err());
        assert!(validate_navigation_origin("http://vbooking.ctrip.com/ivbk", &[VBOOKING_ORIGIN]).is_err());
        assert!(validate_navigation_origin("https://vbooking.ctrip.com/x", &["https://imvendor.ctrip.com"]).is_err());
        assert!(validate_navigation_origin("https://vbooking.ctrip.com/x", &["https://vbooking.ctrip.com/"]).is_ok());
    }

    #[test]
    fn order_detail_url_builder() {
        assert_eq!(
            order_detail_url("1234567890").expect("ok"),
            "https://vbooking.ctrip.com/ticket_order/order/detail?orderId=1234567890"
        );
        assert!(order_detail_url("").is_err());
        assert!(order_detail_url("123&x=1").is_err());
        assert!(order_detail_url("123#frag").is_err());
        assert!(order_detail_url("123/../x").is_err());
        assert!(order_detail_url("1 2").is_err());
        assert!(order_detail_url("１２３").is_err());
        assert!(order_detail_url(&"9".repeat(65)).is_err());
        assert!(order_detail_url("AB-12_3").is_ok());
        let d = validate_navigation_origin(&order_detail_url("42").expect("ok"), &[VBOOKING_ORIGIN]).expect("nav");
        assert_eq!(d.query, vec![("orderId".to_string(), "42".to_string())]);
    }

    #[test]
    fn percent_decoding() {
        assert_eq!(percent_decode_query("a%20b+c"), "a b c");
        assert_eq!(percent_decode_query("%E4%B8%AD"), "中");
        assert_eq!(percent_decode_query("%zz%"), "%zz%");
        assert_eq!(percent_decode_query("%4"), "%4");
    }
}

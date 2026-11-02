//! One detector for every sensitive shape, shared by the log masker, the
//! diagnostic-export sanitizer and the post-hoc scanner. Because all three
//! use [`detect`], "mask, then scan" is zero-hit by construction (and the
//! tests assert it on every sample).
//!
//! Hand-written scanners instead of a regex engine (std-only). Everything
//! matched is ASCII-delimited, so byte offsets are always char boundaries.

/// Class of sensitive content.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Kind {
    /// ticket / token / password / secret / bearer / JWT / URL userinfo.
    Ticket,
    /// Cookie / Set-Cookie / Authorization header value.
    Cookie,
    /// Mainland mobile number.
    Phone,
    /// Order number following an order keyword.
    Order,
    /// E-mail address.
    Email,
    /// 15/18-digit citizen ID number.
    IdCard,
    /// URL query string or fragment (official APIs carry the ticket there).
    UrlQuery,
    /// Absolute path that exposes a home/user directory.
    HomePath,
}

impl Kind {
    pub fn label(self) -> &'static str {
        match self {
            Kind::Ticket => "ticket",
            Kind::Cookie => "cookie",
            Kind::Phone => "phone",
            Kind::Order => "order",
            Kind::Email => "email",
            Kind::IdCard => "id_card",
            Kind::UrlQuery => "url_query",
            Kind::HomePath => "home_path",
        }
    }
}

/// Byte range `[start, end)` of one sensitive match.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Span {
    pub start: usize,
    pub end: usize,
    pub kind: Kind,
}

fn is_ident(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn is_name_byte(b: u8) -> bool {
    is_ident(b) || b == b'-' || b == b'.'
}

fn prev_is(bytes: &[u8], i: usize, f: impl Fn(u8) -> bool) -> bool {
    i > 0 && f(bytes[i - 1])
}

/// All sensitive spans, sorted, overlaps merged (first start wins the kind).
pub fn detect(text: &str) -> Vec<Span> {
    let bytes = text.as_bytes();
    let lower = text.to_ascii_lowercase();
    let lb = lower.as_bytes();
    let mut spans = Vec::new();
    find_urls(bytes, lb, &mut spans);
    find_kv_secrets(bytes, lb, &mut spans);
    find_bearer_jwt(bytes, lb, &mut spans);
    find_emails(bytes, &mut spans);
    find_digit_runs(bytes, &mut spans);
    find_orders(text, &lower, &mut spans);
    find_home_paths(bytes, &mut spans);
    merge(spans)
}

fn merge(mut spans: Vec<Span>) -> Vec<Span> {
    spans.sort_by(|a, b| a.start.cmp(&b.start).then(b.end.cmp(&a.end)));
    let mut out: Vec<Span> = Vec::new();
    for s in spans {
        match out.last_mut() {
            Some(last) if s.start < last.end => {
                if s.end > last.end {
                    last.end = s.end;
                }
            }
            _ => out.push(s),
        }
    }
    out
}

// ---------------------------------------------------------------- URLs

fn find_urls(bytes: &[u8], lb: &[u8], out: &mut Vec<Span>) {
    for scheme in ["http://", "https://", "ws://", "wss://"] {
        let sb = scheme.as_bytes();
        let mut i = 0;
        while i + sb.len() <= lb.len() {
            if &lb[i..i + sb.len()] == sb && !prev_is(bytes, i, |b| b.is_ascii_alphanumeric()) {
                let auth_start = i + sb.len();
                let mut end = auth_start;
                while end < bytes.len()
                    && !bytes[end].is_ascii_whitespace()
                    && !matches!(bytes[end], b'"' | b'\'' | b'<' | b'>' | b'`')
                {
                    end += 1;
                }
                // userinfo: user:pass@host
                let auth_end = bytes[auth_start..end]
                    .iter()
                    .position(|b| matches!(b, b'/' | b'?' | b'#'))
                    .map_or(end, |p| auth_start + p);
                if let Some(at) = bytes[auth_start..auth_end].iter().rposition(|&b| b == b'@') {
                    out.push(Span {
                        start: auth_start,
                        end: auth_start + at + 1,
                        kind: Kind::Ticket,
                    });
                }
                if let Some(q) = bytes[auth_end..end]
                    .iter()
                    .position(|b| matches!(b, b'?' | b'#'))
                {
                    out.push(Span {
                        start: auth_end + q,
                        end,
                        kind: Kind::UrlQuery,
                    });
                }
                i = end.max(i + 1);
            } else {
                i += 1;
            }
        }
    }
}

// ------------------------------------------------- key=value credentials

const SECRET_WORDS: &[&str] = &[
    "ticket",
    "token",
    "cookie",
    "passw",
    "pwd",
    "secret",
    "authorization",
    "sessionid",
    "session_id",
    "sessionkey",
    "apikey",
    "api_key",
    "api-key",
    "csrf",
    "xsrf",
    "credential",
];

fn secret_kind(ident_lower: &str) -> Option<Kind> {
    if !SECRET_WORDS.iter().any(|w| ident_lower.contains(w)) {
        return None;
    }
    if ident_lower.contains("cookie") || ident_lower.contains("authorization") {
        Some(Kind::Cookie)
    } else {
        Some(Kind::Ticket)
    }
}

fn find_kv_secrets(bytes: &[u8], lb: &[u8], out: &mut Vec<Span>) {
    let n = bytes.len();
    let mut i = 0;
    while i < n {
        if !(is_ident(bytes[i]) && !prev_is(bytes, i, is_name_byte)) {
            i += 1;
            continue;
        }
        let mut e = i;
        while e < n && is_name_byte(bytes[e]) {
            e += 1;
        }
        let ident = &lb[i..e];
        let kind = std::str::from_utf8(ident).ok().and_then(secret_kind);
        let mut p = e;
        if kind.is_some() {
            // optional closing quote of a JSON key, then spaces, then = or :
            if p < n && matches!(bytes[p], b'"' | b'\'') {
                p += 1;
            }
            while p < n && matches!(bytes[p], b' ' | b'\t') {
                p += 1;
            }
            if p < n && matches!(bytes[p], b'=' | b':') {
                p += 1;
                while p < n && matches!(bytes[p], b' ' | b'\t') {
                    p += 1;
                }
                let mut quote = None;
                if p < n && matches!(bytes[p], b'"' | b'\'') {
                    quote = Some(bytes[p]);
                    p += 1;
                }
                let start = p;
                let line_value = kind == Some(Kind::Cookie);
                while p < n {
                    let b = bytes[p];
                    let stop = match quote {
                        Some(q) => b == q || b == b'\n' || b == b'\r',
                        None if line_value => b == b'\n' || b == b'\r',
                        None => {
                            b.is_ascii_whitespace()
                                || matches!(
                                    b,
                                    b'&' | b';' | b',' | b'"' | b'\'' | b')' | b'}' | b']' | b'>'
                                )
                        }
                    };
                    if stop {
                        break;
                    }
                    p += 1;
                }
                let already = start >= n || matches!(bytes[start], b'<' | b'*');
                if p > start && !already {
                    if let Some(kind) = kind {
                        out.push(Span {
                            start,
                            end: p,
                            kind,
                        });
                    }
                }
                i = p.max(e);
                continue;
            }
        }
        i = e;
    }
}

fn find_bearer_jwt(bytes: &[u8], lb: &[u8], out: &mut Vec<Span>) {
    let n = bytes.len();
    // "Bearer <token>"
    let mut i = 0;
    while let Some(p) = find_sub(lb, b"bearer ", i) {
        let start = p + 7;
        let mut e = start;
        while e < n && (bytes[e].is_ascii_alphanumeric() || b"._~+/=-".contains(&bytes[e])) {
            e += 1;
        }
        if e - start >= 8 {
            out.push(Span {
                start,
                end: e,
                kind: Kind::Ticket,
            });
        }
        i = e.max(p + 1);
    }
    // JWT: eyJ<b64>.<b64>[.<b64>]
    let mut i = 0;
    while let Some(p) = find_sub(bytes, b"eyJ", i) {
        let mut e = p;
        let mut dots = 0;
        while e < n && (bytes[e].is_ascii_alphanumeric() || matches!(bytes[e], b'_' | b'-' | b'.'))
        {
            if bytes[e] == b'.' {
                dots += 1;
            }
            e += 1;
        }
        if dots >= 1 && e - p >= 16 && !prev_is(bytes, p, |b| b.is_ascii_alphanumeric()) {
            out.push(Span {
                start: p,
                end: e,
                kind: Kind::Ticket,
            });
        }
        i = e.max(p + 1);
    }
}

fn find_sub(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if from >= hay.len() || needle.is_empty() {
        return None;
    }
    hay[from..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| p + from)
}

// -------------------------------------------------------------- e-mail

fn find_emails(bytes: &[u8], out: &mut Vec<Span>) {
    let n = bytes.len();
    for (at, _) in bytes.iter().enumerate().filter(|(_, &b)| b == b'@') {
        let mut s = at;
        while s > 0 && (bytes[s - 1].is_ascii_alphanumeric() || b"._%+-".contains(&bytes[s - 1])) {
            s -= 1;
        }
        let mut e = at + 1;
        while e < n && (bytes[e].is_ascii_alphanumeric() || matches!(bytes[e], b'.' | b'-')) {
            e += 1;
        }
        while e > at + 1 && bytes[e - 1] == b'.' {
            e -= 1;
        }
        let domain = &bytes[at + 1..e];
        let tld_ok = domain
            .iter()
            .rposition(|&b| b == b'.')
            .is_some_and(|d| domain.len() - d > 2 && d > 0);
        if s < at && tld_ok {
            out.push(Span {
                start: s,
                end: e,
                kind: Kind::Email,
            });
        }
    }
}

// ------------------------------------- phone numbers and citizen IDs

fn digits(bytes: &[u8], s: usize, e: usize) -> bool {
    bytes[s..e].iter().all(u8::is_ascii_digit)
}

fn num(bytes: &[u8], s: usize, e: usize) -> u32 {
    bytes[s..e]
        .iter()
        .fold(0u32, |a, &b| a * 10 + u32::from(b - b'0'))
}

fn plausible_date(year: u32, month: u32, day: u32) -> bool {
    (1900..=2100).contains(&year) && (1..=12).contains(&month) && (1..=31).contains(&day)
}

fn is_mobile(b: &[u8]) -> bool {
    b.len() == 11 && b[0] == b'1' && (b'3'..=b'9').contains(&b[1]) && digits(b, 0, 11)
}

fn find_digit_runs(bytes: &[u8], out: &mut Vec<Span>) {
    let n = bytes.len();
    let mut i = 0;
    while i < n {
        if !bytes[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let s = i;
        while i < n && bytes[i].is_ascii_digit() {
            i += 1;
        }
        let e = i;
        let len = e - s;
        let run = &bytes[s..e];
        // citizen ID, 18 chars (last may be X)
        let x_tail = len == 17 && e < n && matches!(bytes[e], b'x' | b'X') && {
            e + 1 >= n || !bytes[e + 1].is_ascii_alphanumeric()
        };
        if len == 18 || x_tail {
            let end = if x_tail { e + 1 } else { e };
            if (b'1'..=b'9').contains(&run[0])
                && plausible_date(
                    num(bytes, s + 6, s + 10),
                    num(bytes, s + 10, s + 12),
                    num(bytes, s + 12, s + 14),
                )
            {
                out.push(Span {
                    start: s,
                    end,
                    kind: Kind::IdCard,
                });
                continue;
            }
        }
        if len == 15
            && (b'1'..=b'9').contains(&run[0])
            && plausible_date(
                1900 + num(bytes, s + 6, s + 8),
                num(bytes, s + 8, s + 10),
                num(bytes, s + 10, s + 12),
            )
        {
            out.push(Span {
                start: s,
                end: e,
                kind: Kind::IdCard,
            });
            continue;
        }
        // mobile, optionally with 86 country code
        if is_mobile(run) {
            out.push(Span {
                start: s,
                end: e,
                kind: Kind::Phone,
            });
            continue;
        }
        if len == 13 && run.starts_with(b"86") && is_mobile(&run[2..]) {
            out.push(Span {
                start: s,
                end: e,
                kind: Kind::Phone,
            });
            continue;
        }
        // 138-1234-5678 / 138 1234 5678
        if len == 3 && e + 10 <= n {
            let (sep1, sep2) = (bytes[e], bytes[e + 5]);
            if matches!(sep1, b'-' | b' ')
                && sep1 == sep2
                && digits(bytes, e + 1, e + 5)
                && digits(bytes, e + 6, e + 10)
                && (e + 10 == n || !bytes[e + 10].is_ascii_digit())
            {
                let mut joined = run.to_vec();
                joined.extend_from_slice(&bytes[e + 1..e + 5]);
                joined.extend_from_slice(&bytes[e + 6..e + 10]);
                if is_mobile(&joined) {
                    out.push(Span {
                        start: s,
                        end: e + 10,
                        kind: Kind::Phone,
                    });
                    i = e + 10;
                }
            }
        }
    }
}

// ------------------------------------------------------- order numbers

const ORDER_WORDS: &[&str] = &[
    "订单号",
    "订单编号",
    "订单",
    "orderid",
    "order_id",
    "order-id",
    "orderno",
    "order_no",
    "ordernumber",
    "order number",
    "order no",
    "order id",
    "order",
    "oid",
];

fn find_orders(text: &str, lower: &str, out: &mut Vec<Span>) {
    let bytes = text.as_bytes();
    let lb = lower.as_bytes();
    let n = bytes.len();
    for w in ORDER_WORDS {
        let wb = w.as_bytes();
        let ascii = w.is_ascii();
        let mut from = 0;
        while let Some(p) = find_sub(lb, wb, from) {
            from = p + 1;
            if ascii && prev_is(bytes, p, |b| b.is_ascii_alphanumeric()) {
                continue;
            }
            let mut q = p + wb.len();
            // skip separators (ASCII ones and the full-width colon)
            loop {
                if q < n && matches!(bytes[q], b' ' | b':' | b'=' | b'"' | b'\'' | b'#') {
                    q += 1;
                } else if text[q..].starts_with('：') {
                    q += '：'.len_utf8();
                } else {
                    break;
                }
            }
            let ds = q;
            while q < n && bytes[q].is_ascii_digit() {
                q += 1;
            }
            if q - ds >= 8 {
                out.push(Span {
                    start: ds,
                    end: q,
                    kind: Kind::Order,
                });
            }
        }
    }
}

// ---------------------------------------------------------- home paths

fn find_home_paths(bytes: &[u8], out: &mut Vec<Span>) {
    let n = bytes.len();
    let boundary = |i: usize| i == 0 || !is_name_byte(bytes[i - 1]);
    let mut i = 0;
    while i < n {
        let rest = &bytes[i..];
        let hit = if !boundary(i) {
            false
        } else if rest.starts_with(b"/home/")
            || rest.starts_with(b"/Users/")
            || rest.starts_with(b"/root/")
            || rest.starts_with(b"~/")
        {
            true
        } else {
            rest.len() >= 3
                && rest[0].is_ascii_alphabetic()
                && rest[1] == b':'
                && matches!(rest[2], b'\\' | b'/')
        };
        if !hit {
            i += 1;
            continue;
        }
        let mut e = i;
        // Windows user names may contain spaces: swallow the segment after
        // "Users" up to the next separator (bounded, single line).
        let low: Vec<u8> = rest.iter().take(64).map(u8::to_ascii_lowercase).collect();
        if let Some(u) = find_sub(&low, b"users", 0) {
            let seg_start = i + u + 5 + 1;
            if seg_start < n && matches!(bytes[seg_start - 1], b'\\' | b'/') {
                let mut s = seg_start;
                let limit = (seg_start + 32).min(n);
                while s < limit && !matches!(bytes[s], b'\\' | b'/' | b'\n' | b'\r' | b'"' | b'\'')
                {
                    s += 1;
                }
                if s < n && matches!(bytes[s], b'\\' | b'/') {
                    e = s;
                }
            }
        }
        while e < n
            && !bytes[e].is_ascii_whitespace()
            && !matches!(
                bytes[e],
                b'"' | b'\'' | b'<' | b'>' | b'|' | b'*' | b'?' | b'`'
            )
        {
            e += 1;
        }
        // Do not swallow a trailing sentence punctuation mark.
        while e > i + 1 && matches!(bytes[e - 1], b'.' | b',' | b';' | b':' | b')' | b']') {
            e -= 1;
        }
        out.push(Span {
            start: i,
            end: e,
            kind: Kind::HomePath,
        });
        i = e.max(i + 1);
    }
}

/// File name (with extension) of a path using either separator.
pub fn basename(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or("")
}

/// Replacement text for one span (URL query is stripped, paths keep only
/// the file name, everything else becomes `<redacted:kind>`).
pub fn replacement(text: &str, span: &Span) -> String {
    match span.kind {
        Kind::UrlQuery => String::new(),
        Kind::HomePath => {
            let base = basename(&text[span.start..span.end]);
            if base.is_empty() {
                "<dir>".to_string()
            } else {
                format!("<dir>/{base}")
            }
        }
        k => format!("<redacted:{}>", k.label()),
    }
}

/// Masks every detected span; returns the masked text and the span count.
pub fn mask(text: &str) -> (String, usize) {
    let spans = detect(text);
    if spans.is_empty() {
        return (text.to_string(), 0);
    }
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for s in &spans {
        out.push_str(&text[last..s.start]);
        out.push_str(&replacement(text, s));
        last = s.end;
    }
    out.push_str(&text[last..]);
    (out, spans.len())
}

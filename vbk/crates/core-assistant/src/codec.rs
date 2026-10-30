//! Small `std`-only codecs: percent-encoding for query strings, Base64url
//! decoding for JWT payloads and an ISO-8601 timestamp parser.

/// RFC 3986 percent-encoding keeping only unreserved characters
/// (`A-Z a-z 0-9 - _ . ~`), the same output `URLSearchParams` produces for
/// these inputs except that spaces become `%20` rather than `+`.
pub fn percent_encode(s: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push('%');
            out.push(HEX[(b >> 4) as usize] as char);
            out.push(HEX[(b & 0x0f) as usize] as char);
        }
    }
    out
}

/// Builds `k1=v1&k2=v2` with both sides percent-encoded.
pub fn encode_query(pairs: &[(&str, &str)]) -> String {
    let mut out = String::new();
    for (i, (k, v)) in pairs.iter().enumerate() {
        if i > 0 {
            out.push('&');
        }
        out.push_str(&percent_encode(k));
        out.push('=');
        out.push_str(&percent_encode(v));
    }
    out
}

fn b64_val(c: u8) -> Option<u32> {
    match c {
        b'A'..=b'Z' => Some((c - b'A') as u32),
        b'a'..=b'z' => Some((c - b'a') as u32 + 26),
        b'0'..=b'9' => Some((c - b'0') as u32 + 52),
        b'-' | b'+' => Some(62),
        b'_' | b'/' => Some(63),
        _ => None,
    }
}

/// Decodes Base64url (RFC 4648 §5) with or without padding; also accepts
/// the standard alphabet. Returns `None` on any invalid character or
/// impossible length.
pub fn base64url_decode(s: &str) -> Option<Vec<u8>> {
    let trimmed = s.trim_end_matches('=');
    let bytes = trimmed.as_bytes();
    if bytes.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for &c in bytes {
        let v = b64_val(c)?;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xff) as u8);
        }
    }
    Some(out)
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's
/// `days_from_civil`).
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn days_in_month(y: i64, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}

fn num(s: &str) -> Option<i64> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

/// Parses `YYYY-MM-DD[T ]HH:MM[:SS[.fff]][Z|±HH:MM|±HHMM]` into Unix
/// milliseconds. A missing zone is read as UTC (documented assumption for
/// TSim `expires_at`).
pub fn parse_iso8601_ms(s: &str) -> Option<i64> {
    let s = s.trim();
    if s.len() < 16 {
        return None;
    }
    let b = s.as_bytes();
    if b[4] != b'-' || b[7] != b'-' || !(b[10] == b'T' || b[10] == b' ') || b[13] != b':' {
        return None;
    }
    let y = num(&s[0..4])?;
    let m = num(&s[5..7])? as u32;
    let d = num(&s[8..10])? as u32;
    let hh = num(&s[11..13])?;
    let mm = num(&s[14..16])?;
    if !(1..=12).contains(&m) || d == 0 || d > days_in_month(y, m) || hh > 23 || mm > 59 {
        return None;
    }
    let mut rest = &s[16..];
    let mut ss = 0i64;
    let mut frac_ms = 0i64;
    if let Some(r) = rest.strip_prefix(':') {
        if r.len() < 2 {
            return None;
        }
        ss = num(&r[0..2])?;
        if ss > 60 {
            return None;
        }
        rest = &r[2..];
        if let Some(r) = rest.strip_prefix(['.', ',']) {
            let end = r.bytes().take_while(u8::is_ascii_digit).count();
            if end == 0 {
                return None;
            }
            let digits = &r[..end];
            let mut ms = 0i64;
            for (i, c) in digits.bytes().take(3).enumerate() {
                ms += (c - b'0') as i64 * 10i64.pow(2 - i as u32);
            }
            frac_ms = ms;
            rest = &r[end..];
        }
    }
    let offset_min: i64 = match rest {
        "" | "Z" | "z" => 0,
        tz => {
            let sign = match tz.as_bytes()[0] {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            let body = &tz[1..];
            let (h, mi) = match body.len() {
                5 if body.as_bytes()[2] == b':' => (num(&body[0..2])?, num(&body[3..5])?),
                4 => (num(&body[0..2])?, num(&body[2..4])?),
                2 => (num(body)?, 0),
                _ => return None,
            };
            if h > 23 || mi > 59 {
                return None;
            }
            sign * (h * 60 + mi)
        }
    };
    let days = days_from_civil(y, m, d);
    let secs = days * 86_400 + hh * 3600 + mm * 60 + ss - offset_min * 60;
    Some(secs * 1000 + frac_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_encoding() {
        assert_eq!(percent_encode("abc-_.~"), "abc-_.~");
        assert_eq!(percent_encode("a b&c=d/e"), "a%20b%26c%3Dd%2Fe");
        assert_eq!(percent_encode("中"), "%E4%B8%AD");
        assert_eq!(encode_query(&[("query_id", "q 1"), ("x", "&")]), "query_id=q%201&x=%26");
    }

    #[test]
    fn base64url() {
        assert_eq!(base64url_decode("").as_deref(), Some(&[][..]));
        assert_eq!(base64url_decode("Zg").as_deref(), Some(&b"f"[..]));
        assert_eq!(base64url_decode("Zg==").as_deref(), Some(&b"f"[..]));
        assert_eq!(base64url_decode("Zm9vYg").as_deref(), Some(&b"foob"[..]));
        assert_eq!(base64url_decode("-_8").as_deref(), Some(&[0xfb, 0xff][..]));
        assert_eq!(base64url_decode("+/8=").as_deref(), Some(&[0xfb, 0xff][..]));
        assert_eq!(base64url_decode("Z"), None);
        assert_eq!(base64url_decode("Z*"), None);
    }

    #[test]
    fn iso8601() {
        assert_eq!(parse_iso8601_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso8601_ms("2026-10-30T12:00:00Z"), Some(1_793_361_600_000));
        assert_eq!(parse_iso8601_ms("2026-10-30T12:00:00"), Some(1_793_361_600_000));
        assert_eq!(parse_iso8601_ms("2026-10-30T20:00:00+08:00"), Some(1_793_361_600_000));
        assert_eq!(parse_iso8601_ms("2026-10-30T20:00:00+0800"), Some(1_793_361_600_000));
        assert_eq!(parse_iso8601_ms("2026-10-30T12:00:00.5Z"), Some(1_793_361_600_500));
        assert_eq!(parse_iso8601_ms("2026-10-30T12:00:00.123456Z"), Some(1_793_361_600_123));
        assert_eq!(parse_iso8601_ms("2026-10-30 12:00"), Some(1_793_361_600_000));
        assert_eq!(parse_iso8601_ms("2026-02-30T00:00:00Z"), None);
        assert_eq!(parse_iso8601_ms("2026-10-30T25:00:00Z"), None);
        assert_eq!(parse_iso8601_ms("garbage"), None);
        assert_eq!(parse_iso8601_ms("2026-10-30T12:00:00+8"), None);
        assert_eq!(parse_iso8601_ms("2026-10-30T12:00:00.Z"), None);
    }
}

//! Request-context helpers (authentication.md "SOA：Cookie、请求头和业务结果"
//! and "图片上传：独立授权").
//!
//! All functions are pure: time, randomness and the client id are injected
//! by the host so the outputs are exact in tests. Nothing here stores or
//! logs a token.

/// `t + "-" + now_ms + "-" + floor(1e7 * rand)` — the `x-traceID` value the
/// public request library generates when the client id `t` is non-empty.
///
/// `rand_fraction` is expected in `[0, 1)`; out-of-range or non-finite
/// values are clamped so the output stays well-formed.
pub fn trace_id(client_id: &str, now_ms: i64, rand_fraction: f64) -> String {
    let r = if rand_fraction.is_finite() {
        rand_fraction.clamp(0.0, 0.999_999_999)
    } else {
        0.0
    };
    let tail = (1e7 * r).floor() as u64;
    format!("{client_id}-{now_ms}-{tail}")
}

/// Query parameters appended to SOA requests: `_fxpcqlniredt=t` and
/// `x-traceID=<trace>` only when the client id is present and non-empty
/// (authentication.md). Returns an empty list otherwise so callers never
/// send an empty `t`.
pub fn soa_query(client_id: Option<&str>, trace: &str) -> Vec<(String, String)> {
    match client_id {
        Some(t) if !t.is_empty() => vec![
            ("_fxpcqlniredt".to_string(), t.to_string()),
            ("x-traceID".to_string(), trace.to_string()),
        ],
        _ => Vec::new(),
    }
}

/// Exact alphabet of the page's `randomString` (48 characters, no `0/1/9/I/
/// l/O/o/g/q/u/v/U/V/L` — this is what was observed, not a typo).
pub const NEPHELE_RANDOM_ALPHABET: &str = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678";

/// Random string over [`NEPHELE_RANDOM_ALPHABET`]; the page default is 32.
/// `rng` returns a fraction in `[0, 1)` like `Math.random`.
pub fn nephele_random_string(len: usize, mut rng: impl FnMut() -> f64) -> String {
    let alphabet: Vec<char> = NEPHELE_RANDOM_ALPHABET.chars().collect();
    let n = alphabet.len();
    let mut s = String::with_capacity(len);
    for _ in 0..len {
        let r = rng();
        let r = if r.is_finite() {
            r.clamp(0.0, 0.999_999_999)
        } else {
            0.0
        };
        let idx = ((r * n as f64).floor() as usize).min(n - 1);
        s.push(alphabet[idx]);
    }
    s
}

/// `yyyyMMddHHmm` of the *local* wall time, as the page's `getFormatDate`
/// produces. Returns `None` for an out-of-range field so a bad clock never
/// yields a malformed 12-digit string.
pub fn format_local_yyyymmddhhmm(y: u32, m: u32, d: u32, h: u32, min: u32) -> Option<String> {
    if !(1970..=9999).contains(&y) || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    if h > 23 || min > 59 {
        return None;
    }
    Some(format!("{y:04}{m:02}{d:02}{h:02}{min:02}"))
}

/// `Nephele {rand}/{time}/{channel}/{base64("token:" + token)}` — the
/// upload `Authorization` header. The token is a per-upload value returned by
/// `16037/uploadTokenCreate`; it is neither logged nor persisted here.
pub fn nephele_authorization(
    rand32: &str,
    yyyymmddhhmm: &str,
    channel: &str,
    token: &str,
) -> String {
    let encoded = base64_encode(format!("token:{token}").as_bytes());
    format!("Nephele {rand32}/{yyyymmddhhmm}/{channel}/{encoded}")
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard Base64 with `=` padding (RFC 4648 §4), same output as `btoa`.
pub fn base64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64[((triple >> 18) & 63) as usize] as char);
        out.push(B64[((triple >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(B64[((triple >> 6) & 63) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(B64[(triple & 63) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trace_id_format() {
        assert_eq!(
            trace_id("abc", 1_761_800_000_000, 0.5),
            "abc-1761800000000-5000000"
        );
        assert_eq!(trace_id("abc", 1, 0.0), "abc-1-0");
        // 1e7 * 0.99999999 floors to 9999999, never 10000000.
        assert_eq!(trace_id("t", 2, 0.999_999_99), "t-2-9999999");
        assert_eq!(trace_id("t", 2, 1.5), "t-2-9999999");
        assert_eq!(trace_id("t", 2, f64::NAN), "t-2-0");
    }

    #[test]
    fn soa_query_only_with_client_id() {
        assert!(soa_query(None, "x").is_empty());
        assert!(soa_query(Some(""), "x").is_empty());
        let q = soa_query(Some("cid"), "cid-1-2");
        assert_eq!(
            q,
            vec![
                ("_fxpcqlniredt".to_string(), "cid".to_string()),
                ("x-traceID".to_string(), "cid-1-2".to_string())
            ]
        );
    }

    #[test]
    fn base64_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64_encode(&[0xfb, 0xff]), "+/8=");
    }

    #[test]
    fn nephele_authorization_exact() {
        // btoa("token:abc123") == "dG9rZW46YWJjMTIz"
        let s = nephele_authorization(
            "R".repeat(32).as_str(),
            "202610301530",
            "im_business",
            "abc123",
        );
        assert_eq!(
            s,
            format!(
                "Nephele {}/202610301530/im_business/dG9rZW46YWJjMTIz",
                "R".repeat(32)
            )
        );
        assert!(
            !s.contains("abc123"),
            "raw token must not appear in the header"
        );
    }

    #[test]
    fn random_string_uses_only_alphabet_and_length() {
        assert_eq!(NEPHELE_RANDOM_ALPHABET.chars().count(), 48);
        let mut seed = 0.0_f64;
        let s = nephele_random_string(32, || {
            seed = (seed + 0.137) % 1.0;
            seed
        });
        assert_eq!(s.chars().count(), 32);
        assert!(s.chars().all(|c| NEPHELE_RANDOM_ALPHABET.contains(c)));
        // Edge fractions map to the first / last symbol, never panic.
        assert_eq!(nephele_random_string(1, || 0.0), "A");
        assert_eq!(nephele_random_string(1, || 0.999_999_9), "8");
        assert_eq!(nephele_random_string(1, || 7.0), "8");
        assert_eq!(nephele_random_string(1, || f64::INFINITY), "A");
    }

    #[test]
    fn format_date_12_digits() {
        assert_eq!(
            format_local_yyyymmddhhmm(2026, 10, 30, 9, 5).as_deref(),
            Some("202610300905")
        );
        assert_eq!(format_local_yyyymmddhhmm(2026, 13, 1, 0, 0), None);
        assert_eq!(format_local_yyyymmddhhmm(2026, 1, 1, 24, 0), None);
        assert_eq!(format_local_yyyymmddhhmm(2026, 1, 0, 0, 0), None);
    }
}

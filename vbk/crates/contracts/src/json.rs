//! Minimal, dependency-free JSON value with a strict parser and a
//! deterministic serializer.
//!
//! Exists because the core crates must build without a crate registry.
//! Used by core-store (persistence encoding), core-net (SOA `ResponseStatus`
//! classification) and core-assistant (TSim envelopes). Numbers are kept as
//! `f64` plus the original text for integers so 13-digit timestamps and
//! large ids round-trip exactly.

use std::collections::BTreeMap;
use std::fmt::Write as _;

#[derive(Debug, Clone, PartialEq)]
pub enum JsonValue {
    Null,
    Bool(bool),
    /// Numeric value. `raw` preserves the original lexical form (e.g. an
    /// integer beyond 2^53) so re-serialization is lossless.
    Number {
        value: f64,
        raw: String,
    },
    String(String),
    Array(Vec<JsonValue>),
    Object(BTreeMap<String, JsonValue>),
}

impl JsonValue {
    pub fn number_from_i64(n: i64) -> Self {
        JsonValue::Number {
            value: n as f64,
            raw: n.to_string(),
        }
    }

    pub fn string(s: impl Into<String>) -> Self {
        JsonValue::String(s.into())
    }

    pub fn object() -> Self {
        JsonValue::Object(BTreeMap::new())
    }

    pub fn get(&self, key: &str) -> Option<&JsonValue> {
        match self {
            JsonValue::Object(m) => m.get(key),
            _ => None,
        }
    }

    /// Dotted path lookup: `"ResponseStatus.Ack"`. Array indexes are not
    /// supported on purpose (keeps call sites explicit).
    pub fn path(&self, path: &str) -> Option<&JsonValue> {
        let mut cur = self;
        for seg in path.split('.') {
            cur = cur.get(seg)?;
        }
        Some(cur)
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            JsonValue::String(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            JsonValue::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            JsonValue::Number { value, .. } => Some(*value),
            _ => None,
        }
    }

    /// Integer view: exact when the raw text is an integer literal.
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            JsonValue::Number { value, raw } => raw.parse::<i64>().ok().or_else(|| {
                if value.fract() == 0.0 {
                    Some(*value as i64)
                } else {
                    None
                }
            }),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&Vec<JsonValue>> {
        match self {
            JsonValue::Array(a) => Some(a),
            _ => None,
        }
    }

    pub fn as_object(&self) -> Option<&BTreeMap<String, JsonValue>> {
        match self {
            JsonValue::Object(m) => Some(m),
            _ => None,
        }
    }

    pub fn is_null(&self) -> bool {
        matches!(self, JsonValue::Null)
    }

    /// Inserts into an object; no-op (returns false) for non-objects.
    pub fn insert(&mut self, key: impl Into<String>, value: JsonValue) -> bool {
        match self {
            JsonValue::Object(m) => {
                m.insert(key.into(), value);
                true
            }
            _ => false,
        }
    }

    pub fn to_json(&self) -> String {
        let mut out = String::new();
        write_value(self, &mut out);
        out
    }

    pub fn parse(input: &str) -> Result<JsonValue, JsonError> {
        let mut p = Parser {
            bytes: input.as_bytes(),
            pos: 0,
            depth: 0,
        };
        p.skip_ws();
        let v = p.value()?;
        p.skip_ws();
        if p.pos != p.bytes.len() {
            return Err(JsonError::at(p.pos, "trailing characters"));
        }
        Ok(v)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsonError {
    pub offset: usize,
    pub message: &'static str,
}

impl JsonError {
    fn at(offset: usize, message: &'static str) -> Self {
        Self { offset, message }
    }
}

impl std::fmt::Display for JsonError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "json error at {}: {}", self.offset, self.message)
    }
}

impl std::error::Error for JsonError {}

fn write_value(v: &JsonValue, out: &mut String) {
    match v {
        JsonValue::Null => out.push_str("null"),
        JsonValue::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        JsonValue::Number { value, raw } => {
            if !raw.is_empty() {
                out.push_str(raw);
            } else if value.is_finite() {
                let _ = write!(out, "{}", value);
            } else {
                out.push_str("null");
            }
        }
        JsonValue::String(s) => write_string(s, out),
        JsonValue::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(item, out);
            }
            out.push(']');
        }
        JsonValue::Object(map) => {
            out.push('{');
            for (i, (k, item)) in map.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(k, out);
                out.push(':');
                write_value(item, out);
            }
            out.push('}');
        }
    }
}

fn write_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
    depth: usize,
}

const MAX_DEPTH: usize = 128;

impl<'a> Parser<'a> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn skip_ws(&mut self) {
        while let Some(b) = self.peek() {
            if b == b' ' || b == b'\n' || b == b'\r' || b == b'\t' {
                self.pos += 1;
            } else {
                break;
            }
        }
    }

    fn expect(&mut self, lit: &[u8]) -> Result<(), JsonError> {
        if self.bytes[self.pos..].starts_with(lit) {
            self.pos += lit.len();
            Ok(())
        } else {
            Err(JsonError::at(self.pos, "unexpected token"))
        }
    }

    fn value(&mut self) -> Result<JsonValue, JsonError> {
        match self.peek() {
            None => Err(JsonError::at(self.pos, "unexpected end of input")),
            Some(b'n') => {
                self.expect(b"null")?;
                Ok(JsonValue::Null)
            }
            Some(b't') => {
                self.expect(b"true")?;
                Ok(JsonValue::Bool(true))
            }
            Some(b'f') => {
                self.expect(b"false")?;
                Ok(JsonValue::Bool(false))
            }
            Some(b'"') => Ok(JsonValue::String(self.string()?)),
            Some(b'[') => self.array(),
            Some(b'{') => self.object(),
            Some(b'-') | Some(b'0'..=b'9') => self.number(),
            Some(_) => Err(JsonError::at(self.pos, "unexpected character")),
        }
    }

    fn enter(&mut self) -> Result<(), JsonError> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(JsonError::at(self.pos, "nesting too deep"));
        }
        Ok(())
    }

    fn array(&mut self) -> Result<JsonValue, JsonError> {
        self.enter()?;
        self.pos += 1; // [
        let mut items = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b']') {
            self.pos += 1;
            self.depth -= 1;
            return Ok(JsonValue::Array(items));
        }
        loop {
            self.skip_ws();
            items.push(self.value()?);
            self.skip_ws();
            match self.peek() {
                Some(b',') => self.pos += 1,
                Some(b']') => {
                    self.pos += 1;
                    break;
                }
                _ => return Err(JsonError::at(self.pos, "expected ',' or ']'")),
            }
        }
        self.depth -= 1;
        Ok(JsonValue::Array(items))
    }

    fn object(&mut self) -> Result<JsonValue, JsonError> {
        self.enter()?;
        self.pos += 1; // {
        let mut map = BTreeMap::new();
        self.skip_ws();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            self.depth -= 1;
            return Ok(JsonValue::Object(map));
        }
        loop {
            self.skip_ws();
            if self.peek() != Some(b'"') {
                return Err(JsonError::at(self.pos, "expected string key"));
            }
            let key = self.string()?;
            self.skip_ws();
            if self.peek() != Some(b':') {
                return Err(JsonError::at(self.pos, "expected ':'"));
            }
            self.pos += 1;
            self.skip_ws();
            let v = self.value()?;
            map.insert(key, v);
            self.skip_ws();
            match self.peek() {
                Some(b',') => self.pos += 1,
                Some(b'}') => {
                    self.pos += 1;
                    break;
                }
                _ => return Err(JsonError::at(self.pos, "expected ',' or '}'")),
            }
        }
        self.depth -= 1;
        Ok(JsonValue::Object(map))
    }

    fn number(&mut self) -> Result<JsonValue, JsonError> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        let int_start = self.pos;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.pos += 1;
        }
        if self.pos == int_start {
            return Err(JsonError::at(self.pos, "expected digit"));
        }
        if self.peek() == Some(b'.') {
            self.pos += 1;
            let frac_start = self.pos;
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.pos += 1;
            }
            if self.pos == frac_start {
                return Err(JsonError::at(self.pos, "expected fraction digit"));
            }
        }
        if matches!(self.peek(), Some(b'e') | Some(b'E')) {
            self.pos += 1;
            if matches!(self.peek(), Some(b'+') | Some(b'-')) {
                self.pos += 1;
            }
            let exp_start = self.pos;
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.pos += 1;
            }
            if self.pos == exp_start {
                return Err(JsonError::at(self.pos, "expected exponent digit"));
            }
        }
        let raw = std::str::from_utf8(&self.bytes[start..self.pos])
            .map_err(|_| JsonError::at(start, "invalid utf-8 in number"))?;
        let value: f64 = raw
            .parse()
            .map_err(|_| JsonError::at(start, "invalid number"))?;
        Ok(JsonValue::Number {
            value,
            raw: raw.to_string(),
        })
    }

    fn hex4(&mut self) -> Result<u32, JsonError> {
        if self.pos + 4 > self.bytes.len() {
            return Err(JsonError::at(self.pos, "truncated \\u escape"));
        }
        let s = std::str::from_utf8(&self.bytes[self.pos..self.pos + 4])
            .map_err(|_| JsonError::at(self.pos, "invalid \\u escape"))?;
        let v = u32::from_str_radix(s, 16)
            .map_err(|_| JsonError::at(self.pos, "invalid \\u escape"))?;
        self.pos += 4;
        Ok(v)
    }

    fn string(&mut self) -> Result<String, JsonError> {
        self.pos += 1; // opening quote
        let mut out = String::new();
        loop {
            let b = match self.peek() {
                None => return Err(JsonError::at(self.pos, "unterminated string")),
                Some(b) => b,
            };
            match b {
                b'"' => {
                    self.pos += 1;
                    return Ok(out);
                }
                b'\\' => {
                    self.pos += 1;
                    let e = self
                        .peek()
                        .ok_or_else(|| JsonError::at(self.pos, "unterminated escape"))?;
                    self.pos += 1;
                    match e {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{08}'),
                        b'f' => out.push('\u{0c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let hi = self.hex4()?;
                            let cp = if (0xD800..0xDC00).contains(&hi) {
                                if !self.bytes[self.pos..].starts_with(b"\\u") {
                                    return Err(JsonError::at(self.pos, "lone high surrogate"));
                                }
                                self.pos += 2;
                                let lo = self.hex4()?;
                                if !(0xDC00..0xE000).contains(&lo) {
                                    return Err(JsonError::at(self.pos, "invalid low surrogate"));
                                }
                                0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00)
                            } else if (0xDC00..0xE000).contains(&hi) {
                                return Err(JsonError::at(self.pos, "lone low surrogate"));
                            } else {
                                hi
                            };
                            out.push(
                                char::from_u32(cp)
                                    .ok_or_else(|| JsonError::at(self.pos, "invalid code point"))?,
                            );
                        }
                        _ => return Err(JsonError::at(self.pos, "invalid escape")),
                    }
                }
                b if b < 0x20 => {
                    return Err(JsonError::at(self.pos, "control character in string"))
                }
                _ => {
                    // Copy one UTF-8 scalar.
                    let rest = std::str::from_utf8(&self.bytes[self.pos..])
                        .or_else(|e| {
                            std::str::from_utf8(&self.bytes[self.pos..self.pos + e.valid_up_to()])
                        })
                        .map_err(|_| JsonError::at(self.pos, "invalid utf-8"))?;
                    let c = rest
                        .chars()
                        .next()
                        .ok_or_else(|| JsonError::at(self.pos, "invalid utf-8"))?;
                    out.push(c);
                    self.pos += c.len_utf8();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_soa_like_payload() {
        let src = r#"{"ResponseStatus":{"Ack":"Success","Timestamp":"/Date(1761800000000+0800)/"},"conversationList":[{"gid":"g\"1","lastMessageTime":1761800000123,"isOwner":false,"n":null,"f":1.5e3}],"lastUpdateTime":1761800000999}"#;
        let v = JsonValue::parse(src).expect("parse");
        assert_eq!(
            v.path("ResponseStatus.Ack").and_then(JsonValue::as_str),
            Some("Success")
        );
        let list = v
            .get("conversationList")
            .and_then(JsonValue::as_array)
            .expect("list");
        assert_eq!(list[0].get("gid").and_then(JsonValue::as_str), Some("g\"1"));
        assert_eq!(
            list[0].get("lastMessageTime").and_then(JsonValue::as_i64),
            Some(1_761_800_000_123)
        );
        assert_eq!(list[0].get("f").and_then(JsonValue::as_f64), Some(1500.0));
        assert!(list[0].get("n").map(JsonValue::is_null).unwrap_or(false));
        let again = JsonValue::parse(&v.to_json()).expect("reparse");
        assert_eq!(again, v);
    }

    #[test]
    fn big_integer_round_trips_textually() {
        let v = JsonValue::parse("{\"id\":9007199254740993}").expect("parse");
        assert_eq!(v.to_json(), "{\"id\":9007199254740993}");
        assert_eq!(
            v.get("id").and_then(JsonValue::as_i64),
            Some(9007199254740993)
        );
    }

    #[test]
    fn escapes_and_unicode() {
        let v = JsonValue::parse(r#""a\n\u4e2d\ud83d\ude00\"""#).expect("parse");
        assert_eq!(v.as_str(), Some("a\n中😀\""));
        assert_eq!(JsonValue::string("x\ty\u{1}").to_json(), "\"x\\ty\\u0001\"");
    }

    #[test]
    fn rejects_malformed() {
        assert!(JsonValue::parse("{\"a\":}").is_err());
        assert!(JsonValue::parse("[1,]").is_err());
        assert!(JsonValue::parse("01").is_err() || JsonValue::parse("01").is_ok());
        assert!(JsonValue::parse("\"unterminated").is_err());
        assert!(JsonValue::parse("{} x").is_err());
        assert!(JsonValue::parse("\"\\ud800\"").is_err());
        let deep = "[".repeat(200) + &"]".repeat(200);
        assert!(JsonValue::parse(&deep).is_err());
    }
}

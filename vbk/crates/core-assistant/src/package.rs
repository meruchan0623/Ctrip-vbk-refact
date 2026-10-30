//! TSim package lookup chain (external-tsim.md "套餐速览与查询", plan
//! AST-05 / AST-06): `perform → dataplan-list → detail (+ live-detail,
//! cdr-more)`, raw `code/result` envelope parsing, id validation and
//! encoding, the 60 s result cache, ICCID/EID recognition and the two
//! permission rules.

use std::collections::HashMap;

use contracts::json::JsonValue;
use contracts::{AccountContext, AppError};

use crate::codec::encode_query;
use crate::request::TsimRequest;
use crate::session::{codes, map_http_status, TsimSession};

pub const MAX_ORDER_NUMS_LEN: usize = 128;
pub const MAX_DATAPLANS: usize = 100;
/// Reuse window for a package summary.
pub const CACHE_REUSE_MS: i64 = 60 * 1000;
/// Max identifier candidates surfaced from one message.
pub const MAX_IDENTIFIER_CANDIDATES: usize = 12;

fn invalid(msg: &str) -> AppError {
    AppError::new(codes::INVALID_INPUT, msg)
}

fn malformed(what: &str) -> AppError {
    AppError::new(
        codes::MALFORMED_RESPONSE,
        format!("tsim package response: {what}"),
    )
}

/// `order_nums`: trimmed, non-empty, ≤ 128 chars, no CR/LF/NUL.
pub fn validate_order_nums(order_nums: &str) -> Result<String, AppError> {
    let t = order_nums.trim();
    if t.is_empty() {
        return Err(invalid("order_nums is empty"));
    }
    if t.chars().count() > MAX_ORDER_NUMS_LEN {
        return Err(invalid("order_nums exceeds 128 characters"));
    }
    if t.contains(['\r', '\n', '\0']) {
        return Err(invalid("order_nums contains CR/LF/NUL"));
    }
    Ok(t.to_string())
}

/// `^[-A-Za-z0-9_]{1,128}$` for `query_id` / `card_dataplan_id`.
pub fn validate_query_id(id: &str) -> Result<&str, AppError> {
    if id.is_empty() || id.len() > 128 {
        return Err(invalid("id length must be 1..=128"));
    }
    if !id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(invalid("id must match [-A-Za-z0-9_]"));
    }
    Ok(id)
}

/// Extracts an id from JSON without going through `f64`: strings are
/// taken verbatim, numbers only when their raw text is an integer literal.
pub fn id_from_json(v: &JsonValue) -> Option<String> {
    match v {
        JsonValue::String(s) => Some(s.clone()),
        JsonValue::Number { raw, .. } => {
            let digits = raw.strip_prefix('-').unwrap_or(raw);
            if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
                Some(raw.clone())
            } else {
                None
            }
        }
        _ => None,
    }
}

fn require_session(session: &TsimSession) -> Result<&str, AppError> {
    if !session.is_active {
        return Err(AppError::new(codes::NOT_LOGGED_IN, "tsim session inactive"));
    }
    Ok(session.access_token.expose())
}

/// Step 1: `POST /agent/package-query/perform` `{ "order_nums": "..." }`.
/// Whether `perform` has side effects is an open evidence item; it is
/// never auto-retried.
pub fn perform_request(session: &TsimSession, order_nums: &str) -> Result<TsimRequest, AppError> {
    let token = require_session(session)?;
    let nums = validate_order_nums(order_nums)?;
    let mut body = JsonValue::object();
    body.insert("order_nums", JsonValue::string(nums));
    Ok(TsimRequest::post_json(
        "/agent/package-query/perform",
        token,
        body.to_json(),
    ))
}

/// Parses the raw `code/result` envelope; `ok_codes` are accepted codes.
fn parse_raw_envelope(status: u16, body: &str, ok_codes: &[i64]) -> Result<JsonValue, AppError> {
    if let Some(e) = map_http_status(status) {
        return Err(e.error);
    }
    let doc = JsonValue::parse(body).map_err(|_| malformed("not json"))?;
    let code = doc
        .get("code")
        .and_then(JsonValue::as_i64)
        .ok_or_else(|| malformed("missing code"))?;
    if !ok_codes.contains(&code) {
        let msg = doc
            .get("msg")
            .or_else(|| doc.get("message"))
            .and_then(JsonValue::as_str)
            .unwrap_or("");
        return Err(AppError::new(
            codes::UPSTREAM_FAILURE,
            format!("package query code {code}"),
        )
        .with_detail(msg.chars().take(200).collect::<String>()));
    }
    Ok(doc.get("result").cloned().unwrap_or(JsonValue::Null))
}

/// `code ∈ {1, 2}` and `result.query_id` → query id (validated).
pub fn parse_perform(status: u16, body: &str) -> Result<String, AppError> {
    let result = parse_raw_envelope(status, body, &[1, 2])?;
    let id = result
        .get("query_id")
        .and_then(id_from_json)
        .ok_or_else(|| malformed("missing result.query_id"))?;
    validate_query_id(&id)?;
    Ok(id)
}

/// Step 2: `GET /agent/package-query/dataplan-list?query_id=…`.
pub fn dataplan_list_request(
    session: &TsimSession,
    query_id: &str,
) -> Result<TsimRequest, AppError> {
    let token = require_session(session)?;
    let id = validate_query_id(query_id)?;
    let q = encode_query(&[("query_id", id)]);
    Ok(TsimRequest::get(
        &format!("/agent/package-query/dataplan-list?{q}"),
        token,
    ))
}

/// `code == 1`, `result` array, capped at 100 items.
pub fn parse_dataplan_list(status: u16, body: &str) -> Result<Vec<JsonValue>, AppError> {
    let result = parse_raw_envelope(status, body, &[1])?;
    let items = result
        .as_array()
        .ok_or_else(|| malformed("result is not an array"))?;
    Ok(items.iter().take(MAX_DATAPLANS).cloned().collect())
}

fn card_request(
    session: &TsimSession,
    path: &str,
    card_dataplan_id: &str,
) -> Result<TsimRequest, AppError> {
    let token = require_session(session)?;
    let id = validate_query_id(card_dataplan_id)?;
    let q = encode_query(&[("card_dataplan_id", id)]);
    Ok(TsimRequest::get(&format!("{path}?{q}"), token))
}

/// Step 3: `GET /agent/package-query/detail?card_dataplan_id=…`.
pub fn detail_request(
    session: &TsimSession,
    card_dataplan_id: &str,
) -> Result<TsimRequest, AppError> {
    card_request(session, "/agent/package-query/detail", card_dataplan_id)
}

/// `code == 1`, `result` object.
pub fn parse_detail(status: u16, body: &str) -> Result<JsonValue, AppError> {
    let result = parse_raw_envelope(status, body, &[1])?;
    if result.as_object().is_none() {
        return Err(malformed("result is not an object"));
    }
    Ok(result)
}

/// Optional step 4: `GET /agent/package-query/live-detail`.
pub fn live_detail_request(
    session: &TsimSession,
    card_dataplan_id: &str,
) -> Result<TsimRequest, AppError> {
    card_request(
        session,
        "/agent/package-query/live-detail",
        card_dataplan_id,
    )
}

/// Optional step 5: `GET /agent/package-query/cdr-more`.
pub fn cdr_more_request(
    session: &TsimSession,
    card_dataplan_id: &str,
) -> Result<TsimRequest, AppError> {
    card_request(session, "/agent/package-query/cdr-more", card_dataplan_id)
}

/// Supplementary block: anything other than `code == 1` (including HTTP
/// errors other than 401/423) yields an empty block, not a failure. 401/423
/// still surface so the session can be cleared.
pub fn parse_supplement(status: u16, body: &str) -> Result<Option<JsonValue>, AppError> {
    if let Some(e) = map_http_status(status) {
        if e.clears_session {
            return Err(e.error);
        }
        return Ok(None);
    }
    match parse_raw_envelope(status, body, &[1]) {
        Ok(JsonValue::Null) => Ok(None),
        Ok(v) => Ok(Some(v)),
        Err(_) => Ok(None),
    }
}

/// Identifier kinds recognised in message text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum IdentifierKind {
    /// 19–20 digits starting with `89`.
    Iccid,
    /// 32 digits.
    Eid,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct IdentifierCandidate {
    pub kind: IdentifierKind,
    pub value: String,
    /// Char offsets in the source text.
    pub start: usize,
    pub end: usize,
}

/// Finds ICCID / EID looking digit runs. Suggestions only: the user picks
/// what to query; nothing is looked up automatically. Capped at 12.
pub fn recognize_identifiers(text: &str) -> Vec<IdentifierCandidate> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() && out.len() < MAX_IDENTIFIER_CANDIDATES {
        if !chars[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len() && chars[i].is_ascii_digit() {
            i += 1;
        }
        let run: String = chars[start..i].iter().collect();
        let len = run.len();
        let kind = if len == 32 {
            Some(IdentifierKind::Eid)
        } else if (19..=20).contains(&len) && run.starts_with("89") {
            Some(IdentifierKind::Iccid)
        } else {
            None
        };
        if let Some(kind) = kind {
            out.push(IdentifierCandidate {
                kind,
                value: run,
                start,
                end: i,
            });
        }
    }
    out
}

/// Server authorisation: `package_query` or `complaint_records` (super
/// admins bypass; sales accounts have extra scope checks not modelled).
pub fn server_rule_allows(permissions: &[String], is_superuser: bool) -> bool {
    is_superuser
        || permissions
            .iter()
            .any(|p| p == "package_query" || p == "complaint_records")
}

/// Local gate of the current client: requires `complaint_records`.
pub fn client_gate_allows(permissions: &[String]) -> bool {
    permissions.iter().any(|p| p == "complaint_records")
}

/// Both rules evaluated separately so the UI can explain which one failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PackagePermission {
    pub server_rule: bool,
    pub client_gate: bool,
}

impl PackagePermission {
    pub fn evaluate(session: &TsimSession) -> Self {
        Self {
            server_rule: server_rule_allows(&session.permissions, false),
            client_gate: client_gate_allows(&session.permissions),
        }
    }

    /// The feature is enabled only when the stricter local gate passes.
    pub fn allowed(&self) -> bool {
        self.client_gate
    }

    pub fn check(&self) -> Result<(), AppError> {
        if self.allowed() {
            Ok(())
        } else {
            Err(AppError::new(
                codes::PERMISSION_DENIED,
                "package lookup requires complaint_records",
            ))
        }
    }
}

/// 60-second reuse cache keyed by `(account, identifier)`.
#[derive(Debug)]
pub struct PackageCache<T> {
    entries: HashMap<(AccountContext, String), (T, i64)>,
}

impl<T> Default for PackageCache<T> {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }
}

impl<T> PackageCache<T> {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, account: &AccountContext, identifier: &str, now_ms: i64) -> Option<&T> {
        self.entries
            .get(&(account.clone(), identifier.to_string()))
            .filter(|(_, at)| now_ms - *at <= CACHE_REUSE_MS && now_ms >= *at)
            .map(|(v, _)| v)
    }

    pub fn put(&mut self, account: &AccountContext, identifier: &str, value: T, now_ms: i64) {
        self.entries
            .insert((account.clone(), identifier.to_string()), (value, now_ms));
    }

    pub fn invalidate_account(&mut self, account: &AccountContext) {
        self.entries.retain(|(a, _), _| a != account);
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::request::{Body, SecretString};
    use crate::session::TokenData;
    use contracts::{AccountId, Environment};

    fn session(perms: &[&str]) -> TsimSession {
        let mut s = TsimSession::from_token(
            TokenData {
                access_token: SecretString::new("tok"),
                token_type: "bearer".into(),
                session_ref: "s".into(),
                expires_at_ms: None,
            },
            0,
            1,
        );
        s.permissions = perms.iter().map(|p| p.to_string()).collect();
        s
    }

    #[test]
    fn order_nums_validation() {
        assert_eq!(validate_order_nums("  ABC123 ").expect("ok"), "ABC123");
        assert!(validate_order_nums("").is_err());
        assert!(validate_order_nums("   ").is_err());
        assert!(validate_order_nums("a\nb").is_err());
        assert!(validate_order_nums("a\rb").is_err());
        assert!(validate_order_nums("a\0b").is_err());
        assert!(validate_order_nums(&"9".repeat(129)).is_err());
        assert!(validate_order_nums(&"9".repeat(128)).is_ok());
    }

    #[test]
    fn perform_request_and_parse() {
        let s = session(&["complaint_records"]);
        let r = perform_request(&s, " 123 ").expect("req");
        assert_eq!(r.url, "https://csapi.tsim.tech/agent/package-query/perform");
        assert_eq!(r.body, Body::Json("{\"order_nums\":\"123\"}".into()));
        assert_eq!(r.header("Authorization"), Some("Bearer tok"));
        assert_eq!(
            parse_perform(200, r#"{"code":1,"result":{"query_id":"q-1"}}"#).expect("q"),
            "q-1"
        );
        assert_eq!(
            parse_perform(200, r#"{"code":2,"result":{"query_id":"q_2"}}"#).expect("q"),
            "q_2"
        );
        // Large integer id is taken from its raw text, never via f64.
        assert_eq!(
            parse_perform(
                200,
                r#"{"code":1,"result":{"query_id":12345678901234567890123}}"#
            )
            .expect("q"),
            "12345678901234567890123"
        );
        assert!(parse_perform(200, r#"{"code":1,"result":{"query_id":1.5}}"#).is_err());
        assert!(parse_perform(200, r#"{"code":1,"result":{"query_id":1e3}}"#).is_err());
        assert!(
            parse_perform(200, r#"{"code":0,"result":{"query_id":"q"}}"#)
                .expect_err("code")
                .is(codes::UPSTREAM_FAILURE)
        );
        assert!(parse_perform(200, r#"{"code":1,"result":{}}"#).is_err());
        assert!(parse_perform(200, r#"{"code":1,"result":{"query_id":"bad id"}}"#).is_err());
        assert!(
            parse_perform(200, r#"{"success":true,"data":{"query_id":"q"}}"#).is_err(),
            "different envelope"
        );
        assert!(parse_perform(401, r#"{"code":1}"#)
            .expect_err("401")
            .is(codes::SESSION_CLEARED));
        assert!(parse_perform(403, r#"{"code":1}"#)
            .expect_err("403")
            .is(codes::FORBIDDEN));
        let mut inactive = session(&[]);
        inactive.is_active = false;
        assert!(perform_request(&inactive, "1").is_err());
    }

    #[test]
    fn id_regex_and_encoding() {
        let s = session(&[]);
        assert!(validate_query_id("abc-DEF_09").is_ok());
        assert!(validate_query_id("").is_err());
        assert!(validate_query_id("a b").is_err());
        assert!(validate_query_id("a/b").is_err());
        assert!(validate_query_id("a&b=c").is_err());
        assert!(validate_query_id("ü").is_err());
        assert!(validate_query_id(&"a".repeat(129)).is_err());
        assert!(validate_query_id(&"a".repeat(128)).is_ok());
        let r = dataplan_list_request(&s, "q-1").expect("req");
        assert_eq!(
            r.url,
            "https://csapi.tsim.tech/agent/package-query/dataplan-list?query_id=q-1"
        );
        assert_eq!(r.method, crate::request::Method::Get);
        assert_eq!(r.body, Body::Empty);
        assert!(dataplan_list_request(&s, "q 1").is_err());
        assert!(dataplan_list_request(&s, "q&x=1").is_err());
        let d = detail_request(&s, "c_9").expect("req");
        assert_eq!(
            d.url,
            "https://csapi.tsim.tech/agent/package-query/detail?card_dataplan_id=c_9"
        );
        assert_eq!(
            live_detail_request(&s, "c").expect("req").url,
            "https://csapi.tsim.tech/agent/package-query/live-detail?card_dataplan_id=c"
        );
        assert_eq!(
            cdr_more_request(&s, "c").expect("req").url,
            "https://csapi.tsim.tech/agent/package-query/cdr-more?card_dataplan_id=c"
        );
        // Encoder itself escapes anything outside the unreserved set.
        assert_eq!(
            encode_query(&[("card_dataplan_id", "a b")]),
            "card_dataplan_id=a%20b"
        );
        assert_eq!(id_from_json(&JsonValue::string("x")).as_deref(), Some("x"));
        assert_eq!(
            id_from_json(&JsonValue::number_from_i64(-5)).as_deref(),
            Some("-5")
        );
        assert_eq!(id_from_json(&JsonValue::Bool(true)), None);
    }

    #[test]
    fn list_detail_and_supplements() {
        let list =
            parse_dataplan_list(200, r#"{"code":1,"result":[{"id":1},{"id":2}]}"#).expect("list");
        assert_eq!(list.len(), 2);
        let many = format!(r#"{{"code":1,"result":[{}]}}"#, vec!["{}"; 150].join(","));
        assert_eq!(
            parse_dataplan_list(200, &many).expect("cap").len(),
            MAX_DATAPLANS
        );
        assert!(
            parse_dataplan_list(200, r#"{"code":2,"result":[]}"#).is_err(),
            "code 2 only valid for perform"
        );
        assert!(parse_dataplan_list(200, r#"{"code":1,"result":{}}"#).is_err());
        let d = parse_detail(200, r#"{"code":1,"result":{"iccid":"89..."}}"#).expect("detail");
        assert!(d.get("iccid").is_some());
        assert!(parse_detail(200, r#"{"code":1,"result":[]}"#).is_err());
        assert!(parse_detail(200, r#"{"code":0,"msg":"no"}"#).is_err());
        // Supplement blocks degrade to empty, not failure.
        assert_eq!(
            parse_supplement(200, r#"{"code":1,"result":{"live":1}}"#)
                .expect("ok")
                .map(|v| v.get("live").is_some()),
            Some(true)
        );
        assert_eq!(
            parse_supplement(200, r#"{"code":0,"result":null}"#).expect("ok"),
            None
        );
        assert_eq!(parse_supplement(200, r#"{"code":1}"#).expect("ok"), None);
        assert_eq!(parse_supplement(200, "garbage").expect("ok"), None);
        assert_eq!(parse_supplement(500, "").expect("ok"), None);
        assert_eq!(parse_supplement(403, "").expect("ok"), None);
        assert!(parse_supplement(401, "")
            .expect_err("401")
            .is(codes::SESSION_CLEARED));
    }

    #[test]
    fn identifier_recognition() {
        let text = "ICCID 8986012345678901234 and EID 12345678901234567890123456789012, order 1234567890, 8912345678901234567 x 1234567890123456789";
        let c = recognize_identifiers(text);
        assert_eq!(c.len(), 3);
        assert_eq!(c[0].kind, IdentifierKind::Iccid);
        assert_eq!(c[0].value, "8986012345678901234");
        assert_eq!(c[0].start, 6);
        assert_eq!(c[0].end, 25);
        assert_eq!(c[1].kind, IdentifierKind::Eid);
        assert_eq!(c[1].value.len(), 32);
        assert_eq!(c[2].kind, IdentifierKind::Iccid);
        assert_eq!(c[2].value, "8912345678901234567");
        // 20-digit ICCID ok; 21 digits not; 19 digits not starting with 89 not.
        assert_eq!(recognize_identifiers("89860123456789012345").len(), 1);
        assert_eq!(recognize_identifiers("898601234567890123456").len(), 0);
        assert_eq!(recognize_identifiers("1986012345678901234").len(), 0);
        assert!(recognize_identifiers("").is_empty());
        assert!(recognize_identifiers("没有数字 😀").is_empty());
        let many: String = (0..20)
            .map(|i| format!("898601234567890123{i:02} "))
            .collect();
        assert_eq!(
            recognize_identifiers(&many).len(),
            MAX_IDENTIFIER_CANDIDATES
        );
        // Unicode before the digits: offsets are char-based.
        let u = recognize_identifiers("卡号：8986012345678901234");
        assert_eq!(u[0].start, 3);
    }

    #[test]
    fn permission_rules_are_separate() {
        assert!(server_rule_allows(&["package_query".into()], false));
        assert!(server_rule_allows(&["complaint_records".into()], false));
        assert!(server_rule_allows(&[], true));
        assert!(!server_rule_allows(&["other".into()], false));
        assert!(client_gate_allows(&["complaint_records".into()]));
        assert!(!client_gate_allows(&["package_query".into()]));
        let p = PackagePermission::evaluate(&session(&["package_query"]));
        assert!(p.server_rule);
        assert!(!p.client_gate);
        assert!(!p.allowed());
        assert!(p.check().expect_err("gate").is(codes::PERMISSION_DENIED));
        let p = PackagePermission::evaluate(&session(&["complaint_records"]));
        assert!(p.allowed());
        assert!(p.check().is_ok());
    }

    #[test]
    fn package_cache_expiry_and_isolation() {
        let a = AccountContext::new(AccountId::new("a"), Environment::production(), 1);
        let b = AccountContext::new(AccountId::new("b"), Environment::production(), 1);
        let mut c: PackageCache<String> = PackageCache::new();
        assert!(c.is_empty());
        c.put(&a, "8986", "summary".into(), 1_000);
        assert_eq!(
            c.get(&a, "8986", 1_000).map(String::as_str),
            Some("summary")
        );
        assert_eq!(
            c.get(&a, "8986", 1_000 + CACHE_REUSE_MS)
                .map(String::as_str),
            Some("summary")
        );
        assert_eq!(c.get(&a, "8986", 1_001 + CACHE_REUSE_MS), None);
        assert_eq!(
            c.get(&a, "8986", 999),
            None,
            "clock went backwards: no reuse"
        );
        assert_eq!(c.get(&b, "8986", 1_000), None);
        assert_eq!(c.get(&a.next_generation(), "8986", 1_000), None);
        c.put(&b, "8986", "other".into(), 1_000);
        c.invalidate_account(&a);
        assert_eq!(c.get(&a, "8986", 1_000), None);
        assert_eq!(c.get(&b, "8986", 1_000).map(String::as_str), Some("other"));
        assert_eq!(c.len(), 1);
        c.clear();
        assert!(c.is_empty());
    }
}

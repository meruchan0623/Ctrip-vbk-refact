//! Outbound translation through TSim (external-tsim.md "出站翻译", plan
//! AST-02 / AST-04, final review F12): request builder with exactly the six
//! documented fields, echo-checked response parsing, result binding,
//! the send-mode state machine and a per-account cache.

use std::collections::HashMap;

use contracts::json::JsonValue;
use contracts::{codes as shared_codes, AccountContext, AppError};

use crate::request::TsimRequest;
use crate::session::{codes, parse_envelope, TsimSession};

/// Target languages the current client allows (not the server Literal).
pub const TARGET_LANGS: [&str; 17] = [
    "zh", "en", "ja", "ko", "es", "fr", "de", "ru", "pt", "it", "ar", "th", "vi", "id", "ms",
    "zh-TW", "tr",
];
pub const MAX_TEXT_CHARS: usize = 20_000;
pub const MAX_TRANSLATED_CHARS: usize = 50_000;
pub const MAX_COMPOSER_VERSION_CHARS: usize = 25_000;
pub const SOURCE_LANG: &str = "zh";
pub const PURPOSE: &str = "outbound";

fn invalid(msg: &str) -> AppError {
    AppError::new(codes::INVALID_INPUT, msg)
}

pub fn is_supported_target(lang: &str) -> bool {
    TARGET_LANGS.contains(&lang)
}

/// `draft_request_id`: 1–100 chars of `[-a-z0-9]`.
pub fn validate_draft_request_id(id: &str) -> Result<(), AppError> {
    if id.is_empty() || id.len() > 100 {
        return Err(invalid("draft_request_id length must be 1..=100"));
    }
    if !id
        .bytes()
        .all(|b| b == b'-' || b.is_ascii_lowercase() || b.is_ascii_digit())
    {
        return Err(invalid("draft_request_id must match [-a-z0-9]"));
    }
    Ok(())
}

/// The request as sent, kept for echo verification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranslateParams {
    pub text: String,
    pub target_lang: String,
    pub draft_request_id: String,
    pub composer_content_version: String,
}

/// Builds `POST /agent/translate` with exactly
/// `text, target_lang, source_lang:"zh", purpose:"outbound",
/// draft_request_id, composer_content_version`.
pub fn translate_request(
    session: &TsimSession,
    text: &str,
    target_lang: &str,
    draft_request_id: &str,
    composer_content_version: &str,
) -> Result<(TsimRequest, TranslateParams), AppError> {
    if !session.is_active {
        return Err(AppError::new(codes::NOT_LOGGED_IN, "tsim session inactive"));
    }
    if text.trim().is_empty() {
        return Err(invalid("text is empty"));
    }
    if text.chars().count() > MAX_TEXT_CHARS {
        return Err(invalid("text exceeds 20000 characters"));
    }
    if !is_supported_target(target_lang) {
        return Err(invalid("unsupported target_lang"));
    }
    validate_draft_request_id(draft_request_id)?;
    if composer_content_version.chars().count() > MAX_COMPOSER_VERSION_CHARS {
        return Err(invalid("composer_content_version exceeds 25000 characters"));
    }
    let mut body = JsonValue::object();
    body.insert("text", JsonValue::string(text));
    body.insert("target_lang", JsonValue::string(target_lang));
    body.insert("source_lang", JsonValue::string(SOURCE_LANG));
    body.insert("purpose", JsonValue::string(PURPOSE));
    body.insert("draft_request_id", JsonValue::string(draft_request_id));
    body.insert(
        "composer_content_version",
        JsonValue::string(composer_content_version),
    );
    let req = TsimRequest::post_json(
        "/agent/translate",
        session.access_token.expose(),
        body.to_json(),
    );
    Ok((
        req,
        TranslateParams {
            text: text.to_string(),
            target_lang: target_lang.to_string(),
            draft_request_id: draft_request_id.to_string(),
            composer_content_version: composer_content_version.to_string(),
        },
    ))
}

/// Parses `success:true, data.translated_text` and verifies the echoed
/// `draft_request_id` / `composer_content_version` equal the request's.
pub fn parse_translate_response(
    status: u16,
    body: &str,
    sent: &TranslateParams,
) -> Result<String, AppError> {
    let data = parse_envelope(status, body)?;
    let echo_id = data.get("draft_request_id").and_then(JsonValue::as_str);
    let echo_ver = data
        .get("composer_content_version")
        .and_then(JsonValue::as_str);
    if echo_id != Some(sent.draft_request_id.as_str())
        || echo_ver != Some(sent.composer_content_version.as_str())
    {
        return Err(AppError::new(
            codes::TRANSLATION_MISMATCH,
            "echoed draft id / content version differ from the request",
        ));
    }
    let translated = data
        .get("translated_text")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| AppError::new(codes::MALFORMED_RESPONSE, "missing translated_text"))?;
    if translated.trim().is_empty() {
        return Err(AppError::new(
            codes::MALFORMED_RESPONSE,
            "empty translated_text",
        ));
    }
    if translated.chars().count() > MAX_TRANSLATED_CHARS {
        return Err(AppError::new(
            codes::MALFORMED_RESPONSE,
            "translated_text exceeds 50000 characters",
        ));
    }
    Ok(translated.to_string())
}

/// Binding of a translation to the account, conversation and draft version
/// it was requested for.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct TranslationBinding {
    pub account: AccountContext,
    pub gid: String,
    pub draft_version: u64,
}

/// Accepts a result only when its binding is exactly the current one
/// (F12): older session generation → `account.stale_generation`; other
/// conversation / draft version / identity → `assistant.stale_binding`.
pub fn accept_result(
    binding_in_result: &TranslationBinding,
    current: &TranslationBinding,
) -> Result<(), AppError> {
    if current
        .account
        .is_stale_generation_of(&binding_in_result.account)
    {
        return Err(AppError::new(
            shared_codes::ACCOUNT_STALE_GENERATION,
            "translation result from an older session generation",
        ));
    }
    if !current.account.is_current_for(&binding_in_result.account) {
        return Err(AppError::new(
            codes::STALE_BINDING,
            "translation result for another account",
        ));
    }
    if binding_in_result.gid != current.gid {
        return Err(AppError::new(
            codes::STALE_BINDING,
            "translation result for another conversation",
        ));
    }
    if binding_in_result.draft_version != current.draft_version {
        return Err(AppError::new(
            codes::STALE_BINDING,
            "draft changed after translation",
        ));
    }
    Ok(())
}

/// Send mode (docs/dev/09-assistant.md).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum OutboundMode {
    /// Preview in the translation bar; "替换" copies the translation into
    /// the composer; the user then sends manually.
    #[default]
    ReplaceDraft,
    /// Pressing send translates and sends the translation; the original is
    /// kept under the message for the merchant.
    SendDirect,
}

/// Composer content at the moment send is pressed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Draft {
    pub text: String,
    pub version: u64,
}

/// Translation state for the current composer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TranslationState {
    /// No translation needed (customer language is zh / translation off).
    NotNeeded,
    Idle,
    Pending {
        for_draft_version: u64,
    },
    Ready {
        text: String,
        for_draft_version: u64,
    },
    Failed {
        error: AppError,
        for_draft_version: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendPlan {
    SendOriginal,
    SendTranslated {
        text: String,
        original: String,
    },
    /// Translate (or wait for the in-flight translation) first.
    NeedTranslation,
    /// Explicit user choice required; nothing is sent.
    PromptRetryOrSendOriginal {
        error: AppError,
    },
}

/// Decides what pressing send does. A translation failure never silently
/// sends the original; a draft edited after translation is re-translated.
pub fn on_send_pressed(mode: OutboundMode, draft: &Draft, state: &TranslationState) -> SendPlan {
    if draft.text.trim().is_empty() {
        return SendPlan::NeedTranslation;
    }
    match (mode, state) {
        (_, TranslationState::NotNeeded) => SendPlan::SendOriginal,
        (
            _,
            TranslationState::Failed {
                error,
                for_draft_version,
            },
        ) => {
            if *for_draft_version == draft.version {
                SendPlan::PromptRetryOrSendOriginal {
                    error: error.clone(),
                }
            } else if mode == OutboundMode::SendDirect {
                SendPlan::NeedTranslation
            } else {
                SendPlan::SendOriginal
            }
        }
        (OutboundMode::ReplaceDraft, _) => SendPlan::SendOriginal,
        (
            OutboundMode::SendDirect,
            TranslationState::Ready {
                text,
                for_draft_version,
            },
        ) => {
            if *for_draft_version == draft.version && !text.trim().is_empty() {
                SendPlan::SendTranslated {
                    text: text.clone(),
                    original: draft.text.clone(),
                }
            } else {
                SendPlan::NeedTranslation
            }
        }
        (OutboundMode::SendDirect, TranslationState::Idle | TranslationState::Pending { .. }) => {
            SendPlan::NeedTranslation
        }
    }
}

/// Cache time-to-live (10 min) and capacity (500 entries).
pub const CACHE_TTL_MS: i64 = 10 * 60 * 1000;
pub const CACHE_CAPACITY: usize = 500;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct CacheKey {
    account: AccountContext,
    text: String,
    target_lang: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Slot {
    InFlight { since_ms: i64 },
    Done { text: String, at_ms: i64 },
}

/// Result of claiming a cache key before starting a request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CacheClaim {
    Hit(String),
    /// Another request for the same key is in flight; wait for it.
    InFlight,
    /// Caller owns the request and must `complete` or `fail` it.
    Claimed,
}

/// Translation memo keyed by `(account, text, target_lang)` with a
/// single-flight marker. Stores only translations, never request ids or
/// echoes; never shared across accounts (the key carries the full
/// `AccountContext`, generation included).
#[derive(Debug, Default)]
pub struct TranslationCache {
    slots: HashMap<CacheKey, Slot>,
}

impl TranslationCache {
    pub fn new() -> Self {
        Self::default()
    }

    fn key(account: &AccountContext, text: &str, target_lang: &str) -> CacheKey {
        CacheKey {
            account: account.clone(),
            text: text.to_string(),
            target_lang: target_lang.to_string(),
        }
    }

    pub fn len(&self) -> usize {
        self.slots.len()
    }

    pub fn is_empty(&self) -> bool {
        self.slots.is_empty()
    }

    pub fn get(
        &self,
        account: &AccountContext,
        text: &str,
        target_lang: &str,
        now_ms: i64,
    ) -> Option<String> {
        match self.slots.get(&Self::key(account, text, target_lang)) {
            Some(Slot::Done { text, at_ms }) if now_ms - at_ms <= CACHE_TTL_MS => {
                Some(text.clone())
            }
            _ => None,
        }
    }

    /// Looks up or claims the key for a single in-flight request.
    pub fn claim(
        &mut self,
        account: &AccountContext,
        text: &str,
        target_lang: &str,
        now_ms: i64,
    ) -> CacheClaim {
        let key = Self::key(account, text, target_lang);
        match self.slots.get(&key) {
            Some(Slot::Done { text, at_ms }) if now_ms - at_ms <= CACHE_TTL_MS => {
                return CacheClaim::Hit(text.clone());
            }
            Some(Slot::InFlight { since_ms }) if now_ms - since_ms <= CACHE_TTL_MS => {
                return CacheClaim::InFlight;
            }
            _ => {}
        }
        self.evict(now_ms);
        self.slots.insert(key, Slot::InFlight { since_ms: now_ms });
        CacheClaim::Claimed
    }

    pub fn complete(
        &mut self,
        account: &AccountContext,
        text: &str,
        target_lang: &str,
        translated: String,
        now_ms: i64,
    ) {
        self.slots.insert(
            Self::key(account, text, target_lang),
            Slot::Done {
                text: translated,
                at_ms: now_ms,
            },
        );
    }

    /// Releases the single-flight marker without storing anything.
    pub fn fail(&mut self, account: &AccountContext, text: &str, target_lang: &str) {
        if let Some(Slot::InFlight { .. }) = self.slots.get(&Self::key(account, text, target_lang))
        {
            self.slots.remove(&Self::key(account, text, target_lang));
        }
    }

    /// Drops everything for an account (logout, generation change).
    pub fn clear_account(&mut self, account: &AccountContext) {
        self.slots.retain(|k, _| &k.account != account);
    }

    pub fn clear(&mut self) {
        self.slots.clear();
    }

    fn evict(&mut self, now_ms: i64) {
        self.slots.retain(|_, s| match s {
            Slot::Done { at_ms, .. } => now_ms - *at_ms <= CACHE_TTL_MS,
            Slot::InFlight { since_ms } => now_ms - *since_ms <= CACHE_TTL_MS,
        });
        if self.slots.len() >= CACHE_CAPACITY {
            // Drop the oldest completed entries first.
            let mut done: Vec<(CacheKey, i64)> = self
                .slots
                .iter()
                .filter_map(|(k, s)| match s {
                    Slot::Done { at_ms, .. } => Some((k.clone(), *at_ms)),
                    Slot::InFlight { .. } => None,
                })
                .collect();
            done.sort_by_key(|(_, t)| *t);
            let excess = self.slots.len() + 1 - CACHE_CAPACITY;
            for (k, _) in done.into_iter().take(excess) {
                self.slots.remove(&k);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::request::SecretString;
    use crate::session::TokenData;
    use contracts::{AccountId, Environment};
    use std::collections::BTreeSet;

    fn session() -> TsimSession {
        TsimSession::from_token(
            TokenData {
                access_token: SecretString::new("tok"),
                token_type: "bearer".into(),
                session_ref: "s".into(),
                expires_at_ms: None,
            },
            0,
            1,
        )
    }

    fn ctx(id: &str, gen: u64) -> AccountContext {
        AccountContext::new(AccountId::new(id), Environment::production(), gen)
    }

    #[test]
    fn body_has_exactly_six_keys() {
        let s = session();
        let (req, params) = translate_request(&s, "你好", "en", "draft-1", "v1").expect("req");
        assert_eq!(req.url, "https://csapi.tsim.tech/agent/translate");
        assert_eq!(req.header("Authorization"), Some("Bearer tok"));
        assert_eq!(req.header("Content-Type"), Some("application/json"));
        let crate::request::Body::Json(json) = &req.body else {
            panic!("json body");
        };
        let doc = JsonValue::parse(json).expect("json");
        let keys: BTreeSet<&str> = doc
            .as_object()
            .expect("obj")
            .keys()
            .map(String::as_str)
            .collect();
        let expected: BTreeSet<&str> = [
            "text",
            "target_lang",
            "source_lang",
            "purpose",
            "draft_request_id",
            "composer_content_version",
        ]
        .into_iter()
        .collect();
        assert_eq!(keys, expected);
        assert_eq!(
            doc.get("source_lang").and_then(JsonValue::as_str),
            Some("zh")
        );
        assert_eq!(
            doc.get("purpose").and_then(JsonValue::as_str),
            Some("outbound")
        );
        assert_eq!(doc.get("text").and_then(JsonValue::as_str), Some("你好"));
        assert_eq!(params.draft_request_id, "draft-1");
    }

    #[test]
    fn validation_failures() {
        let s = session();
        assert!(translate_request(&s, "", "en", "d", "v").is_err());
        assert!(translate_request(&s, "   ", "en", "d", "v").is_err());
        assert!(translate_request(&s, &"字".repeat(20_001), "en", "d", "v").is_err());
        assert!(translate_request(&s, &"字".repeat(20_000), "en", "d", "v").is_ok());
        assert!(translate_request(&s, "x", "xx", "d", "v").is_err());
        assert!(translate_request(&s, "x", "EN", "d", "v").is_err());
        assert!(translate_request(&s, "x", "zh-TW", "d", "v").is_ok());
        assert!(translate_request(&s, "x", "en", "", "v").is_err());
        assert!(translate_request(&s, "x", "en", "Draft", "v").is_err());
        assert!(translate_request(&s, "x", "en", "d_1", "v").is_err());
        assert!(translate_request(&s, "x", "en", &"a".repeat(101), "v").is_err());
        assert!(translate_request(&s, "x", "en", &"a".repeat(100), "v").is_ok());
        assert!(translate_request(&s, "x", "en", "d", &"v".repeat(25_001)).is_err());
        let mut inactive = session();
        inactive.is_active = false;
        assert!(translate_request(&inactive, "x", "en", "d", "v")
            .expect_err("inactive")
            .is(codes::NOT_LOGGED_IN));
        for e in [
            translate_request(&s, "", "en", "d", "v"),
            translate_request(&s, "x", "xx", "d", "v"),
        ] {
            assert!(e.expect_err("err").is(codes::INVALID_INPUT));
        }
    }

    #[test]
    fn response_echo_must_match() {
        let sent = TranslateParams {
            text: "你好".into(),
            target_lang: "en".into(),
            draft_request_id: "draft-1".into(),
            composer_content_version: "v7".into(),
        };
        let ok = r#"{"success":true,"data":{"translated_text":"Hello","draft_request_id":"draft-1","composer_content_version":"v7"}}"#;
        assert_eq!(
            parse_translate_response(200, ok, &sent).expect("ok"),
            "Hello"
        );
        let wrong_id = r#"{"success":true,"data":{"translated_text":"Hello","draft_request_id":"draft-2","composer_content_version":"v7"}}"#;
        assert!(parse_translate_response(200, wrong_id, &sent)
            .expect_err("id")
            .is(codes::TRANSLATION_MISMATCH));
        let wrong_ver = r#"{"success":true,"data":{"translated_text":"Hello","draft_request_id":"draft-1","composer_content_version":"v8"}}"#;
        assert!(parse_translate_response(200, wrong_ver, &sent)
            .expect_err("ver")
            .is(codes::TRANSLATION_MISMATCH));
        let no_echo = r#"{"success":true,"data":{"translated_text":"Hello"}}"#;
        assert!(parse_translate_response(200, no_echo, &sent)
            .expect_err("echo")
            .is(codes::TRANSLATION_MISMATCH));
        let empty = r#"{"success":true,"data":{"translated_text":"  ","draft_request_id":"draft-1","composer_content_version":"v7"}}"#;
        assert!(parse_translate_response(200, empty, &sent)
            .expect_err("empty")
            .is(codes::MALFORMED_RESPONSE));
        let huge = format!(
            r#"{{"success":true,"data":{{"translated_text":"{}","draft_request_id":"draft-1","composer_content_version":"v7"}}}}"#,
            "a".repeat(50_001)
        );
        assert!(parse_translate_response(200, &huge, &sent).is_err());
        assert!(parse_translate_response(429, ok, &sent)
            .expect_err("429")
            .is(codes::SERVICE_UNAVAILABLE));
        assert!(parse_translate_response(403, ok, &sent)
            .expect_err("403")
            .is(codes::FORBIDDEN));
        let fail = r#"{"success":false,"message":"quota"}"#;
        assert!(parse_translate_response(200, fail, &sent)
            .expect_err("fail")
            .is(codes::UPSTREAM_FAILURE));
    }

    #[test]
    fn stale_binding_rejection() {
        let current = TranslationBinding {
            account: ctx("a", 3),
            gid: "g1".into(),
            draft_version: 5,
        };
        assert!(accept_result(&current, &current).is_ok());
        let older = TranslationBinding {
            account: ctx("a", 2),
            ..current.clone()
        };
        assert!(accept_result(&older, &current)
            .expect_err("gen")
            .is(shared_codes::ACCOUNT_STALE_GENERATION));
        let other_account = TranslationBinding {
            account: ctx("b", 3),
            ..current.clone()
        };
        assert!(accept_result(&other_account, &current)
            .expect_err("acct")
            .is(codes::STALE_BINDING));
        let other_gid = TranslationBinding {
            gid: "g2".into(),
            ..current.clone()
        };
        assert!(accept_result(&other_gid, &current)
            .expect_err("gid")
            .is(codes::STALE_BINDING));
        let old_draft = TranslationBinding {
            draft_version: 4,
            ..current.clone()
        };
        assert!(accept_result(&old_draft, &current)
            .expect_err("draft")
            .is(codes::STALE_BINDING));
    }

    #[test]
    fn send_mode_state_machine() {
        let draft = Draft {
            text: "你好".into(),
            version: 2,
        };
        let err = AppError::new(codes::SERVICE_UNAVAILABLE, "down");
        let failed = TranslationState::Failed {
            error: err.clone(),
            for_draft_version: 2,
        };
        // Failure never silently sends the original, in either mode.
        assert_eq!(
            on_send_pressed(OutboundMode::SendDirect, &draft, &failed),
            SendPlan::PromptRetryOrSendOriginal { error: err.clone() }
        );
        assert_eq!(
            on_send_pressed(OutboundMode::ReplaceDraft, &draft, &failed),
            SendPlan::PromptRetryOrSendOriginal { error: err.clone() }
        );
        // Ready for the current version → translated with original kept.
        let ready = TranslationState::Ready {
            text: "Hello".into(),
            for_draft_version: 2,
        };
        assert_eq!(
            on_send_pressed(OutboundMode::SendDirect, &draft, &ready),
            SendPlan::SendTranslated {
                text: "Hello".into(),
                original: "你好".into()
            }
        );
        // Draft edited after translation → re-translate.
        let stale = TranslationState::Ready {
            text: "Hello".into(),
            for_draft_version: 1,
        };
        assert_eq!(
            on_send_pressed(OutboundMode::SendDirect, &draft, &stale),
            SendPlan::NeedTranslation
        );
        assert_eq!(
            on_send_pressed(OutboundMode::SendDirect, &draft, &TranslationState::Idle),
            SendPlan::NeedTranslation
        );
        assert_eq!(
            on_send_pressed(
                OutboundMode::SendDirect,
                &draft,
                &TranslationState::Pending {
                    for_draft_version: 2
                }
            ),
            SendPlan::NeedTranslation
        );
        // Stale failure in SendDirect: translate again rather than prompt.
        let old_fail = TranslationState::Failed {
            error: err.clone(),
            for_draft_version: 1,
        };
        assert_eq!(
            on_send_pressed(OutboundMode::SendDirect, &draft, &old_fail),
            SendPlan::NeedTranslation
        );
        assert_eq!(
            on_send_pressed(OutboundMode::ReplaceDraft, &draft, &old_fail),
            SendPlan::SendOriginal
        );
        // ReplaceDraft sends the composer content as is.
        assert_eq!(
            on_send_pressed(OutboundMode::ReplaceDraft, &draft, &ready),
            SendPlan::SendOriginal
        );
        assert_eq!(
            on_send_pressed(OutboundMode::ReplaceDraft, &draft, &TranslationState::Idle),
            SendPlan::SendOriginal
        );
        // Not needed → original in both modes.
        assert_eq!(
            on_send_pressed(
                OutboundMode::SendDirect,
                &draft,
                &TranslationState::NotNeeded
            ),
            SendPlan::SendOriginal
        );
        // Empty draft never sends.
        let empty = Draft {
            text: " ".into(),
            version: 2,
        };
        assert_eq!(
            on_send_pressed(OutboundMode::ReplaceDraft, &empty, &TranslationState::Idle),
            SendPlan::NeedTranslation
        );
        assert_eq!(OutboundMode::default(), OutboundMode::ReplaceDraft);
        // SendDirect never yields SendOriginal unless NotNeeded or stale-failure in ReplaceDraft.
        for st in [
            TranslationState::Idle,
            TranslationState::Pending {
                for_draft_version: 2,
            },
            failed.clone(),
            ready.clone(),
            stale.clone(),
        ] {
            assert_ne!(
                on_send_pressed(OutboundMode::SendDirect, &draft, &st),
                SendPlan::SendOriginal
            );
        }
    }

    #[test]
    fn cache_single_flight_ttl_and_account_isolation() {
        let mut c = TranslationCache::new();
        let a = ctx("a", 1);
        let b = ctx("b", 1);
        assert_eq!(c.claim(&a, "你好", "en", 0), CacheClaim::Claimed);
        assert_eq!(c.claim(&a, "你好", "en", 1), CacheClaim::InFlight);
        assert_eq!(
            c.claim(&b, "你好", "en", 1),
            CacheClaim::Claimed,
            "other account is independent"
        );
        c.complete(&a, "你好", "en", "Hello".into(), 10);
        assert_eq!(
            c.claim(&a, "你好", "en", 20),
            CacheClaim::Hit("Hello".into())
        );
        assert_eq!(c.get(&a, "你好", "en", 20), Some("Hello".into()));
        assert_eq!(
            c.get(&b, "你好", "en", 20),
            None,
            "never shared across accounts"
        );
        assert_eq!(c.get(&a, "你好", "ja", 20), None);
        // Next generation of the same identity does not see the old entry.
        assert_eq!(c.get(&a.next_generation(), "你好", "en", 20), None);
        // TTL.
        assert_eq!(
            c.get(&a, "你好", "en", 10 + CACHE_TTL_MS),
            Some("Hello".into())
        );
        assert_eq!(c.get(&a, "你好", "en", 11 + CACHE_TTL_MS), None);
        assert_eq!(
            c.claim(&a, "你好", "en", 11 + CACHE_TTL_MS),
            CacheClaim::Claimed
        );
        c.fail(&a, "你好", "en");
        assert_eq!(
            c.claim(&a, "你好", "en", 12 + CACHE_TTL_MS),
            CacheClaim::Claimed
        );
        // An in-flight marker older than the TTL is released too (b's claim
        // from t=1 is gone by now), so a stuck request cannot block forever.
        assert_eq!(
            c.claim(&b, "你好", "en", 12 + CACHE_TTL_MS),
            CacheClaim::Claimed
        );
        // fail() never removes a completed entry.
        let t = 20 + CACHE_TTL_MS;
        c.complete(&a, "x", "en", "X".into(), t);
        c.complete(&b, "y", "en", "Y".into(), t);
        c.fail(&a, "x", "en");
        assert_eq!(c.get(&a, "x", "en", t + 1), Some("X".into()));
        c.clear_account(&a);
        assert_eq!(c.get(&a, "x", "en", t + 1), None);
        assert_eq!(c.get(&b, "y", "en", t + 1), Some("Y".into()), "b untouched");
        assert_eq!(
            c.claim(&b, "你好", "en", t + 1),
            CacheClaim::InFlight,
            "b's marker untouched"
        );
        c.clear();
        assert!(c.is_empty());
    }

    #[test]
    fn cache_capacity_bound() {
        let mut c = TranslationCache::new();
        let a = ctx("a", 1);
        for i in 0..CACHE_CAPACITY + 50 {
            let t = format!("t{i}");
            c.claim(&a, &t, "en", i as i64);
            c.complete(&a, &t, "en", "x".into(), i as i64);
        }
        assert!(c.len() <= CACHE_CAPACITY);
        assert_eq!(c.get(&a, "t0", "en", 600), None, "oldest evicted");
        assert!(c
            .get(&a, &format!("t{}", CACHE_CAPACITY + 49), "en", 600)
            .is_some());
    }
}

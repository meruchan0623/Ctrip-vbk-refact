//! Pure rules for the I-30 feature commands (typing state, recall, queue).
//!
//! Std-only so that the host glue in `src-tauri/src/features/*.rs` stays a
//! thin forwarder: every decision that can be tested without Tauri lives
//! here. Nothing in this module performs I/O or reads a clock; callers pass
//! the (server-anchored) time in.
//!
//! Evidence (docs/reviews/2026-11-02-desktop-live-capture-verification.md):
//! * recall = HTTP `11679/recallMessage {messageId, partnerId}`, both 19-digit
//!   strings (round 4); a JSON number would lose precision above 2^53, so ids
//!   are validated as digit strings and never parsed to integers;
//! * the official client refuses to recall a message older than 2 minutes
//!   (`不允许撤回发送超过2分钟的消息`, rea FE-34); the window is measured on
//!   server time, never on the local wall clock alone;
//! * typing state = XMPP `<message type="input_state">`, throttled to one per
//!   3 s (rea FE-30).
//!
//! The second half ([`FeatureFact`], [`validate_feature_fact`],
//! [`FeatureFactRateLimiter`]) guards the `feature://fact` channel: a page
//! feature fact arrives through `adapter_push_fact` as the `feature` variant
//! of `AdapterFact`, never enters the IM core, and is forwarded to the main
//! window only after these checks. The checks exist because the official
//! page could be made to emit arbitrary facts; the host must neither panic
//! nor flood the window.

use std::collections::BTreeMap;

use contracts::AppError;

/// Official recall window.
pub const RECALL_WINDOW_MS: i64 = 120_000;
/// A message stamped further in the future than this (relative to the
/// anchored server clock) means the clock or the stamp is wrong; recall is
/// refused instead of guessed.
pub const RECALL_FUTURE_TOLERANCE_MS: i64 = 5_000;
/// Minimum spacing of outgoing typing states per conversation.
pub const INPUT_STATE_THROTTLE_MS: i64 = 3_000;
/// Upper bound of conversations tracked by one throttle.
pub const INPUT_STATE_MAX_TRACKED: usize = 256;
/// Wire form of recall identifiers (round 4: 19-digit strings).
pub const RECALL_ID_LEN: usize = 19;
/// Longest `gid` / `from` accepted in a feature fact (characters).
pub const FEATURE_FACT_MAX_ID_CHARS: usize = 64;
/// Longest `message_id` accepted in a `recalled` fact (ASCII digits).
pub const FEATURE_FACT_MAX_MESSAGE_ID_LEN: usize = 32;
/// A typing indicator may not be announced further ahead than this; a larger
/// `until_ms` is clamped, never trusted (it would pin "对方正在输入" on screen).
pub const TYPING_FACT_MAX_HORIZON_MS: i64 = 30_000;
/// Feature facts admitted per `(account, gid, kind)` within one second.
pub const FEATURE_FACT_RATE_PER_SECOND: u32 = 4;
/// Upper bound of `(account, gid, kind)` buckets tracked by one limiter.
pub const FEATURE_FACT_RATE_MAX_TRACKED: usize = 1024;

pub mod codes {
    pub const IM_RECALL_INVALID_ID: &str = "im.recall_invalid_id";
    pub const IM_RECALL_EXPIRED: &str = "im.recall_expired";
    pub const IM_RECALL_CLOCK_UNKNOWN: &str = "im.recall_clock_unknown";
    pub const IM_FEATURE_INVALID_ARGUMENT: &str = "im.feature_invalid_argument";
    /// A page-supplied feature fact failed validation (same code the host
    /// uses for undecodable adapter payloads).
    pub const ADAPTER_INVALID_PAYLOAD: &str = "adapter.invalid_payload";
}

/// One feature fact as the page emits it (mirrors `FeatureFact` in
/// `contracts.ts`; the host adds the account before it reaches the window).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FeatureFact {
    Typing {
        gid: String,
        from: String,
        until_ms: i64,
    },
    Recalled {
        gid: String,
        message_id: String,
    },
    QueueNotice {
        gid: String,
    },
}

impl FeatureFact {
    pub fn gid(&self) -> &str {
        match self {
            FeatureFact::Typing { gid, .. }
            | FeatureFact::Recalled { gid, .. }
            | FeatureFact::QueueNotice { gid } => gid,
        }
    }

    /// Wire tag (`kind`), also the rate-limiter bucket.
    pub fn kind(&self) -> &'static str {
        match self {
            FeatureFact::Typing { .. } => "typing",
            FeatureFact::Recalled { .. } => "recalled",
            FeatureFact::QueueNotice { .. } => "queue_notice",
        }
    }
}

fn invalid_payload(what: &str) -> AppError {
    // The message names the field only; no page-supplied value is echoed.
    AppError::new(
        codes::ADAPTER_INVALID_PAYLOAD,
        format!("invalid feature fact: {what}"),
    )
}

/// Opaque identifier from the page: non-empty, at most
/// [`FEATURE_FACT_MAX_ID_CHARS`] characters, no control or whitespace
/// characters.
fn valid_opaque_id(s: &str) -> bool {
    let mut chars = 0usize;
    for c in s.chars() {
        chars += 1;
        if chars > FEATURE_FACT_MAX_ID_CHARS || c.is_control() || c.is_whitespace() {
            return false;
        }
    }
    chars > 0
}

/// Validates (and for `typing` clamps) a page feature fact. `now_ms` is the
/// host clock the main window will compare `until_ms` against.
///
/// * `gid` and `from`: see [`valid_opaque_id`];
/// * `message_id`: 1–[`FEATURE_FACT_MAX_MESSAGE_ID_LEN`] ASCII digits;
/// * `until_ms`: clamped into `[now_ms, now_ms + TYPING_FACT_MAX_HORIZON_MS]`.
///
/// The error never contains the offending value.
pub fn validate_feature_fact(fact: FeatureFact, now_ms: i64) -> Result<FeatureFact, AppError> {
    if !valid_opaque_id(fact.gid()) {
        return Err(invalid_payload("gid"));
    }
    Ok(match fact {
        FeatureFact::Typing {
            gid,
            from,
            until_ms,
        } => {
            if !valid_opaque_id(&from) {
                return Err(invalid_payload("from"));
            }
            let horizon = now_ms.saturating_add(TYPING_FACT_MAX_HORIZON_MS);
            FeatureFact::Typing {
                gid,
                from,
                until_ms: until_ms.clamp(now_ms, horizon),
            }
        }
        FeatureFact::Recalled { gid, message_id } => {
            let ok = !message_id.is_empty()
                && message_id.len() <= FEATURE_FACT_MAX_MESSAGE_ID_LEN
                && message_id.bytes().all(|b| b.is_ascii_digit());
            if !ok {
                return Err(invalid_payload("message_id"));
            }
            FeatureFact::Recalled { gid, message_id }
        }
        FeatureFact::QueueNotice { gid } => FeatureFact::QueueNotice { gid },
    })
}

/// Fixed one-second windows per `(account, gid, kind)`: at most
/// [`FEATURE_FACT_RATE_PER_SECOND`] facts are admitted per window, the rest
/// are reported as not admitted (the caller drops them silently). Bounded
/// to [`FEATURE_FACT_RATE_MAX_TRACKED`] buckets; stale buckets are evicted
/// first, then everything (a burst across many keys only loses history).
#[derive(Debug, Default, Clone)]
pub struct FeatureFactRateLimiter {
    buckets: BTreeMap<(String, String, &'static str), (i64, u32)>,
}

impl FeatureFactRateLimiter {
    pub fn new() -> Self {
        Self::default()
    }

    /// `account_key` is any stable identity string (environment + account id
    /// + generation); `kind` is [`FeatureFact::kind`].
    pub fn admit(&mut self, account_key: &str, gid: &str, kind: &'static str, now_ms: i64) -> bool {
        let window = now_ms.div_euclid(1000);
        let key = (account_key.to_string(), gid.to_string(), kind);
        if let Some((seen_window, count)) = self.buckets.get_mut(&key) {
            if *seen_window == window {
                if *count >= FEATURE_FACT_RATE_PER_SECOND {
                    return false;
                }
                *count += 1;
            } else {
                *seen_window = window;
                *count = 1;
            }
            return true;
        }
        if self.buckets.len() >= FEATURE_FACT_RATE_MAX_TRACKED {
            self.buckets.retain(|_, (w, _)| *w == window);
            if self.buckets.len() >= FEATURE_FACT_RATE_MAX_TRACKED {
                self.buckets.clear();
            }
        }
        self.buckets.insert(key, (window, 1));
        true
    }

    pub fn tracked(&self) -> usize {
        self.buckets.len()
    }

    pub fn clear(&mut self) {
        self.buckets.clear();
    }
}

/// Outcome of the client-side recall window check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecallVerdict {
    /// Inside the window; `remaining_ms` is informational.
    Allowed { remaining_ms: i64 },
    /// More than [`RECALL_WINDOW_MS`] old.
    Expired,
    /// No anchored server time is available: the window cannot be judged.
    ClockUnknown,
    /// The message is stamped after the server clock (beyond tolerance).
    FutureTimestamp,
}

/// Judges the 2-minute window on server time. `server_now_ms` is `None`
/// when the clock service has no trusted anchor; that never means "allowed".
pub fn recall_verdict(created_ms: i64, server_now_ms: Option<i64>) -> RecallVerdict {
    let Some(now) = server_now_ms else {
        return RecallVerdict::ClockUnknown;
    };
    let age = now.saturating_sub(created_ms);
    if age < -RECALL_FUTURE_TOLERANCE_MS {
        return RecallVerdict::FutureTimestamp;
    }
    if age > RECALL_WINDOW_MS {
        return RecallVerdict::Expired;
    }
    RecallVerdict::Allowed {
        remaining_ms: RECALL_WINDOW_MS - age.max(0),
    }
}

/// Maps a verdict onto the error a command must return (`Ok` when allowed).
pub fn recall_gate(created_ms: i64, server_now_ms: Option<i64>) -> Result<(), AppError> {
    match recall_verdict(created_ms, server_now_ms) {
        RecallVerdict::Allowed { .. } => Ok(()),
        RecallVerdict::Expired => Err(AppError::new(
            codes::IM_RECALL_EXPIRED,
            "messages older than 2 minutes cannot be recalled",
        )),
        RecallVerdict::ClockUnknown | RecallVerdict::FutureTimestamp => Err(AppError::new(
            codes::IM_RECALL_CLOCK_UNKNOWN,
            "server time is not anchored; the recall window cannot be judged",
        )),
    }
}

fn is_wire_id(s: &str) -> bool {
    s.len() == RECALL_ID_LEN && s.bytes().all(|b| b.is_ascii_digit())
}

/// `messageId` is the server message id (never a `localId`); `partnerId` is
/// the conversation group id. Both are 19-digit strings on the wire.
pub fn validate_recall_ids(message_id: &str, partner_id: &str) -> Result<(), AppError> {
    if !is_wire_id(message_id) {
        return Err(AppError::new(
            codes::IM_RECALL_INVALID_ID,
            "messageId must be a 19-digit server message id",
        ));
    }
    if !is_wire_id(partner_id) {
        return Err(AppError::new(
            codes::IM_RECALL_INVALID_ID,
            "partnerId must be a 19-digit group id",
        ));
    }
    Ok(())
}

/// Conversation ids accepted by feature commands: non-empty, ASCII digits,
/// at most 32 characters.
pub fn validate_gid(gid: &str) -> Result<(), AppError> {
    if gid.is_empty() || gid.len() > 32 || !gid.bytes().all(|b| b.is_ascii_digit()) {
        return Err(AppError::new(
            codes::IM_FEATURE_INVALID_ARGUMENT,
            "gid must be 1-32 ASCII digits",
        ));
    }
    Ok(())
}

/// Per-conversation throttle for outgoing typing states.
#[derive(Debug, Default, Clone)]
pub struct InputStateThrottle {
    last_sent: BTreeMap<String, i64>,
}

impl InputStateThrottle {
    pub fn new() -> Self {
        Self::default()
    }

    /// True when a typing state for `gid` may be sent at `now_ms`; records
    /// the send. A clock that moved backwards re-admits once and re-anchors.
    pub fn admit(&mut self, gid: &str, now_ms: i64) -> bool {
        if let Some(&last) = self.last_sent.get(gid) {
            if now_ms >= last && now_ms - last < INPUT_STATE_THROTTLE_MS {
                return false;
            }
        }
        if !self.last_sent.contains_key(gid) && self.last_sent.len() >= INPUT_STATE_MAX_TRACKED {
            let oldest = self
                .last_sent
                .iter()
                .min_by_key(|(_, &t)| t)
                .map(|(k, _)| k.clone());
            if let Some(oldest) = oldest {
                self.last_sent.remove(&oldest);
            }
        }
        self.last_sent.insert(gid.to_string(), now_ms);
        true
    }

    /// Forget a conversation (closed, finished, account switched).
    pub fn forget(&mut self, gid: &str) {
        self.last_sent.remove(gid);
    }

    pub fn clear(&mut self) {
        self.last_sent.clear();
    }

    pub fn tracked(&self) -> usize {
        self.last_sent.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recall_window_is_judged_on_server_time() {
        let created = 1_000_000;
        assert_eq!(
            recall_verdict(created, Some(created + 119_999)),
            RecallVerdict::Allowed { remaining_ms: 1 }
        );
        assert_eq!(
            recall_verdict(created, Some(created + 120_000)),
            RecallVerdict::Allowed { remaining_ms: 0 }
        );
        assert_eq!(
            recall_verdict(created, Some(created + 120_001)),
            RecallVerdict::Expired
        );
        assert_eq!(recall_verdict(created, None), RecallVerdict::ClockUnknown);
    }

    #[test]
    fn recall_future_stamp_beyond_tolerance_is_refused() {
        let now = 5_000_000;
        assert!(matches!(
            recall_verdict(now + 5_000, Some(now)),
            RecallVerdict::Allowed { .. }
        ));
        assert_eq!(
            recall_verdict(now + 5_001, Some(now)),
            RecallVerdict::FutureTimestamp
        );
    }

    #[test]
    fn recall_gate_codes() {
        assert!(recall_gate(0, Some(1_000)).is_ok());
        assert!(recall_gate(0, Some(200_000))
            .expect_err("expired")
            .is(codes::IM_RECALL_EXPIRED));
        assert!(recall_gate(0, None)
            .expect_err("unknown")
            .is(codes::IM_RECALL_CLOCK_UNKNOWN));
        assert!(recall_gate(10_000_000, Some(0))
            .expect_err("future")
            .is(codes::IM_RECALL_CLOCK_UNKNOWN));
    }

    #[test]
    fn recall_ids_are_19_digit_strings() {
        let ok = "1234567890123456789";
        assert!(validate_recall_ids(ok, ok).is_ok());
        for bad in [
            "",
            "123",
            "12345678901234567890",
            "123456789012345678a",
            " 234567890123456789",
            "-234567890123456789",
            "１２３４５６７８９０１２３４５６７８９",
        ] {
            assert!(validate_recall_ids(bad, ok).is_err(), "{bad:?}");
            assert!(validate_recall_ids(ok, bad).is_err(), "{bad:?}");
        }
        let e = validate_recall_ids("x", ok).expect_err("bad");
        assert!(e.is(codes::IM_RECALL_INVALID_ID));
    }

    #[test]
    fn gid_validation() {
        assert!(validate_gid("1234567890123456789").is_ok());
        assert!(validate_gid("").is_err());
        assert!(validate_gid("12 3").is_err());
        assert!(validate_gid(&"1".repeat(33)).is_err());
    }

    #[test]
    fn throttle_admits_once_per_three_seconds_per_conversation() {
        let mut t = InputStateThrottle::new();
        assert!(t.admit("1", 10_000));
        assert!(!t.admit("1", 10_000));
        assert!(!t.admit("1", 12_999));
        assert!(t.admit("2", 12_999), "other conversation is independent");
        assert!(t.admit("1", 13_000));
        assert!(!t.admit("1", 15_999));
        assert!(t.admit("1", 16_000));
    }

    #[test]
    fn throttle_survives_clock_going_backwards_and_stays_bounded() {
        let mut t = InputStateThrottle::new();
        assert!(t.admit("1", 50_000));
        assert!(t.admit("1", 10_000), "backwards clock re-anchors");
        assert!(!t.admit("1", 10_500));
        for i in 0..(INPUT_STATE_MAX_TRACKED + 40) {
            t.admit(&format!("g{i}"), 100_000 + i as i64);
        }
        assert!(t.tracked() <= INPUT_STATE_MAX_TRACKED);
        t.forget("g300");
        t.clear();
        assert_eq!(t.tracked(), 0);
    }

    // ------------------------------------------------------ feature facts

    const NOW: i64 = 1_761_800_000_000;

    fn typing(gid: &str, from: &str, until_ms: i64) -> FeatureFact {
        FeatureFact::Typing {
            gid: gid.into(),
            from: from.into(),
            until_ms,
        }
    }

    #[test]
    fn feature_fact_gid_rules_apply_to_every_kind() {
        let long = "g".repeat(FEATURE_FACT_MAX_ID_CHARS);
        let ok = FeatureFact::QueueNotice { gid: long.clone() };
        assert_eq!(validate_feature_fact(ok.clone(), NOW), Ok(ok));
        // 64 multi-byte characters are still 64 characters
        let wide = "字".repeat(FEATURE_FACT_MAX_ID_CHARS);
        assert!(validate_feature_fact(FeatureFact::QueueNotice { gid: wide }, NOW).is_ok());
        for bad in ["", " ", "a b", "a\n", "\u{7f}", &"g".repeat(65)] {
            let e = validate_feature_fact(FeatureFact::QueueNotice { gid: bad.into() }, NOW)
                .expect_err(bad);
            assert!(e.is(codes::ADAPTER_INVALID_PAYLOAD), "{bad:?}");
            assert_eq!(
                e.message, "invalid feature fact: gid",
                "no echo of the value"
            );
            assert!(
                validate_feature_fact(typing(bad, "c", NOW), NOW).is_err(),
                "{bad:?}"
            );
            assert!(validate_feature_fact(
                FeatureFact::Recalled {
                    gid: bad.into(),
                    message_id: "1".into()
                },
                NOW
            )
            .is_err());
        }
    }

    #[test]
    fn typing_fact_validates_from_and_clamps_until() {
        let gid = "1234567890123456789";
        assert_eq!(
            validate_feature_fact(typing(gid, "cust-9", NOW + 5_000), NOW),
            Ok(typing(gid, "cust-9", NOW + 5_000))
        );
        // too far ahead → horizon; in the past → now; exactly on the bounds kept
        assert_eq!(
            validate_feature_fact(typing(gid, "c", NOW + 86_400_000), NOW),
            Ok(typing(gid, "c", NOW + TYPING_FACT_MAX_HORIZON_MS))
        );
        assert_eq!(
            validate_feature_fact(typing(gid, "c", NOW - 1), NOW),
            Ok(typing(gid, "c", NOW))
        );
        assert_eq!(
            validate_feature_fact(typing(gid, "c", NOW + TYPING_FACT_MAX_HORIZON_MS), NOW),
            Ok(typing(gid, "c", NOW + TYPING_FACT_MAX_HORIZON_MS))
        );
        assert_eq!(
            validate_feature_fact(typing(gid, "c", i64::MAX), i64::MAX - 10),
            Ok(typing(gid, "c", i64::MAX)),
            "saturating horizon never panics"
        );
        for bad_from in ["", "a b", &"x".repeat(65), "\t"] {
            let e = validate_feature_fact(typing(gid, bad_from, NOW), NOW).expect_err(bad_from);
            assert!(e.is(codes::ADAPTER_INVALID_PAYLOAD));
            assert!(e.message.contains("from"));
        }
    }

    #[test]
    fn recalled_fact_message_id_is_1_to_32_digits() {
        let gid = "1234567890123456789";
        for ok in ["1", "9876543210987654321", &"7".repeat(32)] {
            let f = FeatureFact::Recalled {
                gid: gid.into(),
                message_id: ok.into(),
            };
            assert_eq!(validate_feature_fact(f.clone(), NOW), Ok(f));
        }
        for bad in ["", "abc", "12a", "-1", " 1", &"7".repeat(33), "１２３"] {
            let e = validate_feature_fact(
                FeatureFact::Recalled {
                    gid: gid.into(),
                    message_id: bad.into(),
                },
                NOW,
            )
            .expect_err(bad);
            assert!(e.is(codes::ADAPTER_INVALID_PAYLOAD), "{bad:?}");
            assert!(e.message.contains("message_id"));
        }
    }

    #[test]
    fn feature_fact_kind_and_gid_accessors() {
        assert_eq!(typing("g", "c", 1).kind(), "typing");
        assert_eq!(
            FeatureFact::Recalled {
                gid: "g".into(),
                message_id: "1".into()
            }
            .kind(),
            "recalled"
        );
        let q = FeatureFact::QueueNotice { gid: "g2".into() };
        assert_eq!(q.kind(), "queue_notice");
        assert_eq!(q.gid(), "g2");
    }

    #[test]
    fn rate_limiter_admits_four_per_second_per_account_gid_kind() {
        let mut l = FeatureFactRateLimiter::new();
        for i in 0..4 {
            assert!(l.admit("a", "g", "typing", NOW + i * 100), "{i}");
        }
        assert!(!l.admit("a", "g", "typing", NOW + 500));
        assert!(!l.admit("a", "g", "typing", NOW + 999));
        // other kind / gid / account are independent buckets
        assert!(l.admit("a", "g", "recalled", NOW + 500));
        assert!(l.admit("a", "g2", "typing", NOW + 500));
        assert!(l.admit("b", "g", "typing", NOW + 500));
        // next fixed window re-opens
        assert!(l.admit("a", "g", "typing", NOW + 1_000));
        assert!(l.admit("a", "g", "typing", NOW + 1_999));
        assert!(l.admit("a", "g", "typing", NOW + 1_999));
        assert!(l.admit("a", "g", "typing", NOW + 1_999));
        assert!(!l.admit("a", "g", "typing", NOW + 1_999));
    }

    #[test]
    fn rate_limiter_handles_negative_and_backwards_clocks_and_stays_bounded() {
        let mut l = FeatureFactRateLimiter::new();
        assert!(l.admit("a", "g", "typing", -1));
        assert!(l.admit("a", "g", "typing", -1000));
        assert!(l.admit("a", "g", "typing", NOW));
        for i in 0..(FEATURE_FACT_RATE_MAX_TRACKED + 50) {
            assert!(l.admit("a", &format!("g{i}"), "queue_notice", NOW + i as i64));
        }
        assert!(l.tracked() <= FEATURE_FACT_RATE_MAX_TRACKED);
        // eviction of a full table in one window still admits and stays bounded
        for i in 0..(FEATURE_FACT_RATE_MAX_TRACKED * 2) {
            assert!(l.admit("b", &format!("h{i}"), "typing", NOW + 5_000));
        }
        assert!(l.tracked() <= FEATURE_FACT_RATE_MAX_TRACKED);
        l.clear();
        assert_eq!(l.tracked(), 0);
    }
}

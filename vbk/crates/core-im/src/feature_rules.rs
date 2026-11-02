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

pub mod codes {
    pub const IM_RECALL_INVALID_ID: &str = "im.recall_invalid_id";
    pub const IM_RECALL_EXPIRED: &str = "im.recall_expired";
    pub const IM_RECALL_CLOCK_UNKNOWN: &str = "im.recall_clock_unknown";
    pub const IM_FEATURE_INVALID_ARGUMENT: &str = "im.feature_invalid_argument";
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
}

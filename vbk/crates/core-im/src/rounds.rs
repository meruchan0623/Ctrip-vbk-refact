//! Waiting rounds (strong-alert §4, §5; plan §7 "迟到回复证据"; F06).
//!
//! A round is the wait for a merchant reply to the **first** unanswered
//! customer business message of a conversation. Per conversation the state is
//! `Idle`, `Waiting(Round)` or `PendingVerification(Round)`.
//!
//! The engine is derivational: after every relevant change the ordered,
//! deduplicated message list of the conversation is re-evaluated
//! ([`evaluate`]) and the resulting transition is applied by
//! [`RoundTracker::reconcile`]. Rules encoded here:
//!
//! * (a) only reminder-eligible conversations hold rounds;
//! * (b) only customer business messages seen from a non-replay source can
//!   **start** a round; replay (init/history) can only confirm, move earlier
//!   or end an existing round;
//! * (c) consecutive customer messages never move the start later; an
//!   earlier customer message arriving out of order moves it earlier;
//! * (d) only a server-confirmed valid merchant reply covering the start ends
//!   a round; robot / Ctrip / system never do; an unresolved sender role
//!   marks the round pending verification instead of guessing;
//! * (e) read, open, send click, submitted, unknown dispositions never end
//!   a round (they simply never reach this engine);
//! * (f) finished / transferred-out / not eligible end the round with the
//!   matching reason;
//! * (g) when the loaded history cannot prove which message is the first
//!   unanswered one the round is pending verification without a fabricated
//!   start time; `prove_history_complete` later confirms it;
//! * (h) business-line rules are explicit (`BusinessLineRules`); nothing
//!   unverified (`CAR_TIMEOUT`) is applied silently.

use std::collections::BTreeMap;

use contracts::{AccountContext, ClockReading, RoundEndReason, RoundEvent, WaitingRoundRef};

use crate::dedup::MessageRecord;
use crate::watermarks::HistoryWindow;

/// One waiting round.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Round {
    /// `"{gid}:{start_message_id}"`, or `"{gid}:#{seq}"` while the start is
    /// unknown. Stable for the life of the round.
    pub round_id: String,
    /// Incremented on every change; hide/snooze in core-notify bind to it.
    pub version: u64,
    pub start_message_id: Option<String>,
    pub start_time_ms: Option<i64>,
    /// `false` → "待核对".
    pub start_confirmed: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum RoundState {
    #[default]
    Idle,
    Waiting(Round),
    PendingVerification(Round),
}

impl RoundState {
    pub fn round(&self) -> Option<&Round> {
        match self {
            RoundState::Idle => None,
            RoundState::Waiting(r) | RoundState::PendingVerification(r) => Some(r),
        }
    }

    pub fn is_idle(&self) -> bool {
        matches!(self, RoundState::Idle)
    }

    pub fn is_pending(&self) -> bool {
        matches!(self, RoundState::PendingVerification(_))
    }
}

/// First T1 deadline computed by core-im (archive §2.1 rule 2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Deadline {
    /// Monotonic ms at which T1 elapses; `None` while the start is unknown.
    pub due_at_monotonic_ms: Option<u64>,
    /// `false` when the clock anchor is untrusted or the start unconfirmed:
    /// show as estimate / "待核对", never as a platform countdown.
    pub trusted: bool,
}

/// `start_time + T1` projected onto the monotonic clock of `clock`.
pub fn first_t1_deadline(round: &Round, t1_seconds: u32, clock: &ClockReading) -> Deadline {
    let Some(start) = round.start_time_ms else {
        return Deadline {
            due_at_monotonic_ms: None,
            trusted: false,
        };
    };
    let due_server = start.saturating_add(i64::from(t1_seconds).saturating_mul(1000));
    let remaining = due_server.saturating_sub(clock.server_now_ms).max(0);
    let remaining_u = u64::try_from(remaining).unwrap_or(0);
    Deadline {
        due_at_monotonic_ms: Some(clock.monotonic_ms.saturating_add(remaining_u)),
        trusted: clock.trusted() && round.start_confirmed,
    }
}

// ------------------------------------------------------------ business lines

/// How a business line (`service_type`) takes part in reminders.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum BusinessLineRule {
    /// Generic first-unanswered-customer-message rule (the only verified
    /// path; applies to the sampled `"1513"` line).
    #[default]
    Generic,
    /// Excluded from reminders (what the web `rF` does for BOP). Must be set
    /// explicitly by the integration; nothing is excluded by default.
    Excluded,
}

/// Explicit per-business-line rules. Default: every `service_type` is
/// `Generic`. The web's car-rental `CAR_TIMEOUT` branch is **not**
/// implemented; it is named here only so it is never applied silently.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BusinessLineRules {
    overrides: BTreeMap<String, BusinessLineRule>,
}

impl BusinessLineRules {
    /// `service_type` values seen in controlled samples (docs/api/transports.md).
    pub const SAMPLED_SERVICE_TYPES: &'static [&'static str] = &["1513"];
    /// Name of the unverified web branch that this crate does not apply.
    pub const UNVERIFIED_CAR_TIMEOUT_BRANCH: &'static str = "CAR_TIMEOUT";

    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_sampled(service_type: &str) -> bool {
        Self::SAMPLED_SERVICE_TYPES.contains(&service_type)
    }

    pub fn set(&mut self, service_type: impl Into<String>, rule: BusinessLineRule) {
        self.overrides.insert(service_type.into(), rule);
    }

    pub fn rule_for(&self, service_type: &str) -> BusinessLineRule {
        self.overrides
            .get(service_type)
            .copied()
            .unwrap_or_default()
    }
}

// ----------------------------------------------------------------- evaluate

/// Whether a confirmed merchant reply answers a customer message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Coverage {
    Covered,
    NotCovered,
    /// Same timestamp or the reply's intent boundary cannot be placed:
    /// keep the customer message pending verification.
    Ambiguous,
}

/// Candidate start message of a round.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartCandidate {
    pub message_id: Option<String>,
    pub create_time_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EvalOutcome {
    /// Every customer business message is covered by a confirmed reply.
    NoWait,
    /// `start` is the earliest uncovered customer message. `sufficient`
    /// says whether the loaded history proves it is the first one.
    Wait {
        start: StartCandidate,
        sufficient: bool,
    },
    /// The earliest uncovered customer message is ambiguous (unresolved
    /// sender role after it, same-timestamp reply, unplaceable boundary).
    Ambiguous { candidate: StartCandidate },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Evaluation {
    pub outcome: EvalOutcome,
    /// Some uncovered customer message was seen from a non-replay source.
    pub live_evidence: bool,
    /// Newest confirmed merchant reply time in the loaded list.
    pub latest_reply_time_ms: Option<i64>,
}

/// Evaluate one conversation's ordered record list.
///
/// `coverage(reply, customer)` decides whether a confirmed reply answers a
/// customer message (time order, or the intent boundary for own sends).
pub fn evaluate(
    ordered: &[&MessageRecord],
    window: Option<&HistoryWindow>,
    coverage: &dyn Fn(&MessageRecord, &MessageRecord) -> Coverage,
) -> Evaluation {
    let replies: Vec<&MessageRecord> = ordered
        .iter()
        .copied()
        .filter(|m| m.is_confirmed_merchant_reply())
        .collect();
    let latest_reply_time_ms = replies.iter().map(|r| r.create_time_ms).max();
    let unresolved_times: Vec<i64> = ordered
        .iter()
        .filter(|m| m.is_unresolved_business())
        .map(|m| m.create_time_ms)
        .collect();

    let mut first_open: Option<(&MessageRecord, Coverage)> = None;
    let mut live_evidence = false;
    let mut covered_before_open = false;

    for m in ordered.iter().copied().filter(|m| m.is_customer_business()) {
        let mut status = Coverage::NotCovered;
        for r in &replies {
            match coverage(r, m) {
                Coverage::Covered => {
                    status = Coverage::Covered;
                    break;
                }
                Coverage::Ambiguous => status = Coverage::Ambiguous,
                Coverage::NotCovered => {}
            }
        }
        if status != Coverage::Covered && unresolved_times.iter().any(|t| *t >= m.create_time_ms) {
            status = Coverage::Ambiguous;
        }
        if status == Coverage::Covered {
            if first_open.is_none() {
                covered_before_open = true;
            }
            continue;
        }
        if first_open.is_none() {
            first_open = Some((m, status));
        }
        if m.seen_live() {
            live_evidence = true;
        }
    }

    let Some((c, status)) = first_open else {
        return Evaluation {
            outcome: EvalOutcome::NoWait,
            live_evidence: false,
            latest_reply_time_ms,
        };
    };
    let reply_before = replies.iter().any(|r| r.create_time_ms < c.create_time_ms);
    let sufficient =
        window.map_or(true, HistoryWindow::is_complete) || reply_before || covered_before_open;
    let candidate = StartCandidate {
        message_id: c.message_id.clone(),
        create_time_ms: c.create_time_ms,
    };
    let outcome = if status == Coverage::Ambiguous {
        EvalOutcome::Ambiguous { candidate }
    } else {
        EvalOutcome::Wait {
            start: candidate,
            sufficient,
        }
    };
    Evaluation {
        outcome,
        live_evidence,
        latest_reply_time_ms,
    }
}

// ------------------------------------------------------------------ tracker

/// Eligibility of a conversation for reminders, as seen by the tracker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Eligibility {
    Eligible,
    NotEligible(RoundEndReason),
    /// No conversation fact yet: neither start nor end anything.
    Unknown,
}

/// Minimal persisted form of a round (dev 05-store).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersistedRound {
    pub gid: String,
    pub round_id: String,
    pub version: u64,
    pub start_message_id: Option<String>,
    pub start_time_ms: Option<i64>,
    pub start_confirmed: bool,
}

/// Round states of one account plus the event queue.
#[derive(Debug, Clone)]
pub struct RoundTracker {
    account: AccountContext,
    states: BTreeMap<String, RoundState>,
    labels: BTreeMap<String, String>,
    events: Vec<RoundEvent>,
    seq: u64,
}

impl RoundTracker {
    pub fn new(account: AccountContext) -> Self {
        Self {
            account,
            states: BTreeMap::new(),
            labels: BTreeMap::new(),
            events: Vec::new(),
            seq: 0,
        }
    }

    pub fn account(&self) -> &AccountContext {
        &self.account
    }

    pub fn seq(&self) -> u64 {
        self.seq
    }

    pub fn set_seq(&mut self, seq: u64) {
        self.seq = self.seq.max(seq);
    }

    pub fn state(&self, gid: &str) -> &RoundState {
        static IDLE: RoundState = RoundState::Idle;
        self.states.get(gid).unwrap_or(&IDLE)
    }

    /// `(gid, state)` for every conversation with a live round.
    pub fn active(&self) -> impl Iterator<Item = (&str, &RoundState)> {
        self.states
            .iter()
            .filter(|(_, s)| !s.is_idle())
            .map(|(g, s)| (g.as_str(), s))
    }

    pub fn persisted(&self) -> Vec<PersistedRound> {
        self.active()
            .filter_map(|(gid, s)| {
                s.round().map(|r| PersistedRound {
                    gid: gid.to_string(),
                    round_id: r.round_id.clone(),
                    version: r.version,
                    start_message_id: r.start_message_id.clone(),
                    start_time_ms: r.start_time_ms,
                    start_confirmed: r.start_confirmed,
                })
            })
            .collect()
    }

    /// Already-masked conversation label used in `RoundEvent::Started`.
    pub fn set_label(&mut self, gid: &str, masked_label: impl Into<String>) {
        self.labels.insert(gid.to_string(), masked_label.into());
    }

    pub fn label(&self, gid: &str) -> String {
        self.labels
            .get(gid)
            .cloned()
            .unwrap_or_else(|| mask_label(gid))
    }

    pub fn drain_events(&mut self) -> Vec<RoundEvent> {
        std::mem::take(&mut self.events)
    }

    pub fn pending_events(&self) -> usize {
        self.events.len()
    }

    /// Restore a persisted round as `PendingVerification`; an upsert
    /// `Started { start_confirmed: false }` is emitted so a consumer that
    /// starts empty learns about it. Promotion needs fresh facts.
    pub fn restore_round(&mut self, round: PersistedRound) {
        let r = Round {
            round_id: round.round_id,
            version: round.version.saturating_add(1),
            start_message_id: round.start_message_id,
            start_time_ms: round.start_time_ms,
            start_confirmed: false,
        };
        self.emit_started(&round.gid, &r);
        self.states
            .insert(round.gid, RoundState::PendingVerification(r));
    }

    /// Identity generation advanced: every round is invalidated under its
    /// old reference and nothing stays addressable by the old generation.
    pub fn invalidate(&mut self, new_account: AccountContext) {
        let old = std::mem::take(&mut self.states);
        for (gid, state) in old {
            if let Some(r) = state.round() {
                let round = self.make_ref(&gid, r);
                self.events.push(RoundEvent::Invalidated { round });
            }
        }
        self.account = new_account;
    }

    /// Apply the evaluation of `gid`. `start_known` says whether the current
    /// round's start message is present in the evaluated list (false after a
    /// restore until the message is read back).
    pub fn reconcile(
        &mut self,
        gid: &str,
        eligibility: Eligibility,
        eval: &Evaluation,
        start_known: bool,
    ) {
        let current = self.states.get(gid).cloned().unwrap_or_default();
        match eligibility {
            Eligibility::Unknown => return,
            Eligibility::NotEligible(reason) => {
                if let Some(r) = current.round() {
                    self.end(gid, r, reason);
                }
                return;
            }
            Eligibility::Eligible => {}
        }

        match current {
            RoundState::Idle => match &eval.outcome {
                EvalOutcome::NoWait => {}
                EvalOutcome::Wait { start, sufficient } => {
                    if eval.live_evidence {
                        if *sufficient {
                            self.start(gid, Some(start), true);
                        } else {
                            self.start(gid, None, false);
                        }
                    }
                }
                EvalOutcome::Ambiguous { candidate } => {
                    if eval.live_evidence {
                        self.start(gid, Some(candidate), false);
                    }
                }
            },
            RoundState::Waiting(r) => match &eval.outcome {
                EvalOutcome::NoWait => {
                    if Self::may_close(&r, eval, start_known) {
                        self.end(gid, &r, RoundEndReason::MerchantReplyConfirmed);
                    }
                }
                EvalOutcome::Wait { start, sufficient } => {
                    if Self::same_start(&r, start) {
                        return;
                    }
                    if Self::is_earlier(&r, start) {
                        self.confirm_start(gid, r, start, RoundState::Waiting);
                    } else if Self::may_close(&r, eval, start_known) {
                        // The old start was answered; a newer customer
                        // message is waiting.
                        self.end(gid, &r, RoundEndReason::MerchantReplyConfirmed);
                        if eval.live_evidence {
                            if *sufficient {
                                self.start(gid, Some(start), true);
                            } else {
                                self.start(gid, None, false);
                            }
                        }
                    }
                }
                EvalOutcome::Ambiguous { candidate } => {
                    if Self::is_earlier(&r, candidate)
                        || Self::same_start(&r, candidate)
                        || r.start_time_ms.is_none()
                    {
                        let mut next = r.clone();
                        if Self::is_earlier(&r, candidate) {
                            next.start_message_id = candidate.message_id.clone();
                            next.start_time_ms = Some(candidate.create_time_ms);
                        }
                        next.start_confirmed = false;
                        next.version = next.version.saturating_add(1);
                        self.emit_started(gid, &next);
                        self.states
                            .insert(gid.to_string(), RoundState::PendingVerification(next));
                    } else if Self::may_close(&r, eval, start_known) {
                        self.end(gid, &r, RoundEndReason::MerchantReplyConfirmed);
                        if eval.live_evidence {
                            self.start(gid, Some(candidate), false);
                        }
                    }
                }
            },
            RoundState::PendingVerification(r) => match &eval.outcome {
                EvalOutcome::NoWait => {
                    if Self::may_close(&r, eval, start_known) {
                        self.end(gid, &r, RoundEndReason::MerchantReplyConfirmed);
                    }
                }
                EvalOutcome::Wait { start, sufficient } => {
                    if *sufficient {
                        if Self::is_earlier(&r, start)
                            || Self::same_start(&r, start)
                            || !start_known
                            || r.start_message_id.is_none()
                        {
                            self.confirm_start(gid, r, start, RoundState::Waiting);
                        } else if Self::may_close(&r, eval, start_known) {
                            self.end(gid, &r, RoundEndReason::MerchantReplyConfirmed);
                            if eval.live_evidence {
                                self.start(gid, Some(start), true);
                            }
                        }
                    } else if Self::is_earlier(&r, start) {
                        let mut next = r.clone();
                        next.start_message_id = start.message_id.clone();
                        next.start_time_ms = Some(start.create_time_ms);
                        next.version = next.version.saturating_add(1);
                        self.emit_started(gid, &next);
                        self.states
                            .insert(gid.to_string(), RoundState::PendingVerification(next));
                    }
                }
                EvalOutcome::Ambiguous { candidate } => {
                    if Self::is_earlier(&r, candidate) {
                        let mut next = r.clone();
                        next.start_message_id = candidate.message_id.clone();
                        next.start_time_ms = Some(candidate.create_time_ms);
                        next.version = next.version.saturating_add(1);
                        self.emit_started(gid, &next);
                        self.states
                            .insert(gid.to_string(), RoundState::PendingVerification(next));
                    }
                }
            },
        }
    }

    // ---------------------------------------------------------- internals

    fn same_start(r: &Round, c: &StartCandidate) -> bool {
        r.start_message_id.is_some() && r.start_message_id == c.message_id
    }

    fn is_earlier(r: &Round, c: &StartCandidate) -> bool {
        match r.start_time_ms {
            Some(t) => c.create_time_ms < t,
            None => false,
        }
    }

    /// Whether the loaded list is evidence that `r`'s start was answered.
    /// With the start message present, the evaluation already proves it;
    /// otherwise a confirmed reply at or after the start time is required.
    fn may_close(r: &Round, eval: &Evaluation, start_known: bool) -> bool {
        if r.start_message_id.is_some() && start_known {
            return true;
        }
        match (r.start_time_ms, eval.latest_reply_time_ms) {
            (Some(t), Some(lr)) => lr >= t,
            (None, Some(_)) => true,
            (_, None) => false,
        }
    }

    fn make_ref(&self, gid: &str, r: &Round) -> WaitingRoundRef {
        WaitingRoundRef {
            account: self.account.clone(),
            gid: gid.to_string(),
            round_id: r.round_id.clone(),
            version: r.version,
        }
    }

    fn emit_started(&mut self, gid: &str, r: &Round) {
        let round = self.make_ref(gid, r);
        let label = self.label(gid);
        self.events.push(RoundEvent::Started {
            round,
            start_message_id: r.start_message_id.clone(),
            start_time_ms: r.start_time_ms,
            start_confirmed: r.start_confirmed,
            label,
        });
    }

    fn start(&mut self, gid: &str, cand: Option<&StartCandidate>, confirmed: bool) {
        self.seq = self.seq.saturating_add(1);
        let round_id = match cand.and_then(|c| c.message_id.clone()) {
            Some(mid) => format!("{gid}:{mid}"),
            None => format!("{gid}:#{}", self.seq),
        };
        let r = Round {
            round_id,
            version: 1,
            start_message_id: cand.and_then(|c| c.message_id.clone()),
            start_time_ms: cand.map(|c| c.create_time_ms),
            start_confirmed: confirmed,
        };
        self.emit_started(gid, &r);
        let state = if confirmed {
            RoundState::Waiting(r)
        } else {
            RoundState::PendingVerification(r)
        };
        self.states.insert(gid.to_string(), state);
    }

    fn confirm_start(
        &mut self,
        gid: &str,
        mut r: Round,
        start: &StartCandidate,
        wrap: fn(Round) -> RoundState,
    ) {
        r.start_message_id = start.message_id.clone();
        r.start_time_ms = Some(start.create_time_ms);
        r.start_confirmed = true;
        r.version = r.version.saturating_add(1);
        let round = self.make_ref(gid, &r);
        match (&r.start_message_id, r.start_time_ms) {
            (Some(mid), Some(t)) => self.events.push(RoundEvent::StartConfirmed {
                round,
                start_message_id: mid.clone(),
                start_time_ms: t,
            }),
            // A confirmed start without a server id cannot happen for
            // customer messages; fall back to an upsert.
            _ => self.emit_started(gid, &r),
        }
        self.states.insert(gid.to_string(), wrap(r));
    }

    fn end(&mut self, gid: &str, r: &Round, reason: RoundEndReason) {
        let mut ended = r.clone();
        ended.version = ended.version.saturating_add(1);
        let round = self.make_ref(gid, &ended);
        self.events.push(RoundEvent::Ended { round, reason });
        self.states.insert(gid.to_string(), RoundState::Idle);
    }
}

/// Mask an opaque id for display: first two and last two characters kept.
pub fn mask_label(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= 4 {
        return "***".to_string();
    }
    let head: String = chars[..2].iter().collect();
    let tail: String = chars[chars.len() - 2..].iter().collect();
    format!("{head}***{tail}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use contracts::{AccountId, ClockQuality, Environment};

    #[test]
    fn deadline_requires_start_and_trusted_clock() {
        let round = Round {
            round_id: "g:m1".into(),
            version: 1,
            start_message_id: Some("m1".into()),
            start_time_ms: Some(10_000),
            start_confirmed: true,
        };
        let clock = ClockReading {
            server_now_ms: 15_000,
            monotonic_ms: 1_000,
            quality: ClockQuality::Anchored {
                offset_ms: 0,
                error_ms: 50,
            },
        };
        let d = first_t1_deadline(&round, 30, &clock);
        assert_eq!(d.due_at_monotonic_ms, Some(1_000 + 25_000));
        assert!(d.trusted);

        let stale = ClockReading {
            quality: ClockQuality::Stale,
            ..clock
        };
        assert!(!first_t1_deadline(&round, 30, &stale).trusted);

        let unconfirmed = Round {
            start_confirmed: false,
            ..round.clone()
        };
        assert!(!first_t1_deadline(&unconfirmed, 30, &clock).trusted);

        let unknown_start = Round {
            start_time_ms: None,
            ..round.clone()
        };
        let d = first_t1_deadline(&unknown_start, 30, &clock);
        assert_eq!(d.due_at_monotonic_ms, None);
        assert!(!d.trusted);

        // Already overdue: due now, never in the past.
        let late = ClockReading {
            server_now_ms: 100_000,
            ..clock
        };
        assert_eq!(
            first_t1_deadline(&round, 30, &late).due_at_monotonic_ms,
            Some(1_000)
        );
    }

    #[test]
    fn business_line_rules_default_generic() {
        let mut rules = BusinessLineRules::new();
        assert!(BusinessLineRules::is_sampled("1513"));
        assert_eq!(rules.rule_for("1513"), BusinessLineRule::Generic);
        assert_eq!(rules.rule_for("9999"), BusinessLineRule::Generic);
        rules.set("bop", BusinessLineRule::Excluded);
        assert_eq!(rules.rule_for("bop"), BusinessLineRule::Excluded);
        assert_eq!(
            BusinessLineRules::UNVERIFIED_CAR_TIMEOUT_BRANCH,
            "CAR_TIMEOUT"
        );
    }

    #[test]
    fn mask_keeps_edges_only() {
        assert_eq!(mask_label("abcdefg"), "ab***fg");
        assert_eq!(mask_label("abc"), "***");
    }

    #[test]
    fn invalidate_emits_for_every_round_and_drops_state() {
        let ctx = AccountContext::new(AccountId::new("a"), Environment::named("test"), 1);
        let mut t = RoundTracker::new(ctx.clone());
        t.restore_round(PersistedRound {
            gid: "g1".into(),
            round_id: "g1:m1".into(),
            version: 3,
            start_message_id: Some("m1".into()),
            start_time_ms: Some(1),
            start_confirmed: true,
        });
        t.drain_events();
        t.invalidate(ctx.next_generation());
        let ev = t.drain_events();
        assert_eq!(ev.len(), 1);
        assert!(
            matches!(&ev[0], RoundEvent::Invalidated { round } if round.account == ctx && round.gid == "g1")
        );
        assert!(t.state("g1").is_idle());
        assert_eq!(t.account().session_generation, 2);
    }
}

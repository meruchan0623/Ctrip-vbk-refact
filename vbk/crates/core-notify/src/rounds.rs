//! Per-round state (strong-alert §4 "等待轮次", §5 "计时").
//!
//! core-im owns the round itself (start, version, end); this crate only
//! tracks how far the round has escalated and how it has been presented.
//! Everything time-related is stored on the monotonic axis; the server-time
//! anchor used to derive it is kept so that a threshold change or a clock
//! re-verification can recompute the deadline without a new event.

use contracts::{
    AccountContext, AlarmLevel, ReminderSettings, SnoozeMinutes, WaitingRoundRef,
};

use contracts::notify::T2_SECONDS;

use crate::now::Now;

/// L3 → L4 delay in milliseconds.
pub const T2_MS: u64 = T2_SECONDS as u64 * 1000;

/// State of one waiting round as tracked by core-notify.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoundState {
    pub round: WaitingRoundRef,
    /// Desensitized conversation label as delivered by core-im.
    pub label: String,
    /// Server time of the first unanswered customer message, when known.
    pub start_time_ms: Option<i64>,
    /// `false` → "待核对": listed but never escalates past L0.
    pub start_confirmed: bool,
    /// L0 until T1, then L3, then L4 (opt-in). Never L1/L2: those are
    /// new-message channels, not round levels.
    pub level: AlarmLevel,
    /// Monotonic instant at which T1 elapses (or elapsed).
    pub t1_due_monotonic: Option<u64>,
    /// The deadline was derived from an untrusted clock reading.
    pub estimated: bool,
    pub l3_entered_monotonic: Option<u64>,
    pub l4_entered_monotonic: Option<u64>,
    /// The one-shot timeout sound has been played for this round.
    pub l3_sound_played: bool,
    pub l4_sound_count: u32,
    pub last_l4_sound_monotonic: Option<u64>,
    /// The L4 sound cap has been reached and the flash-only phase announced.
    pub l4_cap_flashed: bool,
    pub snoozed_until_monotonic: Option<u64>,
    /// Same expiry on the server axis (for persistence / display).
    pub snoozed_until_ms: Option<i64>,
    /// Version at which the user hid ("清除") this round. Hiding binds to
    /// the round id: later version bumps of the same round stay hidden.
    pub hidden_version: Option<u64>,
    /// Level for which the alarm window was last shown/raised.
    pub raised_for_level: Option<AlarmLevel>,
    /// Level for which the attention-only channel (flash/sound without a
    /// window) was last used.
    pub flashed_for_level: Option<AlarmLevel>,
    /// Came from `restore()` after a restart.
    pub restored: bool,
    /// A `Started`/`StartConfirmed` for this round arrived after restore.
    pub reconfirmed_after_restore: bool,
    pub reminded_once_after_restore: bool,
    /// Monotonic instant the round became known to this core.
    pub created_monotonic: u64,
    /// Time input used for the current deadline computation.
    anchor: Option<Now>,
}

impl RoundState {
    pub(crate) fn new(
        round: WaitingRoundRef,
        label: String,
        start_time_ms: Option<i64>,
        start_confirmed: bool,
        now: &Now,
        t1_ms: u64,
    ) -> Self {
        let mut state = Self {
            round,
            label,
            start_time_ms,
            start_confirmed: start_confirmed && start_time_ms.is_some(),
            level: AlarmLevel::L0,
            t1_due_monotonic: None,
            estimated: false,
            l3_entered_monotonic: None,
            l4_entered_monotonic: None,
            l3_sound_played: false,
            l4_sound_count: 0,
            last_l4_sound_monotonic: None,
            l4_cap_flashed: false,
            snoozed_until_monotonic: None,
            snoozed_until_ms: None,
            hidden_version: None,
            raised_for_level: None,
            flashed_for_level: None,
            restored: false,
            reconfirmed_after_restore: false,
            reminded_once_after_restore: false,
            created_monotonic: now.monotonic_ms,
            anchor: None,
        };
        state.rebase(now, t1_ms);
        state
    }

    pub(crate) fn matches(&self, account: &AccountContext, gid: &str, round_id: &str) -> bool {
        self.round.account == *account && self.round.gid == gid && self.round.round_id == round_id
    }

    pub(crate) fn same_persistent_account(&self, environment: &str, account_id: &str) -> bool {
        self.round.account.environment.as_str() == environment
            && self.round.account.account_id.as_str() == account_id
    }

    /// Recomputes the T1 deadline from `now`. Untrusted readings still
    /// produce a deadline but mark it as an estimate.
    pub(crate) fn rebase(&mut self, now: &Now, t1_ms: u64) {
        self.anchor = Some(*now);
        self.recompute_deadline(t1_ms);
    }

    /// Recomputes the deadline from the stored anchor (threshold change).
    pub(crate) fn recompute_deadline(&mut self, t1_ms: u64) {
        let (Some(start), Some(anchor)) = (self.start_time_ms, self.anchor) else {
            self.t1_due_monotonic = None;
            return;
        };
        let t1 = i64::try_from(t1_ms).unwrap_or(i64::MAX);
        let target = start.saturating_add(t1);
        let delta = target.saturating_sub(anchor.server_now_ms);
        let due = if delta <= 0 {
            anchor.monotonic_ms
        } else {
            anchor
                .monotonic_ms
                .saturating_add(u64::try_from(delta).unwrap_or(u64::MAX))
        };
        self.t1_due_monotonic = Some(due);
        self.estimated = !anchor.clock_trusted;
    }

    /// Advances the time-driven level. Presentation is decided elsewhere.
    pub(crate) fn advance(&mut self, now: &Now, settings: &ReminderSettings) {
        let previous = self.level;
        let due = match (self.start_confirmed, self.t1_due_monotonic) {
            (true, Some(due)) if now.monotonic_ms >= due => due,
            _ => {
                self.level = AlarmLevel::L0;
                return;
            }
        };
        let l3 = *self.l3_entered_monotonic.get_or_insert(due);
        let l4_at = l3.saturating_add(T2_MS);
        if settings.continuous_l4 && now.monotonic_ms >= l4_at {
            self.level = AlarmLevel::L4;
            self.l4_entered_monotonic.get_or_insert(l4_at);
        } else {
            self.level = AlarmLevel::L3;
            self.l4_entered_monotonic = None;
        }
        // Dropping from L4 to L3 (L4 switched off) must not count as a new
        // level change that re-raises the window.
        if previous == AlarmLevel::L4 && self.level == AlarmLevel::L3 {
            if self.raised_for_level == Some(AlarmLevel::L4) {
                self.raised_for_level = Some(AlarmLevel::L3);
            }
            if self.flashed_for_level == Some(AlarmLevel::L4) {
                self.flashed_for_level = Some(AlarmLevel::L3);
            }
        }
    }

    pub(crate) fn snooze(&mut self, now: &Now, minutes: SnoozeMinutes) -> i64 {
        let ms = minutes.as_millis();
        let until_ms = now
            .server_now_ms
            .saturating_add(i64::try_from(ms).unwrap_or(i64::MAX));
        self.snoozed_until_monotonic = Some(now.monotonic_ms.saturating_add(ms));
        self.snoozed_until_ms = Some(until_ms);
        until_ms
    }

    /// Clears an elapsed snooze and arms the round for one more raise.
    pub(crate) fn expire_snooze(&mut self, now: &Now) {
        if let Some(until) = self.snoozed_until_monotonic {
            if now.monotonic_ms >= until {
                self.snoozed_until_monotonic = None;
                self.snoozed_until_ms = None;
                self.clear_presentation();
            }
        }
    }

    pub(crate) fn hide(&mut self) {
        self.hidden_version = Some(self.round.version);
    }

    pub(crate) fn is_hidden(&self) -> bool {
        self.hidden_version.is_some()
    }

    pub(crate) fn is_snoozed(&self) -> bool {
        self.snoozed_until_monotonic.is_some()
    }

    /// Forget how the round was presented so it can be raised once more.
    pub(crate) fn clear_presentation(&mut self) {
        self.raised_for_level = None;
        self.flashed_for_level = None;
    }

    fn restore_ready(&self, restore_barrier: bool) -> bool {
        !self.restored || (self.reconfirmed_after_restore && !restore_barrier)
    }

    /// Monotonic instant from which the round belongs in the alarm list:
    /// the T1 deadline when a start time is known, otherwise T1 after the
    /// round became known (an unconfirmed "待核对" entry).
    fn listing_due(&self, t1_ms: u64) -> u64 {
        self.t1_due_monotonic
            .unwrap_or_else(|| self.created_monotonic.saturating_add(t1_ms))
    }

    /// Belongs in the alarm snapshot (not hidden, not snoozed, past T1).
    pub(crate) fn is_listed(&self, now: &Now, t1_ms: u64, restore_barrier: bool) -> bool {
        if self.is_hidden() || self.is_snoozed() || !self.restore_ready(restore_barrier) {
            return false;
        }
        if self.start_confirmed {
            self.level >= AlarmLevel::L3
        } else {
            now.monotonic_ms >= self.listing_due(t1_ms)
        }
    }

    /// May drive the alarm window: listed, confirmed and at L3 or above.
    pub(crate) fn is_presentable(&self, now: &Now, t1_ms: u64, restore_barrier: bool) -> bool {
        self.is_listed(now, t1_ms, restore_barrier)
            && self.start_confirmed
            && self.level >= AlarmLevel::L3
    }

    pub(crate) fn waited_seconds(&self, now: &Now) -> u64 {
        match self.start_time_ms {
            Some(start) => {
                let waited = now.server_now_ms.saturating_sub(start).max(0) / 1000;
                u64::try_from(waited).unwrap_or(0)
            }
            None => 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use contracts::{AccountId, Environment};

    fn round() -> WaitingRoundRef {
        WaitingRoundRef {
            account: AccountContext::new(AccountId::new("a"), Environment::production(), 1),
            gid: "g".into(),
            round_id: "r".into(),
            version: 1,
        }
    }

    #[test]
    fn deadline_follows_server_offset_and_threshold() {
        let now = Now::new(100_000, 1_000_000, true);
        let mut r = RoundState::new(round(), "x".into(), Some(990_000), true, &now, 30_000);
        // start + 30 s = 1_020_000 server; 20 s ahead of server now.
        assert_eq!(r.t1_due_monotonic, Some(120_000));
        assert!(!r.estimated);
        r.recompute_deadline(60_000);
        assert_eq!(r.t1_due_monotonic, Some(150_000));
        // Already overdue → due immediately at the anchor.
        let late = Now::new(500, 2_000_000, false);
        r.rebase(&late, 30_000);
        assert_eq!(r.t1_due_monotonic, Some(500));
        assert!(r.estimated);
    }

    #[test]
    fn level_advances_and_l4_needs_opt_in() {
        let now = Now::new(0, 0, true);
        let mut r = RoundState::new(round(), "x".into(), Some(0), true, &now, 30_000);
        let mut s = ReminderSettings::default();
        r.advance(&now.plus_ms(29_999), &s);
        assert_eq!(r.level, AlarmLevel::L0);
        r.advance(&now.plus_ms(30_000), &s);
        assert_eq!(r.level, AlarmLevel::L3);
        r.advance(&now.plus_ms(90_000), &s);
        assert_eq!(r.level, AlarmLevel::L3);
        s.continuous_l4 = true;
        r.advance(&now.plus_ms(89_999), &s);
        assert_eq!(r.level, AlarmLevel::L3);
        r.advance(&now.plus_ms(90_000), &s);
        assert_eq!(r.level, AlarmLevel::L4);
        assert_eq!(r.l4_entered_monotonic, Some(90_000));
        r.raised_for_level = Some(AlarmLevel::L4);
        s.continuous_l4 = false;
        r.advance(&now.plus_ms(91_000), &s);
        assert_eq!(r.level, AlarmLevel::L3);
        assert_eq!(r.raised_for_level, Some(AlarmLevel::L3));
    }

    #[test]
    fn unconfirmed_round_is_listed_after_t1_but_never_presentable() {
        let now = Now::new(1_000, 0, true);
        let mut r = RoundState::new(round(), "x".into(), None, false, &now, 30_000);
        let s = ReminderSettings::default();
        r.advance(&now.plus_ms(60_000), &s);
        assert!(!r.is_listed(&now.plus_ms(29_999), 30_000, false));
        assert!(r.is_listed(&now.plus_ms(30_000), 30_000, false));
        assert!(!r.is_presentable(&now.plus_ms(60_000), 30_000, false));
        assert_eq!(r.level, AlarmLevel::L0);
    }
}

//! The supervisor: a pure `(state, event, now) -> actions` machine.

use crate::counters::{BackoffPolicy, CircuitCounters};
use crate::rng::Rng;
use std::fmt;

// ------------------------------------------------------------------ config

/// Thresholds. Heartbeat numbers follow the official SDK (ping 5 s, 3 misses
/// ~ 20 s, 60 s unconnected); the rest are design choices that are **not**
/// field-verified (see the I-05b acceptance run, a C-class item).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransportConfig {
    pub heartbeat_timeout_ms: u64,
    pub unconnected_timeout_ms: u64,
    /// How long one attempt (in-page compensation / post-rebuild compensation) may wait for proof of life.
    pub attempt_verify_ms: u64,
    pub drain_timeout_ms: u64,
    pub rebuild_timeout_ms: u64,
    pub backoff: BackoffPolicy,
    /// Failed attempts per non-final level before escalating.
    pub attempts_per_level: u32,
    /// Consecutive failures that open the breaker.
    pub breaker_threshold: u32,
    /// Online time after which the failure streak counts as over (anti-flap).
    pub stable_online_ms: u64,
    /// Official compensation start: `now - 2 min`.
    pub compensation_lookback_ms: u64,
    /// Official fast cadence after a (re)connect.
    pub compensation_fast_interval_ms: u64,
    pub compensation_fast_window_ms: u64,
}

impl Default for TransportConfig {
    fn default() -> Self {
        Self {
            heartbeat_timeout_ms: 20_000,
            unconnected_timeout_ms: 60_000,
            attempt_verify_ms: 20_000,
            drain_timeout_ms: 10_000,
            rebuild_timeout_ms: 45_000,
            backoff: BackoffPolicy {
                base_ms: 5_000,
                cap_ms: 120_000,
                jitter_permille: 200,
            },
            attempts_per_level: 3,
            breaker_threshold: 12,
            stable_online_ms: 60_000,
            compensation_lookback_ms: 120_000,
            compensation_fast_interval_ms: 5_000,
            compensation_fast_window_ms: 60_000,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError(pub &'static str);

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid transport config: {}", self.0)
    }
}

impl std::error::Error for ConfigError {}

impl TransportConfig {
    pub fn validate(&self) -> Result<(), ConfigError> {
        let positive = [
            (self.heartbeat_timeout_ms, "heartbeat_timeout_ms"),
            (self.unconnected_timeout_ms, "unconnected_timeout_ms"),
            (self.attempt_verify_ms, "attempt_verify_ms"),
            (self.drain_timeout_ms, "drain_timeout_ms"),
            (self.rebuild_timeout_ms, "rebuild_timeout_ms"),
            (self.backoff.base_ms, "backoff.base_ms"),
            (self.stable_online_ms, "stable_online_ms"),
            (
                self.compensation_fast_interval_ms,
                "compensation_fast_interval_ms",
            ),
        ];
        for (v, name) in positive {
            if v == 0 {
                return Err(ConfigError(name));
            }
        }
        if self.backoff.cap_ms < self.backoff.base_ms {
            return Err(ConfigError("backoff.cap_ms < base_ms"));
        }
        if self.backoff.jitter_permille > 1000 {
            return Err(ConfigError("backoff.jitter_permille > 1000"));
        }
        if self.attempts_per_level == 0 || self.breaker_threshold == 0 {
            return Err(ConfigError("attempts_per_level / breaker_threshold"));
        }
        Ok(())
    }
}

// ------------------------------------------------------------------ vocabulary

/// Escalation levels, in order. `heartbeat timeout` is the trigger, not a level.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Level {
    InPageCompensation,
    ReloadPage,
    RebuildWebview,
}

/// States in which the official SDK will not reconnect, or the account cannot proceed.
/// They are handed to the account state machine (I-13); they are not failures.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TerminalReason {
    /// `KICKED_OFFLINE_BY_OTHER_CLIENT` (`Replaced by new connection`).
    KickedOfflineByOtherClient,
    XmppAuthFailed,
    CurrentTokenUnavailable,
    /// HTTP `AccountsMobileRequestFilterException`.
    AccountsMobileRequestFilterException,
}

impl TerminalReason {
    pub const ALL: [Self; 4] = [
        Self::KickedOfflineByOtherClient,
        Self::XmppAuthFailed,
        Self::CurrentTokenUnavailable,
        Self::AccountsMobileRequestFilterException,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::KickedOfflineByOtherClient => "KICKED_OFFLINE_BY_OTHER_CLIENT",
            Self::XmppAuthFailed => "XMPP_AUTH_FAILED",
            Self::CurrentTokenUnavailable => "CURRENT_TOKEN_UNAVAILABLE",
            Self::AccountsMobileRequestFilterException => "AccountsMobileRequestFilterException",
        }
    }

    /// Exact signal names only (plus the server's literal kick text); anything else is not terminal.
    pub fn from_signal(signal: &str) -> Option<Self> {
        match signal {
            "KICKED_OFFLINE_BY_OTHER_CLIENT" | "Replaced by new connection" => {
                Some(Self::KickedOfflineByOtherClient)
            }
            "XMPP_AUTH_FAILED" => Some(Self::XmppAuthFailed),
            "CURRENT_TOKEN_UNAVAILABLE" => Some(Self::CurrentTokenUnavailable),
            "AccountsMobileRequestFilterException" => {
                Some(Self::AccountsMobileRequestFilterException)
            }
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SdkStatus {
    Connecting,
    Connected,
    Disconnected,
    Reconnecting,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    /// Time passed; call at `next_wakeup()` or any coarser cadence.
    Tick,
    /// Proof of life: any inbound fact, XMPP pong, or HTTP response.
    Alive,
    SdkStatus(SdkStatus),
    /// `navigator.onLine`.
    Network {
        online: bool,
    },
    /// Wake from sleep.
    Resumed,
    Terminal(TerminalReason),
    /// outbound journal has no `started`/`uploading` record left.
    JournalDrained,
    /// Reloaded page / rebuilt WebView finished loading.
    PageReady,
    /// The user pressed the manual retry (breaker open only).
    ManualRetry,
    /// The account state machine re-logged the account after a terminal state.
    AccountRebound,
}

/// What the host must do for a compensation round.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CompensationPlan {
    /// `getRecentMessages.beginMsgTime`.
    pub begin_msg_time_ms: u64,
    pub interval_ms: u64,
    /// After this window the SDK-style cadence (10 s when connected) resumes.
    pub fast_window_ms: u64,
    /// Clear the conversation-list `startTime` so one full pull happens.
    pub reset_conversation_list_cursor: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// A recovery attempt starts; `backoff_ms` is the delay that preceded it (0 for the first of a streak).
    Attempt {
        level: Level,
        failures_before: u32,
        backoff_ms: u64,
    },
    Compensate(CompensationPlan),
    /// Stop accepting `im_send_*` / uploads and wait for the journal to drain.
    BeginDrain,
    /// The drain timed out: in-flight sends become `unknown`, never replayed.
    AbortInflightAsUnknown,
    CancelDrain,
    ReloadPage,
    RebuildWebview,
    ShowChannelAbnormal,
    ClearChannelAbnormal,
    /// Hand over to the account state machine; no reconnect follows.
    NotifyTerminal(TerminalReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Online,
    /// In-page compensation attempt outstanding.
    Awaiting {
        deadline_ms: u64,
    },
    Backoff {
        until_ms: u64,
    },
    Draining {
        level: Level,
        deadline_ms: u64,
    },
    Rebuilding {
        level: Level,
        deadline_ms: u64,
    },
    /// Post reload/rebuild compensation, waiting for proof of life.
    Compensating {
        deadline_ms: u64,
    },
    Tripped,
    Terminal(TerminalReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RejectReason {
    /// `im.channel_recovering`
    ChannelRecovering,
    ChannelAbnormal,
    Terminal(TerminalReason),
}

impl RejectReason {
    /// Host error code. Only `im.channel_recovering` is specified by the plan; the others are placeholders.
    pub fn code(self) -> &'static str {
        match self {
            Self::ChannelRecovering => "im.channel_recovering",
            Self::ChannelAbnormal | Self::Terminal(_) => "im.channel_unavailable",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendGate {
    Open,
    Reject(RejectReason),
}

// ------------------------------------------------------------------ supervisor

#[derive(Debug)]
pub struct Supervisor<R: Rng> {
    cfg: TransportConfig,
    rng: R,
    counters: CircuitCounters,
    phase: Phase,
    last_alive_ms: u64,
    sdk: SdkStatus,
    sdk_since_ms: u64,
    online_since_ms: u64,
    last_fail_ms: Option<u64>,
    /// Start of the latest attempt, even one cancelled by a pong: flapping must not dodge the backoff.
    last_attempt_ms: Option<u64>,
    frozen_since_ms: Option<u64>,
    watermark_ms: Option<u64>,
    fast_until_ms: u64,
    last_now_ms: u64,
}

impl<R: Rng> Supervisor<R> {
    /// New instance for `counters` restored from the host. A non-zero failure
    /// streak keeps its backoff (starts in `Backoff`); an open breaker stays open.
    pub fn new(
        cfg: TransportConfig,
        counters: CircuitCounters,
        rng: R,
        now_ms: u64,
    ) -> Result<Self, ConfigError> {
        cfg.validate()?;
        let phase = if counters.tripped {
            Phase::Tripped
        } else if counters.failures > 0 {
            Phase::Backoff {
                until_ms: now_ms.saturating_add(counters.last_delay_ms),
            }
        } else {
            Phase::Online
        };
        Ok(Self {
            cfg,
            rng,
            counters,
            phase,
            last_alive_ms: now_ms,
            sdk: SdkStatus::Connecting,
            sdk_since_ms: now_ms,
            online_since_ms: now_ms,
            last_fail_ms: None,
            last_attempt_ms: None,
            frozen_since_ms: None,
            watermark_ms: None,
            fast_until_ms: 0,
            last_now_ms: now_ms,
        })
    }

    pub fn counters(&self) -> CircuitCounters {
        self.counters
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }

    pub fn frozen(&self) -> bool {
        self.frozen_since_ms.is_some()
    }

    /// Persisted compensation watermark (largest message time already seen).
    pub fn set_watermark(&mut self, watermark_ms: Option<u64>) {
        self.watermark_ms = watermark_ms;
    }

    /// Level of the next attempt: a pure function of the external failure counter.
    pub fn level_for(&self, failures: u32) -> Level {
        let a = self.cfg.attempts_per_level;
        if failures < a {
            Level::InPageCompensation
        } else if failures < a.saturating_mul(2) {
            Level::ReloadPage
        } else {
            Level::RebuildWebview
        }
    }

    pub fn send_gate(&self) -> SendGate {
        match self.phase {
            Phase::Draining { .. } | Phase::Rebuilding { .. } | Phase::Compensating { .. } => {
                SendGate::Reject(RejectReason::ChannelRecovering)
            }
            Phase::Tripped => SendGate::Reject(RejectReason::ChannelAbnormal),
            Phase::Terminal(r) => SendGate::Reject(RejectReason::Terminal(r)),
            Phase::Online | Phase::Awaiting { .. } | Phase::Backoff { .. } => SendGate::Open,
        }
    }

    /// Compensation cadence for the host's loop: 5 s inside the fast window or while the SDK is not connected, else 10 s.
    pub fn compensation_interval_ms(&self, now_ms: u64) -> u64 {
        if now_ms < self.fast_until_ms || self.sdk != SdkStatus::Connected {
            self.cfg.compensation_fast_interval_ms
        } else {
            self.cfg.compensation_fast_interval_ms.saturating_mul(2)
        }
    }

    /// Earliest time at which a `Tick` can change anything; `None` when frozen, tripped or terminal.
    pub fn next_wakeup_ms(&self) -> Option<u64> {
        if self.frozen_since_ms.is_some() {
            return None;
        }
        match self.phase {
            Phase::Online => {
                let detect = if self.sdk == SdkStatus::Connected {
                    self.last_alive_ms
                        .saturating_add(self.cfg.heartbeat_timeout_ms)
                } else {
                    self.sdk_since_ms
                        .saturating_add(self.cfg.unconnected_timeout_ms)
                };
                if self.counters.failures > 0 {
                    Some(
                        detect.min(
                            self.online_since_ms
                                .saturating_add(self.cfg.stable_online_ms),
                        ),
                    )
                } else {
                    Some(detect)
                }
            }
            Phase::Awaiting { deadline_ms }
            | Phase::Draining { deadline_ms, .. }
            | Phase::Rebuilding { deadline_ms, .. }
            | Phase::Compensating { deadline_ms } => Some(deadline_ms),
            Phase::Backoff { until_ms } => Some(until_ms),
            Phase::Tripped | Phase::Terminal(_) => None,
        }
    }

    pub fn handle(&mut self, now_ms: u64, event: Event) -> Vec<Action> {
        let now = now_ms.max(self.last_now_ms);
        self.last_now_ms = now;

        if let Phase::Terminal(_) = self.phase {
            // Terminal: zero reconnect actions, counters untouched, until the account is rebound.
            // The network flag is still tracked so a rebound while offline stays frozen.
            match event {
                Event::AccountRebound => {
                    self.phase = if self.counters.tripped {
                        Phase::Tripped
                    } else {
                        Phase::Online
                    };
                    self.last_alive_ms = now;
                    self.online_since_ms = now;
                    self.sdk = SdkStatus::Connecting;
                    self.sdk_since_ms = now;
                    if self.frozen_since_ms.is_some() {
                        self.frozen_since_ms = Some(now);
                    }
                }
                Event::Network { online: false } if self.frozen_since_ms.is_none() => {
                    self.frozen_since_ms = Some(now);
                }
                Event::Network { online: true } => self.frozen_since_ms = None,
                _ => {}
            }
            return Vec::new();
        }
        match event {
            Event::Terminal(reason) => {
                self.phase = Phase::Terminal(reason);
                return vec![Action::NotifyTerminal(reason)];
            }
            Event::Network { online } => return self.on_network(now, online),
            _ => {}
        }
        if self.frozen_since_ms.is_some() {
            // Offline: nothing counts, no timers run.
            match event {
                Event::Alive => self.last_alive_ms = now,
                Event::SdkStatus(s) => self.set_sdk(now, s),
                _ => {}
            }
            return Vec::new();
        }
        match event {
            Event::Tick => self.on_tick(now),
            Event::Alive => self.on_alive(now),
            Event::SdkStatus(s) => self.on_sdk(now, s),
            Event::Resumed => self.on_resumed(now),
            Event::JournalDrained => match self.phase {
                Phase::Draining { level, .. } => self.finish_drain(now, level, false),
                _ => Vec::new(),
            },
            Event::PageReady => match self.phase {
                Phase::Rebuilding { .. } => {
                    self.phase = Phase::Compensating {
                        deadline_ms: now.saturating_add(self.cfg.attempt_verify_ms),
                    };
                    vec![Action::Compensate(self.plan(now))]
                }
                _ => Vec::new(),
            },
            Event::ManualRetry => match self.phase {
                Phase::Tripped => {
                    self.counters.failures = 0;
                    self.counters.last_delay_ms = 0;
                    self.counters.tripped = false;
                    self.last_fail_ms = None;
                    self.last_attempt_ms = None;
                    let mut out = vec![Action::ClearChannelAbnormal];
                    out.extend(self.start_attempt(now));
                    out
                }
                _ => Vec::new(),
            },
            Event::AccountRebound | Event::Terminal(_) | Event::Network { .. } => Vec::new(),
        }
    }

    // -------------------------------------------------------------- internals

    fn plan(&mut self, now: u64) -> CompensationPlan {
        let mut begin = now.saturating_sub(self.cfg.compensation_lookback_ms);
        // Never start later than the persisted watermark: a long outage must not skip messages.
        if let Some(w) = self.watermark_ms {
            begin = begin.min(w);
        }
        self.fast_until_ms = now.saturating_add(self.cfg.compensation_fast_window_ms);
        CompensationPlan {
            begin_msg_time_ms: begin,
            interval_ms: self.cfg.compensation_fast_interval_ms,
            fast_window_ms: self.cfg.compensation_fast_window_ms,
            reset_conversation_list_cursor: true,
        }
    }

    fn set_sdk(&mut self, now: u64, s: SdkStatus) {
        if s != self.sdk {
            self.sdk = s;
            self.sdk_since_ms = now;
        }
    }

    fn set_online(&mut self, now: u64) {
        self.phase = Phase::Online;
        self.online_since_ms = now;
        self.last_alive_ms = now;
    }

    fn on_tick(&mut self, now: u64) -> Vec<Action> {
        match self.phase {
            Phase::Online => {
                let timed_out = if self.sdk == SdkStatus::Connected {
                    now.saturating_sub(self.last_alive_ms) >= self.cfg.heartbeat_timeout_ms
                } else {
                    now.saturating_sub(self.sdk_since_ms) >= self.cfg.unconnected_timeout_ms
                };
                if !timed_out {
                    if self.counters.failures > 0
                        && now.saturating_sub(self.online_since_ms) >= self.cfg.stable_online_ms
                    {
                        // Stable long enough *with* proof of life: the streak is over (anti-flap).
                        // Evaluated only when not timed out, so a coarse tick landing on both
                        // boundaries at once cannot erase the streak with a period of silence.
                        self.counters.failures = 0;
                        self.counters.last_delay_ms = 0;
                        self.last_fail_ms = None;
                        self.last_attempt_ms = None;
                    }
                    return Vec::new();
                }
                if self.counters.failures == 0 {
                    return self.start_attempt(now);
                }
                let anchor = self.last_fail_ms.max(self.last_attempt_ms).unwrap_or(now);
                let until = anchor.saturating_add(self.counters.last_delay_ms).max(now);
                if until <= now {
                    self.start_attempt(now)
                } else {
                    self.phase = Phase::Backoff { until_ms: until };
                    Vec::new()
                }
            }
            Phase::Awaiting { deadline_ms }
            | Phase::Rebuilding { deadline_ms, .. }
            | Phase::Compensating { deadline_ms } => {
                if now >= deadline_ms {
                    self.fail(now)
                } else {
                    Vec::new()
                }
            }
            Phase::Draining { level, deadline_ms } => {
                if now >= deadline_ms {
                    self.finish_drain(now, level, true)
                } else {
                    Vec::new()
                }
            }
            Phase::Backoff { until_ms } => {
                if now >= until_ms {
                    self.start_attempt(now)
                } else {
                    Vec::new()
                }
            }
            Phase::Tripped | Phase::Terminal(_) => Vec::new(),
        }
    }

    fn on_alive(&mut self, now: u64) -> Vec<Action> {
        self.last_alive_ms = now;
        match self.phase {
            Phase::Awaiting { .. } | Phase::Backoff { .. } | Phase::Compensating { .. } => {
                self.set_online(now);
                Vec::new()
            }
            Phase::Draining { .. } => {
                self.set_online(now);
                vec![Action::CancelDrain]
            }
            Phase::Tripped => {
                self.counters.tripped = false;
                self.set_online(now);
                vec![Action::ClearChannelAbnormal]
            }
            // A stale signal from the page being replaced proves nothing.
            Phase::Rebuilding { .. } | Phase::Online | Phase::Terminal(_) => Vec::new(),
        }
    }

    fn on_sdk(&mut self, now: u64, s: SdkStatus) -> Vec<Action> {
        let reconnected = s == SdkStatus::Connected && self.sdk != SdkStatus::Connected;
        self.set_sdk(now, s);
        if !reconnected {
            return Vec::new();
        }
        match self.phase {
            Phase::Online | Phase::Awaiting { .. } | Phase::Backoff { .. } => {
                let mut out = vec![Action::Compensate(self.plan(now))];
                out.extend(self.on_alive(now));
                out
            }
            _ => Vec::new(),
        }
    }

    fn on_resumed(&mut self, now: u64) -> Vec<Action> {
        // Wall-clock jumped across the sleep: neither the heartbeat nor an
        // outstanding verify/rebuild window may read the gap as a failure.
        match self.phase {
            Phase::Online | Phase::Backoff { .. } => {
                self.last_alive_ms = now;
                self.sdk_since_ms = now;
                vec![Action::Compensate(self.plan(now))]
            }
            Phase::Awaiting { .. } => {
                self.last_alive_ms = now;
                self.sdk_since_ms = now;
                self.phase = Phase::Awaiting {
                    deadline_ms: now.saturating_add(self.cfg.attempt_verify_ms),
                };
                vec![Action::Compensate(self.plan(now))]
            }
            Phase::Compensating { .. } => {
                self.phase = Phase::Compensating {
                    deadline_ms: now.saturating_add(self.cfg.attempt_verify_ms),
                };
                vec![Action::Compensate(self.plan(now))]
            }
            Phase::Rebuilding { level, .. } => {
                self.phase = Phase::Rebuilding {
                    level,
                    deadline_ms: now.saturating_add(self.cfg.rebuild_timeout_ms),
                };
                Vec::new()
            }
            // Draining keeps its hard 10 s bound; tripped/terminal do nothing.
            Phase::Draining { .. } | Phase::Tripped | Phase::Terminal(_) => Vec::new(),
        }
    }

    fn on_network(&mut self, now: u64, online: bool) -> Vec<Action> {
        if !online {
            if self.frozen_since_ms.is_none() {
                self.frozen_since_ms = Some(now);
            }
            return Vec::new();
        }
        let Some(since) = self.frozen_since_ms.take() else {
            return Vec::new();
        };
        let shift = now.saturating_sub(since);
        self.phase = match self.phase {
            Phase::Awaiting { deadline_ms } => Phase::Awaiting {
                deadline_ms: deadline_ms.saturating_add(shift),
            },
            Phase::Backoff { until_ms } => Phase::Backoff {
                until_ms: until_ms.saturating_add(shift),
            },
            Phase::Draining { level, deadline_ms } => Phase::Draining {
                level,
                deadline_ms: deadline_ms.saturating_add(shift),
            },
            Phase::Rebuilding { level, deadline_ms } => Phase::Rebuilding {
                level,
                deadline_ms: deadline_ms.saturating_add(shift),
            },
            Phase::Compensating { deadline_ms } => Phase::Compensating {
                deadline_ms: deadline_ms.saturating_add(shift),
            },
            other => other,
        };
        self.online_since_ms = self.online_since_ms.saturating_add(shift);
        self.last_fail_ms = self.last_fail_ms.map(|t| t.saturating_add(shift));
        self.last_attempt_ms = self.last_attempt_ms.map(|t| t.saturating_add(shift));
        self.last_alive_ms = now;
        self.sdk_since_ms = now;
        match self.phase {
            Phase::Online | Phase::Awaiting { .. } | Phase::Backoff { .. } => {
                vec![Action::Compensate(self.plan(now))]
            }
            _ => Vec::new(),
        }
    }

    fn start_attempt(&mut self, now: u64) -> Vec<Action> {
        let failures = self.counters.failures;
        let level = self.level_for(failures);
        let backoff_ms = if failures == 0 {
            0
        } else {
            self.counters.last_delay_ms
        };
        self.last_attempt_ms = Some(now);
        let mut out = vec![Action::Attempt {
            level,
            failures_before: failures,
            backoff_ms,
        }];
        match level {
            Level::InPageCompensation => {
                self.phase = Phase::Awaiting {
                    deadline_ms: now.saturating_add(self.cfg.attempt_verify_ms),
                };
                out.push(Action::Compensate(self.plan(now)));
            }
            Level::ReloadPage | Level::RebuildWebview => {
                self.phase = Phase::Draining {
                    level,
                    deadline_ms: now.saturating_add(self.cfg.drain_timeout_ms),
                };
                out.push(Action::BeginDrain);
            }
        }
        out
    }

    fn finish_drain(&mut self, now: u64, level: Level, timed_out: bool) -> Vec<Action> {
        self.phase = Phase::Rebuilding {
            level,
            deadline_ms: now.saturating_add(self.cfg.rebuild_timeout_ms),
        };
        let mut out = Vec::new();
        if timed_out {
            out.push(Action::AbortInflightAsUnknown);
        }
        out.push(if level == Level::ReloadPage {
            Action::ReloadPage
        } else {
            Action::RebuildWebview
        });
        out
    }

    /// An attempt got no proof of life in time: count it, back off, or open the breaker.
    fn fail(&mut self, now: u64) -> Vec<Action> {
        self.counters.failures = self
            .counters
            .failures
            .saturating_add(1)
            .min(self.cfg.breaker_threshold);
        if self.counters.failures >= self.cfg.breaker_threshold {
            self.counters.tripped = true;
            self.counters.trips = self.counters.trips.saturating_add(1);
            self.phase = Phase::Tripped;
            return vec![Action::ShowChannelAbnormal];
        }
        let delay = self.cfg.backoff.next_delay(
            self.counters.failures,
            self.counters.last_delay_ms,
            &mut self.rng,
        );
        self.counters.last_delay_ms = delay;
        self.last_fail_ms = Some(now);
        self.phase = Phase::Backoff {
            until_ms: now.saturating_add(delay),
        };
        Vec::new()
    }
}

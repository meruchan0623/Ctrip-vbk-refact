//! Backoff arithmetic and the circuit counters that live outside any instance.

use crate::rng::Rng;
use std::fmt;

/// Exponential backoff with additive jitter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BackoffPolicy {
    pub base_ms: u64,
    pub cap_ms: u64,
    /// Jitter span as parts per thousand of the un-jittered delay.
    pub jitter_permille: u64,
}

impl BackoffPolicy {
    /// Delay before the attempt that follows the `failures`-th failure (`failures >= 1`).
    ///
    /// `min(cap, max(last_delay, min(cap, base * 2^(failures-1)) + jitter))`:
    /// the outer `max` makes the sequence non-decreasing for any jitter draw,
    /// the `min` keeps it within the cap.
    pub fn next_delay(&self, failures: u32, last_delay_ms: u64, rng: &mut dyn Rng) -> u64 {
        let shift = failures.saturating_sub(1).min(32);
        let raw = self.base_ms.saturating_mul(1u64 << shift).min(self.cap_ms);
        let span = raw.saturating_mul(self.jitter_permille) / 1000;
        let jitter = if span == 0 {
            0
        } else {
            rng.next_u64() % (span + 1)
        };
        let candidate = raw.saturating_add(jitter).min(self.cap_ms);
        candidate.max(last_delay_ms).min(self.cap_ms)
    }
}

/// Failure/breaker state. Kept by the host, passed into every new
/// [`crate::Supervisor`] and read back for persistence. The escalation level is
/// derived from `failures`, so nothing else needs to be stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CircuitCounters {
    /// Consecutive failed recovery attempts; reset only after a stable online period or a manual retry.
    pub failures: u32,
    /// Last backoff delay chosen in the current streak (monotonic floor for the next one).
    pub last_delay_ms: u64,
    /// How many times the breaker has opened (diagnostic, never reset).
    pub trips: u32,
    /// Breaker open: UI shows "message channel abnormal", only a manual retry restarts attempts.
    pub tripped: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CountersError {
    Version,
    Field(&'static str),
    Value(&'static str),
}

impl fmt::Display for CountersError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Version => write!(f, "unsupported counters version"),
            Self::Field(n) => write!(f, "missing, duplicate or unknown field {n}"),
            Self::Value(n) => write!(f, "invalid value for {n}"),
        }
    }
}

impl std::error::Error for CountersError {}

impl CircuitCounters {
    pub fn encode(&self) -> String {
        format!(
            "v1;failures={};last_delay_ms={};trips={};tripped={}",
            self.failures,
            self.last_delay_ms,
            self.trips,
            u8::from(self.tripped)
        )
    }

    /// Strict inverse of [`Self::encode`]: unknown version, missing, duplicate or unknown fields are errors.
    pub fn decode(text: &str) -> Result<Self, CountersError> {
        let mut parts = text.split(';');
        if parts.next() != Some("v1") {
            return Err(CountersError::Version);
        }
        let (mut failures, mut last, mut trips, mut tripped) = (None, None, None, None);
        for part in parts {
            let (k, v) = part
                .split_once('=')
                .ok_or(CountersError::Field("key=value"))?;
            match k {
                "failures" if failures.is_none() => {
                    failures = Some(
                        v.parse::<u32>()
                            .map_err(|_| CountersError::Value("failures"))?,
                    )
                }
                "last_delay_ms" if last.is_none() => {
                    last = Some(
                        v.parse::<u64>()
                            .map_err(|_| CountersError::Value("last_delay_ms"))?,
                    )
                }
                "trips" if trips.is_none() => {
                    trips = Some(
                        v.parse::<u32>()
                            .map_err(|_| CountersError::Value("trips"))?,
                    )
                }
                "tripped" if tripped.is_none() => {
                    tripped = Some(match v {
                        "0" => false,
                        "1" => true,
                        _ => return Err(CountersError::Value("tripped")),
                    });
                }
                _ => return Err(CountersError::Field("duplicate or unknown")),
            }
        }
        Ok(Self {
            failures: failures.ok_or(CountersError::Field("failures"))?,
            last_delay_ms: last.ok_or(CountersError::Field("last_delay_ms"))?,
            trips: trips.ok_or(CountersError::Field("trips"))?,
            tripped: tripped.ok_or(CountersError::Field("tripped"))?,
        })
    }
}

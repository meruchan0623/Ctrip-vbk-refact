//! The time input every call receives from the host.
//!
//! core-notify owns no clock: the host passes a [`Now`] built from
//! core-net's `ClockReading` (strong-alert §5). Deadlines and snooze expiry
//! are tracked on the monotonic axis; display values (`waited_seconds`,
//! `generated_at_ms`) use the server axis.

use contracts::ClockReading;

/// A point in time as seen by the host when it calls into the core.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Now {
    /// Monotonic milliseconds since process start (never goes backwards).
    pub monotonic_ms: u64,
    /// Estimated current server time (Unix ms).
    pub server_now_ms: i64,
    /// Whether `server_now_ms` comes from a verified anchor. When false the
    /// core still computes deadlines but flags them as estimates.
    pub clock_trusted: bool,
}

impl Now {
    pub const fn new(monotonic_ms: u64, server_now_ms: i64, clock_trusted: bool) -> Self {
        Self {
            monotonic_ms,
            server_now_ms,
            clock_trusted,
        }
    }

    /// Builds a `Now` from core-net's reading.
    pub fn from_reading(reading: &ClockReading) -> Self {
        Self {
            monotonic_ms: reading.monotonic_ms,
            server_now_ms: reading.server_now_ms,
            clock_trusted: reading.trusted(),
        }
    }

    /// The same instant `ms` later on both axes. Handy for hosts that drive
    /// a 1 Hz tick from one anchor, and for deterministic tests.
    pub fn plus_ms(self, ms: u64) -> Self {
        let server_delta = i64::try_from(ms).unwrap_or(i64::MAX);
        Self {
            monotonic_ms: self.monotonic_ms.saturating_add(ms),
            server_now_ms: self.server_now_ms.saturating_add(server_delta),
            clock_trusted: self.clock_trusted,
        }
    }
}

//! Clock contracts consumed by core-im and core-notify; owned by core-net's
//! `ClockService` (archive §2.1 rule 2, strong-alert §5).
//!
//! The anchor is server message time + verified server/local offset; time
//! then advances on a monotonic clock. When the anchor is missing or stale,
//! deadlines are shown as estimates / "pending verification", never as a
//! platform countdown.

/// Quality of the current time anchor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClockQuality {
    /// Anchor verified: `offset_ms = server - local_wall` with `error_ms`
    /// bound.
    Anchored { offset_ms: i64, error_ms: u64 },
    /// Anchor exists but has expired or a wall-clock jump / sleep was
    /// detected; values are estimates until re-verified.
    Stale,
    /// No anchor yet.
    Unanchored,
}

impl ClockQuality {
    pub fn is_trusted(&self) -> bool {
        matches!(self, ClockQuality::Anchored { .. })
    }
}

/// A reading handed to consumers: estimated server time now plus quality.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClockReading {
    /// Estimated current server time in Unix milliseconds.
    pub server_now_ms: i64,
    /// Monotonic milliseconds since process start (never goes backwards).
    pub monotonic_ms: u64,
    pub quality: ClockQuality,
}

impl ClockReading {
    pub fn trusted(&self) -> bool {
        self.quality.is_trusted()
    }
}

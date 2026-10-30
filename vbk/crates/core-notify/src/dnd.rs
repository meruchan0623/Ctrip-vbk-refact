//! Application-level do-not-disturb (strong-alert §2 "勿扰").
//!
//! The tray offers "勿扰 1 小时 / 直到明天"; the host converts both into an
//! absolute server-time expiry so the core stays clock-free. A scheduled
//! quiet window (e.g. 22:00–08:00) is expressed the same way by the host.

/// Do-not-disturb mode selected from the tray.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DndMode {
    #[default]
    Off,
    /// "勿扰 1 小时": active until `until_ms` (server time).
    OneHour { until_ms: i64 },
    /// "直到明天": active until `until_ms` (server time, next morning).
    UntilTomorrow { until_ms: i64 },
}

/// Length of the "one hour" option, for hosts building `OneHour`.
pub const DND_ONE_HOUR_MS: i64 = 60 * 60 * 1000;

impl DndMode {
    /// Expiry in server milliseconds, if any.
    pub fn until_ms(&self) -> Option<i64> {
        match self {
            DndMode::Off => None,
            DndMode::OneHour { until_ms } | DndMode::UntilTomorrow { until_ms } => Some(*until_ms),
        }
    }

    /// Whether DND is in force at `server_now_ms`. An expired mode is
    /// simply inactive; the host may replace it with `Off` at its leisure.
    pub fn is_active(&self, server_now_ms: i64) -> bool {
        self.until_ms().is_some_and(|until| until > server_now_ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_until_expiry() {
        assert!(!DndMode::Off.is_active(0));
        let m = DndMode::OneHour { until_ms: 1_000 };
        assert!(m.is_active(999));
        assert!(!m.is_active(1_000));
        assert_eq!(DndMode::UntilTomorrow { until_ms: 5 }.until_ms(), Some(5));
    }
}

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

/// Local hour at which "直到明天" ends.
pub const DND_TOMORROW_HOUR: i64 = 8;

const DAY_MS: i64 = 86_400_000;

/// Next local `hour`:00 strictly after `now_ms`, as an absolute UTC epoch
/// millisecond instant. `utc_offset_minutes` is the local zone's offset at
/// `now_ms` (east positive, e.g. +480 for Beijing). Pure: the host reads the
/// zone, the core only does the day-boundary arithmetic (floor division, so
/// instants before the epoch and negative offsets are handled). The offset
/// is taken as constant over the next 24 h; a DST switch inside that window
/// shifts the result by the switch amount, which is accepted for a DND edge.
pub fn next_local_hour_ms(now_ms: i64, utc_offset_minutes: i32, hour: i64) -> i64 {
    let offset_ms = i64::from(utc_offset_minutes) * 60_000;
    let local_now = now_ms.saturating_add(offset_ms);
    let day_start = local_now.div_euclid(DAY_MS) * DAY_MS;
    let mut target_local = day_start + hour.clamp(0, 23) * 3_600_000;
    if target_local <= local_now {
        target_local += DAY_MS;
    }
    target_local - offset_ms
}

/// Expiry for the tray's "直到明天": the next local 08:00.
pub fn dnd_until_tomorrow_ms(now_ms: i64, utc_offset_minutes: i32) -> i64 {
    next_local_hour_ms(now_ms, utc_offset_minutes, DND_TOMORROW_HOUR)
}

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

    const H: i64 = 3_600_000;
    // 2024-01-01T00:00:00Z
    const T0: i64 = 1_704_067_200_000;

    #[test]
    fn beijing_afternoon_ends_next_local_morning_not_16_00() {
        // 2024-01-01 10:00 Beijing = 02:00Z. Old code: next UTC midnight + 8h
        // = Jan 2 08:00Z = 16:00 Beijing. Correct: Jan 2 08:00 Beijing = Jan 2 00:00Z.
        let now = T0 + 2 * H;
        assert_eq!(dnd_until_tomorrow_ms(now, 480), T0 + 24 * H);
    }

    #[test]
    fn before_eight_local_ends_same_morning() {
        // 03:00 Beijing (Dec 31 19:00Z) -> 08:00 Beijing the same day.
        let now = T0 - 5 * H;
        assert_eq!(dnd_until_tomorrow_ms(now, 480), T0);
    }

    #[test]
    fn exactly_eight_rolls_to_next_day() {
        assert_eq!(dnd_until_tomorrow_ms(T0, 480), T0 + 24 * H);
    }

    #[test]
    fn negative_and_zero_offsets() {
        // New York (-300) 2024-01-01 20:00 = Jan 2 01:00Z -> Jan 2 08:00 NY = 13:00Z.
        assert_eq!(dnd_until_tomorrow_ms(T0 + 25 * H, -300), T0 + 37 * H);
        assert_eq!(dnd_until_tomorrow_ms(T0 + 2 * H, 0), T0 + 8 * H);
    }

    #[test]
    fn result_is_always_future_and_within_24h() {
        for off in [-720, -300, 0, 330, 480, 765, 840] {
            for step in 0..96 {
                let now = T0 + step * (H / 4) + 12_345;
                let r = dnd_until_tomorrow_ms(now, off);
                assert!(r > now && r - now <= 24 * H, "off {off} step {step}");
                let local = r + i64::from(off) * 60_000;
                assert_eq!(local.rem_euclid(DAY_MS), 8 * H);
            }
        }
    }

    #[test]
    fn pre_epoch_floor_division() {
        assert_eq!(next_local_hour_ms(-1, 0, 8), 8 * H);
    }
}

//! Local-night DND policy, independent of the server-calibrated reminder clock.
//! A tray cancellation is boot-local: persisted `schedule_enabled` restores on restart.
use core_notify::DndMode;

const HOUR_MS: i64 = 3_600_000;
const DAY_MS: i64 = 24 * HOUR_MS;

#[derive(Debug, Default)]
pub(super) struct DndController {
    manual: DndMode,
    enabled: bool,
    paused_window: Option<i64>,
}

impl DndController {
    pub fn set_enabled(&mut self, enabled: bool) {
        if self.enabled != enabled {
            self.enabled = enabled;
            self.paused_window = None;
        }
    }

    pub fn set_manual(&mut self, mode: DndMode) {
        self.manual = mode;
    }

    pub fn clear(&mut self, wall_ms: i64, offset_minutes: i32) {
        self.manual = DndMode::Off;
        if !self.enabled {
            self.paused_window = None;
        } else if let Some(current) = window(wall_ms, offset_minutes) {
            self.paused_window = Some(current);
        }
        // Repeated tray-off during a rollback into daytime must not revoke
        // an existing pause. With no prior token, daytime still pauses nothing.
    }

    pub fn effective(&mut self, wall_ms: i64, offset_minutes: i32, server_ms: i64) -> DndMode {
        let current = window(wall_ms, offset_minutes);
        // A clock rollback or temporary zone change can revisit the same night.
        // Daytime alone does not prove that a different scheduled window began.
        if current.is_some() && self.paused_window != current {
            self.paused_window = None;
        }
        if !self.manual.is_active(server_ms) {
            self.manual = DndMode::Off;
        }
        if self.enabled && current.is_some() && current != self.paused_window {
            DndMode::Scheduled
        } else {
            self.manual
        }
    }
}

/// Identity is the local calendar day on which this 22:00–08:00 window starts.
/// Re-read the current offset at every evaluation; DST changes do not move the
/// local 08:00 edge or lose a cancellation within the same overnight window.
fn window(wall_ms: i64, offset_minutes: i32) -> Option<i64> {
    let local_ms = wall_ms.saturating_add(i64::from(offset_minutes) * 60_000);
    let day = local_ms.div_euclid(DAY_MS);
    match local_ms.rem_euclid(DAY_MS) {
        t if t >= 22 * HOUR_MS => Some(day),
        t if t < 8 * HOUR_MS => Some(day - 1),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const H: i64 = HOUR_MS;
    fn enabled() -> DndController {
        let mut d = DndController::default();
        d.set_enabled(true);
        d
    }
    #[test]
    fn exact_edges_and_midnight() {
        let mut d = enabled();
        for (wall, expected) in [
            (22 * H - 1, false),
            (22 * H, true),
            (24 * H, true),
            (32 * H - 1, true),
            (32 * H, false),
            (46 * H, true),
        ] {
            assert_eq!(d.effective(wall, 0, wall).is_active(wall), expected);
        }
        assert_eq!(window(22 * H, 0), window(31 * H, 0));
    }
    #[test]
    fn local_clock_is_independent_of_stale_server_clock_and_sleep() {
        let mut d = enabled();
        assert_eq!(d.effective(22 * H, 0, 0), DndMode::Scheduled);
        assert_eq!(d.effective(33 * H, 0, 0), DndMode::Off);
        assert_eq!(d.effective(70 * H, 0, -100 * H), DndMode::Scheduled);
    }
    #[test]
    fn offset_changes_and_non_integral_offsets() {
        let mut d = enabled();
        assert_eq!(d.effective(14 * H, 480, 0), DndMode::Scheduled);
        assert_eq!(d.effective(14 * H, 0, 0), DndMode::Off);
        assert_eq!(d.effective(16 * H + H / 2, 330, 0), DndMode::Scheduled);
        assert_eq!(d.effective(27 * H, -300, 0), DndMode::Scheduled);
        assert_eq!(window(-1, 0), Some(-1));
    }
    #[test]
    fn spring_forward_and_fall_back_end_at_local_eight() {
        for (before, after) in [(-300, -240), (-240, -300)] {
            let mut d = enabled();
            assert_eq!(
                d.effective(25 * H - i64::from(before) * 60_000, before, 0),
                DndMode::Scheduled
            );
            let end = 32 * H - i64::from(after) * 60_000;
            assert_eq!(d.effective(end - 1, after, 0), DndMode::Scheduled);
            assert_eq!(d.effective(end, after, 0), DndMode::Off);
        }
    }
    #[test]
    fn manual_survives_window_end_and_expires_independently() {
        let mut d = enabled();
        d.set_manual(DndMode::OneHour { until_ms: 34 * H });
        assert_eq!(d.effective(31 * H, 0, 31 * H), DndMode::Scheduled);
        assert_eq!(
            d.effective(32 * H, 0, 32 * H),
            DndMode::OneHour { until_ms: 34 * H }
        );
        assert_eq!(d.effective(34 * H, 0, 34 * H), DndMode::Off);
        d.set_manual(DndMode::UntilTomorrow { until_ms: 47 * H });
        assert_eq!(d.effective(46 * H, 0, 46 * H), DndMode::Scheduled);
        assert_eq!(d.effective(47 * H, 0, 47 * H), DndMode::Scheduled);
        assert_eq!(d.effective(56 * H, 0, 56 * H), DndMode::Off);
    }
    #[test]
    fn tray_clear_pauses_current_window_only_and_clears_manual() {
        let mut d = enabled();
        d.set_manual(DndMode::OneHour { until_ms: 100 * H });
        d.clear(23 * H, 0);
        for wall in [23 * H, 24 * H, 31 * H, 32 * H] {
            assert_eq!(d.effective(wall, 0, wall), DndMode::Off);
        }
        // Even if the machine sleeps through the intervening daytime.
        assert_eq!(d.effective(46 * H, 0, 46 * H), DndMode::Scheduled);
    }
    #[test]
    fn cancellation_survives_dst_and_manual_reenable_does_not_restore_schedule() {
        let mut d = enabled();
        d.clear(27 * H, -300); // local 22:00
        assert_eq!(d.effective(30 * H, -240, 0), DndMode::Off);
        d.set_manual(DndMode::OneHour { until_ms: H });
        assert_eq!(
            d.effective(30 * H, -240, 0),
            DndMode::OneHour { until_ms: H }
        );
        assert_eq!(d.effective(31 * H, -240, H), DndMode::Off);
    }
    #[test]
    fn same_value_retry_is_idempotent_but_toggle_and_restart_restore() {
        let mut d = enabled();
        d.clear(23 * H, 0);
        d.set_enabled(true);
        assert_eq!(d.effective(23 * H, 0, 0), DndMode::Off);
        d.set_enabled(false);
        d.set_enabled(true);
        assert_eq!(d.effective(23 * H, 0, 0), DndMode::Scheduled);
        d.clear(23 * H, 0);
        let mut restarted = enabled();
        assert_eq!(restarted.effective(23 * H, 0, 0), DndMode::Scheduled);
    }
    #[test]
    fn rollback_before_twenty_two_does_not_forget_paused_night() {
        let mut d = enabled();
        d.clear(22 * H + 60_000, 0);
        assert_eq!(d.effective(22 * H - 60_000, 0, 0), DndMode::Off);
        assert_eq!(d.effective(22 * H, 0, 0), DndMode::Off);
        assert_eq!(d.effective(31 * H, 0, 0), DndMode::Off);
        assert_eq!(d.effective(46 * H, 0, 0), DndMode::Scheduled);
    }

    #[test]
    fn temporary_daytime_timezone_does_not_forget_paused_night() {
        let mut d = enabled();
        d.clear(14 * H + 60_000, 480); // local 22:01
        assert_eq!(d.effective(14 * H + 60_000, 0, 0), DndMode::Off);
        assert_eq!(d.effective(14 * H + 60_000, 480, 0), DndMode::Off);
        assert_eq!(d.effective(38 * H, 480, 0), DndMode::Scheduled);
    }

    #[test]
    fn repeated_tray_off_during_rollback_preserves_same_night_pause() {
        let mut d = enabled();
        d.clear(22 * H + 60_000, 0);
        assert_eq!(d.effective(22 * H - 60_000, 0, 0), DndMode::Off);
        d.clear(22 * H - 60_000, 0);
        assert_eq!(d.effective(22 * H, 0, 0), DndMode::Off);
        assert_eq!(d.effective(46 * H, 0, 0), DndMode::Scheduled);
    }

    #[test]
    fn repeated_tray_off_in_temporary_daytime_zone_preserves_same_night_pause() {
        let mut d = enabled();
        d.clear(14 * H + 60_000, 480);
        assert_eq!(d.effective(14 * H + 60_000, 0, 0), DndMode::Off);
        d.clear(14 * H + 60_000, 0);
        assert_eq!(d.effective(14 * H + 60_000, 480, 0), DndMode::Off);
        assert_eq!(d.effective(38 * H, 480, 0), DndMode::Scheduled);
    }

    #[test]
    fn disabling_schedule_keeps_manual_and_daytime_clear_does_not_pause_tonight() {
        let mut d = enabled();
        d.set_manual(DndMode::OneHour { until_ms: H });
        d.set_enabled(false);
        assert_eq!(d.effective(23 * H, 0, 0), DndMode::OneHour { until_ms: H });
        d.set_enabled(true);
        d.clear(12 * H, 0);
        assert_eq!(d.effective(22 * H, 0, 0), DndMode::Scheduled);
    }
}

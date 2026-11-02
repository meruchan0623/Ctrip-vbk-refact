//! Drift-free pacing for the host scheduler thread.
//!
//! The scheduler runs the core tick at 1 Hz. While the tray is flashing it
//! must also toggle the icon every 500 ms. The old loop did the two toggles
//! with blocking `sleep`s of a fixed length after the (variable-cost) tick
//! work, so the real period was `1 s + work`, the tick could not react for a
//! whole second and a stop request was seen up to 1 s late. [`Pacer`] keeps
//! absolute deadlines instead: the core tick stays at 1 Hz in both modes
//! and the flash phase flips on every 500 ms wake.
//!
//! Pure: all times are monotonic milliseconds supplied by the host.

/// Tick period (also the idle wake period).
pub const TICK_MS: i64 = 1000;
/// Flash half-period (tray icon visible/hidden).
pub const FLASH_PHASE_MS: i64 = 500;

/// Deadline bookkeeping for the scheduler loop.
#[derive(Debug, Clone)]
pub struct Pacer {
    deadline_ms: i64,
    /// Parity of wakes while flashing; the tick runs on parity 0.
    odd: bool,
}

impl Pacer {
    pub fn new(now_ms: i64) -> Self {
        Self {
            deadline_ms: now_ms,
            odd: false,
        }
    }

    /// Call at the top of each loop iteration with the flashing state
    /// decided by the previous iteration. Returns whether the core tick
    /// should run on this wake (always when idle; every second wake while
    /// flashing).
    pub fn tick_due(&mut self, was_flashing: bool) -> bool {
        if !was_flashing {
            self.odd = false;
            return true;
        }
        self.odd = !self.odd;
        !self.odd
    }

    /// Milliseconds to sleep before the next wake. Deadlines advance by a
    /// fixed period so work time does not accumulate; after an oversleep
    /// (system suspend, long stall) the schedule restarts from `now_ms`
    /// instead of firing a burst of catch-up wakes.
    pub fn sleep_ms(&mut self, now_ms: i64, flashing: bool) -> u64 {
        let period = if flashing { FLASH_PHASE_MS } else { TICK_MS };
        self.deadline_ms += period;
        if self.deadline_ms <= now_ms {
            self.deadline_ms = now_ms + period;
        }
        u64::try_from(self.deadline_ms - now_ms).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Simulates `seconds` of wall time with `work_ms` of tick cost.
    fn simulate(flashing: bool, work_ms: i64, seconds: i64) -> (u32, u32, i64) {
        let mut p = Pacer::new(0);
        let (mut now, mut ticks, mut wakes) = (0i64, 0u32, 0u32);
        let mut last_tick = 0;
        let mut max_gap = 0;
        while now < seconds * 1000 {
            wakes += 1;
            if p.tick_due(flashing) {
                ticks += 1;
                if ticks > 1 {
                    max_gap = max_gap.max(now - last_tick);
                }
                last_tick = now;
                now += work_ms;
            }
            now += i64::try_from(p.sleep_ms(now, flashing)).unwrap();
        }
        (ticks, wakes, max_gap)
    }

    #[test]
    fn flashing_keeps_one_hz_tick_and_two_hz_phase() {
        let (ticks, wakes, gap) = simulate(true, 120, 60);
        assert!((59..=61).contains(&ticks), "ticks {ticks}");
        assert!((119..=121).contains(&wakes), "wakes {wakes}");
        assert_eq!(gap, 1000, "no drift from tick work");
    }

    #[test]
    fn idle_is_plain_one_hz_without_extra_wakes() {
        let (ticks, wakes, gap) = simulate(false, 120, 60);
        assert_eq!(ticks, wakes);
        assert!((59..=61).contains(&ticks));
        assert_eq!(gap, 1000);
    }

    #[test]
    fn oversleep_restarts_schedule_without_burst() {
        let mut p = Pacer::new(0);
        assert_eq!(p.sleep_ms(0, false), 1000);
        // Machine slept for 10 minutes.
        assert_eq!(p.sleep_ms(600_000, false), 1000);
        // Mode switch keeps the absolute schedule (deadline 601_000 + 500).
        assert_eq!(p.sleep_ms(600_400, true), 1100);
    }

    #[test]
    fn tick_parity_resets_when_flash_stops() {
        let mut p = Pacer::new(0);
        assert!(p.tick_due(false));
        assert!(!p.tick_due(true));
        assert!(p.tick_due(true));
        assert!(!p.tick_due(true));
        assert!(p.tick_due(false));
        assert!(!p.tick_due(true));
    }
}

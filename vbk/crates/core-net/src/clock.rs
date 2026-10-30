//! `ClockService` — the only cross-module time source (plan NET-04, archive
//! 06-net §4.5) — and the `ReconcileCoordinator` generation counter (plan §3
//! "ClockService / ReconcileComplete").
//!
//! Deterministic by construction: the host injects wall-clock, monotonic and
//! round-trip values; nothing here reads `SystemTime` or `Instant`.
//!
//! Anchor model: `server_now ≈ anchored_server_ms + (monotonic_now −
//! anchored_monotonic)`. The wall clock is used only to compute the offset at
//! anchor time and to detect jumps/sleep between readings. After the validity
//! window, or after a suspected jump, readings degrade to `Stale` (estimates
//! still advance on the monotonic clock) until a fresh anchor arrives.

use contracts::{ClockQuality, ClockReading, ReconcileState};

/// Default anchor validity (30 min).
pub const DEFAULT_VALIDITY_MS: u64 = 30 * 60 * 1000;
/// Fixed component of the error bound added to `rtt / 2`.
pub const BASE_ERROR_MS: u64 = 50;
/// `|Δwall − Δmonotonic|` above this between two readings means the wall
/// clock jumped or the machine slept.
pub const JUMP_THRESHOLD_MS: u64 = 2000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Anchor {
    /// `server − local_wall` at anchor time.
    offset_ms: i64,
    error_ms: u64,
    /// Estimated server time at the moment of anchoring.
    server_at_anchor_ms: i64,
    monotonic_at_anchor_ms: u64,
}

/// Owner of time for IM/notify. One instance per environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClockService {
    anchor: Option<Anchor>,
    validity_ms: u64,
    jump_threshold_ms: u64,
    /// Last `(wall, monotonic)` pair seen by `reading`/`anchor`, for jump
    /// detection.
    last_seen: Option<(i64, u64)>,
    /// Sticky until the next anchor.
    jump_detected: bool,
    /// Set by `mark_stale` (network / time-source change) until re-anchored.
    invalidated: bool,
}

impl Default for ClockService {
    fn default() -> Self {
        Self::new(DEFAULT_VALIDITY_MS)
    }
}

impl ClockService {
    pub fn new(validity_ms: u64) -> Self {
        Self {
            anchor: None,
            validity_ms,
            jump_threshold_ms: JUMP_THRESHOLD_MS,
            last_seen: None,
            jump_detected: false,
            invalidated: false,
        }
    }

    pub fn with_jump_threshold(mut self, jump_threshold_ms: u64) -> Self {
        self.jump_threshold_ms = jump_threshold_ms;
        self
    }

    /// Installs a new anchor from a trusted server timestamp.
    ///
    /// * `server_ms` — server time carried by a registered, trusted response
    ///   (e.g. parsed from `ResponseStatus.Timestamp`).
    /// * `local_wall_ms` / `monotonic_ms` — local clocks when the response
    ///   was received.
    /// * `rtt_ms` — request round trip. The server stamp is assumed to be
    ///   `rtt/2` old at receive time; the error bound is `rtt/2 + 50 ms`.
    ///
    /// Returns the resulting offset and error bound.
    pub fn anchor_from_server(
        &mut self,
        server_ms: i64,
        local_wall_ms: i64,
        monotonic_ms: u64,
        rtt_ms: u64,
    ) -> (i64, u64) {
        let half_rtt = rtt_ms / 2;
        let server_at_receive = server_ms.saturating_add(half_rtt as i64);
        let offset_ms = server_at_receive.saturating_sub(local_wall_ms);
        let error_ms = half_rtt + BASE_ERROR_MS;
        self.anchor = Some(Anchor {
            offset_ms,
            error_ms,
            server_at_anchor_ms: server_at_receive,
            monotonic_at_anchor_ms: monotonic_ms,
        });
        self.last_seen = Some((local_wall_ms, monotonic_ms));
        self.jump_detected = false;
        self.invalidated = false;
        (offset_ms, error_ms)
    }

    /// Marks the current anchor as needing re-verification (network change,
    /// time-source change, wake from sleep reported by the host).
    pub fn mark_stale(&mut self) {
        if self.anchor.is_some() {
            self.invalidated = true;
        }
    }

    pub fn has_anchor(&self) -> bool {
        self.anchor.is_some()
    }

    /// Current estimate and quality. Also feeds jump detection.
    pub fn reading(&mut self, local_wall_ms: i64, monotonic_ms: u64) -> ClockReading {
        if let Some((w0, m0)) = self.last_seen {
            let d_wall = local_wall_ms.saturating_sub(w0);
            let d_mono = i64::try_from(monotonic_ms.saturating_sub(m0)).unwrap_or(i64::MAX);
            if d_wall.saturating_sub(d_mono).unsigned_abs() > self.jump_threshold_ms {
                self.jump_detected = true;
            }
        }
        self.last_seen = Some((local_wall_ms, monotonic_ms));

        match self.anchor {
            None => ClockReading {
                server_now_ms: local_wall_ms,
                monotonic_ms,
                quality: ClockQuality::Unanchored,
            },
            Some(a) => {
                let elapsed = monotonic_ms.saturating_sub(a.monotonic_at_anchor_ms);
                let server_now_ms = a
                    .server_at_anchor_ms
                    .saturating_add(i64::try_from(elapsed).unwrap_or(i64::MAX));
                let expired = elapsed > self.validity_ms;
                let quality = if expired || self.jump_detected || self.invalidated {
                    ClockQuality::Stale
                } else {
                    ClockQuality::Anchored {
                        offset_ms: a.offset_ms,
                        error_ms: a.error_ms,
                    }
                };
                ClockReading {
                    server_now_ms,
                    monotonic_ms,
                    quality,
                }
            }
        }
    }
}

/// Parses the SOA `ResponseStatus.Timestamp` form `/Date(1761800000000+0800)/`
/// into Unix milliseconds. The numeric part is already epoch-based; the
/// `+0800` suffix is a display offset and does not change the instant.
pub fn parse_soa_timestamp(s: &str) -> Option<i64> {
    let s = s.trim();
    let inner = s.strip_prefix("/Date(")?.strip_suffix(")/")?;
    let bytes = inner.as_bytes();
    let mut end = 0;
    if bytes.first() == Some(&b'-') {
        end = 1;
    }
    while end < bytes.len() && bytes[end].is_ascii_digit() {
        end += 1;
    }
    if end == 0 || (end == 1 && bytes[0] == b'-') {
        return None;
    }
    let ms: i64 = inner[..end].parse().ok()?;
    let rest = &inner[end..];
    if rest.is_empty() {
        return Some(ms);
    }
    // Optional ±HHMM offset; anything else is malformed.
    let rb = rest.as_bytes();
    if rb.len() == 5 && (rb[0] == b'+' || rb[0] == b'-') && rb[1..].iter().all(u8::is_ascii_digit) {
        Some(ms)
    } else {
        None
    }
}

/// Why a reconcile barrier was raised.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ReconcileReason {
    Offline,
    WakeFromSleep,
    StreamGap,
    StaleSnapshot,
    ClockStale,
    SessionRestored,
}

/// Generation counter behind `ReconcileState`. core-im raises the barrier,
/// completes it when compensation + list refresh are done; notify only
/// consumes `state()`. Completing an older generation is a no-op so a slow
/// reconcile cannot clear a newer one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReconcileCoordinator {
    generation: u64,
    active: Option<(u64, ReconcileReason)>,
}

impl Default for ReconcileCoordinator {
    fn default() -> Self {
        Self::new()
    }
}

impl ReconcileCoordinator {
    pub fn new() -> Self {
        Self {
            generation: 0,
            active: None,
        }
    }

    /// Starts (or restarts) a reconcile and returns its generation.
    pub fn begin_reconcile(&mut self, reason: ReconcileReason) -> u64 {
        self.generation += 1;
        self.active = Some((self.generation, reason));
        self.generation
    }

    /// Completes `generation`. Returns `true` only when it was the active
    /// one; older (or unknown/future) generations are ignored.
    pub fn complete(&mut self, generation: u64) -> bool {
        match self.active {
            Some((g, _)) if g == generation => {
                self.active = None;
                true
            }
            _ => false,
        }
    }

    pub fn state(&self) -> ReconcileState {
        match self.active {
            Some((generation, _)) => ReconcileState::Reconciling { generation },
            None => ReconcileState::Normal,
        }
    }

    pub fn active_reason(&self) -> Option<ReconcileReason> {
        self.active.map(|(_, r)| r)
    }

    pub fn current_generation(&self) -> u64 {
        self.generation
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unanchored_before_first_anchor() {
        let mut c = ClockService::default();
        let r = c.reading(1_000, 10);
        assert_eq!(r.quality, ClockQuality::Unanchored);
        assert_eq!(r.server_now_ms, 1_000);
        assert!(!r.trusted());
    }

    #[test]
    fn anchor_offset_and_error_bound() {
        let mut c = ClockService::default();
        // server stamp 1_000_000, received at wall 999_700 after a 200 ms rtt.
        let (offset, err) = c.anchor_from_server(1_000_000, 999_700, 5_000, 200);
        assert_eq!(offset, 1_000_100 - 999_700);
        assert_eq!(err, 150);
        let r = c.reading(999_700, 5_000);
        assert_eq!(r.server_now_ms, 1_000_100);
        assert_eq!(
            r.quality,
            ClockQuality::Anchored {
                offset_ms: 400,
                error_ms: 150
            }
        );
        // Advances on the monotonic clock, regardless of the wall clock.
        let r = c.reading(999_700 + 1_000, 6_000);
        assert_eq!(r.server_now_ms, 1_001_100);
        assert!(r.trusted());
    }

    #[test]
    fn anchored_becomes_stale_on_expiry() {
        let mut c = ClockService::new(1_000);
        c.anchor_from_server(10_000, 10_000, 0, 0);
        assert!(c.reading(10_500, 500).trusted());
        assert!(c.reading(11_000, 1_000).trusted());
        let r = c.reading(11_001, 1_001);
        assert_eq!(r.quality, ClockQuality::Stale);
        // Estimate still advances monotonically while stale.
        assert_eq!(r.server_now_ms, 11_001);
        // Re-anchoring restores trust.
        c.anchor_from_server(20_000, 20_000, 2_000, 0);
        assert!(c.reading(20_001, 2_001).trusted());
    }

    #[test]
    fn wall_clock_jump_marks_stale_until_reanchor() {
        let mut c = ClockService::default();
        c.anchor_from_server(10_000, 10_000, 0, 0);
        assert!(c.reading(10_100, 100).trusted());
        // Wall clock moves 5 min while monotonic moved 100 ms: suspected jump.
        let r = c.reading(10_100 + 300_000, 200);
        assert_eq!(r.quality, ClockQuality::Stale);
        // Sticky even when later deltas agree.
        assert_eq!(
            c.reading(10_100 + 300_100, 300).quality,
            ClockQuality::Stale
        );
        // Sleep: monotonic stalls while wall advances.
        let mut s = ClockService::default();
        s.anchor_from_server(10_000, 10_000, 0, 0);
        assert_eq!(s.reading(70_000, 10).quality, ClockQuality::Stale);
        // Within threshold is fine.
        let mut ok = ClockService::default();
        ok.anchor_from_server(10_000, 10_000, 0, 0);
        assert!(ok.reading(11_999, 0).trusted());
        s.anchor_from_server(80_000, 80_000, 20, 0);
        assert!(s.reading(80_010, 30).trusted());
    }

    #[test]
    fn mark_stale_degrades_until_reanchor() {
        let mut c = ClockService::default();
        c.mark_stale(); // no anchor yet: harmless
        assert_eq!(c.reading(1, 1).quality, ClockQuality::Unanchored);
        c.anchor_from_server(10_000, 10_000, 0, 0);
        c.mark_stale();
        assert_eq!(c.reading(10_001, 1).quality, ClockQuality::Stale);
        c.anchor_from_server(10_100, 10_100, 100, 0);
        assert!(c.reading(10_101, 101).trusted());
    }

    #[test]
    fn soa_timestamp_parsing() {
        assert_eq!(
            parse_soa_timestamp("/Date(1761800000000+0800)/"),
            Some(1_761_800_000_000)
        );
        assert_eq!(
            parse_soa_timestamp("/Date(1761800000000)/"),
            Some(1_761_800_000_000)
        );
        assert_eq!(parse_soa_timestamp("/Date(-1000-0500)/"), Some(-1000));
        assert_eq!(parse_soa_timestamp(" /Date(5+0000)/ "), Some(5));
        assert_eq!(parse_soa_timestamp("/Date()/"), None);
        assert_eq!(parse_soa_timestamp("/Date(abc)/"), None);
        assert_eq!(parse_soa_timestamp("/Date(1+08)/"), None);
        assert_eq!(parse_soa_timestamp("1761800000000"), None);
        assert_eq!(parse_soa_timestamp("/Date(99999999999999999999)/"), None);
    }

    #[test]
    fn reconcile_generation_ordering() {
        let mut r = ReconcileCoordinator::new();
        assert_eq!(r.state(), ReconcileState::Normal);
        let g1 = r.begin_reconcile(ReconcileReason::Offline);
        assert_eq!(r.state(), ReconcileState::Reconciling { generation: g1 });
        let g2 = r.begin_reconcile(ReconcileReason::WakeFromSleep);
        assert!(g2 > g1);
        assert_eq!(r.active_reason(), Some(ReconcileReason::WakeFromSleep));
        // Completing the older generation changes nothing.
        assert!(!r.complete(g1));
        assert_eq!(r.state(), ReconcileState::Reconciling { generation: g2 });
        // A future / unknown generation is ignored too.
        assert!(!r.complete(g2 + 1));
        assert!(r.complete(g2));
        assert_eq!(r.state(), ReconcileState::Normal);
        assert!(!r.complete(g2));
        assert_eq!(r.current_generation(), g2);
    }

    #[test]
    fn extreme_wall_and_monotonic_values_never_overflow() {
        // QA regression: `|Δwall − Δmonotonic|` used plain subtraction and
        // overflowed when the wall clock jumped from i64::MAX to i64::MIN.
        let mut c = ClockService::default();
        c.anchor_from_server(i64::MAX, i64::MAX, 0, u64::MAX);
        let r = c.reading(i64::MIN, 1);
        assert_eq!(r.quality, ClockQuality::Stale);
        let r = c.reading(i64::MAX, u64::MAX);
        assert_eq!(r.monotonic_ms, u64::MAX);
        // Elapsed beyond i64::MAX saturates instead of running backwards.
        let mut s = ClockService::new(u64::MAX);
        s.anchor_from_server(0, 0, 0, 0);
        assert_eq!(s.reading(0, u64::MAX).server_now_ms, i64::MAX);
        let mut n = ClockService::default();
        n.anchor_from_server(i64::MIN, i64::MIN, u64::MAX, 0);
        let _ = n.reading(i64::MAX, 0);
        let _ = n.reading(i64::MIN, u64::MAX);
    }
}

//! Acceptance rules for the online, root-signed `key-status.json`.
//!
//! Fields (plan I-19): `version` (monotonic integer), `issued_at`,
//! `expires_at`, `active_keys[]`, `revoked_keys[]`, `min_client_version`.
//! Times are unix seconds. The host fetches the file, this module decides
//! whether to trust it and for how long the cached copy may be used.
//!
//! Rules enforced here:
//!
//! 1. the root signature is checked **before** the payload is parsed;
//! 2. `version` never goes backwards relative to the cache;
//! 3. an already-expired file is not accepted as fresh;
//! 4. a file issued in the future (beyond a day of skew) is rejected;
//! 5. offline / failed refresh: the cached copy is usable until `expires_at`,
//!    then for at most 7 more days, then every update is refused;
//! 6. a clock earlier than the cache's `verified_at` (beyond 1 h) is refused
//!    so that rolling the clock back cannot stretch the grace window.

use crate::version::Version;
use crate::Refusal;

/// Cache may be used this long after `expires_at`.
pub const GRACE_SECS: u64 = 7 * 24 * 3600;
/// Tolerated `issued_at` ahead of local time.
pub const MAX_ISSUED_SKEW_SECS: u64 = 24 * 3600;
/// Tolerated local clock step backwards relative to `verified_at`.
pub const CLOCK_TOLERANCE_SECS: u64 = 3600;

/// Parsed `key-status.json` (parsing is the host's job, see
/// [`accept_fetched`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyStatus {
    pub version: u64,
    pub issued_at: u64,
    pub expires_at: u64,
    /// Fingerprints of keys currently allowed to sign updates.
    pub active_keys: Vec<String>,
    /// Fingerprints that must be rejected.
    pub revoked_keys: Vec<String>,
    pub min_client_version: Version,
}

/// A status that passed verification, plus the highest verification time
/// observed (persisted by the host between runs). Tolerated small clock steps
/// never lower this watermark.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedKeyStatus {
    pub status: KeyStatus,
    pub verified_at: u64,
}

/// Root-key signature check over the raw file bytes. The real
/// implementation is minisign-compatible and lives in the host.
pub trait RootVerifier {
    fn verify(&self, payload: &[u8], signature: &[u8]) -> bool;
}

/// Why a fetched file was not accepted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StatusError {
    BadRootSignature,
    /// Payload authenticated but could not be parsed.
    Malformed,
    /// `expires_at <= issued_at`.
    InvalidWindow,
    VersionRollback {
        cached: u64,
        fetched: u64,
    },
    /// An already accepted sequence was reused for different policy content.
    VersionConflict {
        version: u64,
    },
    Expired,
    IssuedInFuture,
    /// Local time is behind the existing trusted verification watermark.
    ClockRollback,
}

/// Verify and accept a freshly fetched file. `parse` is only called with
/// bytes whose root signature already verified.
pub fn accept_fetched(
    root: &dyn RootVerifier,
    payload: &[u8],
    signature: &[u8],
    parse: &dyn Fn(&[u8]) -> Option<KeyStatus>,
    cache: Option<&CachedKeyStatus>,
    now: u64,
) -> Result<CachedKeyStatus, StatusError> {
    if !root.verify(payload, signature) {
        return Err(StatusError::BadRootSignature);
    }
    if cache.is_some_and(|c| clock_rolled_back(now, c.verified_at)) {
        return Err(StatusError::ClockRollback);
    }
    let status = parse(payload).ok_or(StatusError::Malformed)?;
    if status.expires_at <= status.issued_at {
        return Err(StatusError::InvalidWindow);
    }
    if let Some(c) = cache {
        if status.version < c.status.version {
            return Err(StatusError::VersionRollback {
                cached: c.status.version,
                fetched: status.version,
            });
        }
        if status.version == c.status.version && status != c.status {
            return Err(StatusError::VersionConflict {
                version: status.version,
            });
        }
    }
    if status.issued_at > now.saturating_add(MAX_ISSUED_SKEW_SECS) {
        return Err(StatusError::IssuedInFuture);
    }
    if status.expires_at <= now {
        return Err(StatusError::Expired);
    }
    Ok(CachedKeyStatus {
        status,
        verified_at: cache.map_or(now, |c| now.max(c.verified_at)),
    })
}

/// Outcome of the refresh attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fetch {
    /// Verified and accepted just now.
    Fresh(CachedKeyStatus),
    /// No network (or endpoint unreachable).
    Offline,
    /// Fetched but rejected; the cache is still consulted.
    Rejected(StatusError),
}

/// How much we trust the status that is returned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trust {
    Fresh,
    /// Cached copy, before `expires_at`.
    CachedValid,
    /// Cached copy past `expires_at`; still usable for `remaining_secs`.
    CachedGrace {
        remaining_secs: u64,
    },
}

/// Pick the status to use for this update check.
pub fn effective_status(
    fetch: Fetch,
    cache: Option<&CachedKeyStatus>,
    now: u64,
) -> Result<(CachedKeyStatus, Trust), Refusal> {
    // Check the existing high-water mark before selecting Fresh. A concurrent
    // refresh or a restored cache may be newer than the refresh's input cache.
    if cache.is_some_and(|c| clock_rolled_back(now, c.verified_at)) {
        return Err(Refusal::ClockRollback);
    }
    if let Fetch::Fresh(mut c) = fetch {
        if clock_rolled_back(now, c.verified_at) {
            return Err(Refusal::ClockRollback);
        }
        // Verification may have used an older cache than the one now held
        // by the caller. Neither a lower sequence nor conflicting reuse of
        // a sequence can replace the currently trusted revocations/limits.
        // Treat it exactly like a rejected refresh: only the current cache,
        // with its original expiry/grace, remains eligible below.
        let conflicts = cache.is_some_and(|old| {
            c.status.version < old.status.version
                || (c.status.version == old.status.version && c.status != old.status)
        });
        if !conflicts {
            c.verified_at = cache.map_or(c.verified_at, |old| c.verified_at.max(old.verified_at));
            return Ok((c, Trust::Fresh));
        }
    }
    let c = cache.ok_or(Refusal::NoKeyStatus)?;
    let exp = c.status.expires_at;
    if now < exp {
        return Ok((c.clone(), Trust::CachedValid));
    }
    let used = now - exp;
    if used <= GRACE_SECS {
        return Ok((
            c.clone(),
            Trust::CachedGrace {
                remaining_secs: GRACE_SECS - used,
            },
        ));
    }
    Err(Refusal::KeyStatusStale)
}

fn clock_rolled_back(now: u64, verified_at: u64) -> bool {
    now.saturating_add(CLOCK_TOLERANCE_SECS) < verified_at
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Root(bool);
    impl RootVerifier for Root {
        fn verify(&self, _: &[u8], _: &[u8]) -> bool {
            self.0
        }
    }

    fn st(version: u64, issued: u64, expires: u64) -> KeyStatus {
        KeyStatus {
            version,
            issued_at: issued,
            expires_at: expires,
            active_keys: vec!["K1".into()],
            revoked_keys: vec![],
            min_client_version: Version::new(0, 1, 0),
        }
    }

    fn cached(version: u64, verified: u64, expires: u64) -> CachedKeyStatus {
        CachedKeyStatus {
            status: st(version, verified, expires),
            verified_at: verified,
        }
    }

    fn accept(
        ok: bool,
        s: Option<KeyStatus>,
        cache: Option<&CachedKeyStatus>,
        now: u64,
    ) -> Result<CachedKeyStatus, StatusError> {
        accept_fetched(&Root(ok), b"p", b"s", &move |_| s.clone(), cache, now)
    }

    const DAY: u64 = 86_400;

    #[test]
    fn accepts_valid_and_stamps_verified_at() {
        let r = accept(true, Some(st(5, 900, 5000)), None, 1000).expect("ok");
        assert_eq!(r.verified_at, 1000);
        assert_eq!(r.status.version, 5);
    }

    #[test]
    fn bad_root_signature_is_rejected_before_parse() {
        let called = std::cell::Cell::new(false);
        let r = accept_fetched(
            &Root(false),
            b"p",
            b"s",
            &|_| {
                called.set(true);
                None
            },
            None,
            1,
        );
        assert_eq!(r, Err(StatusError::BadRootSignature));
        assert!(!called.get(), "unauthenticated bytes must not be parsed");
    }

    #[test]
    fn malformed_after_valid_signature() {
        assert_eq!(accept(true, None, None, 1), Err(StatusError::Malformed));
    }

    #[test]
    fn version_rollback_rejected_equal_and_higher_ok() {
        let c = cached(7, 100, 9000);
        assert_eq!(
            accept(true, Some(st(6, 100, 9000)), Some(&c), 200),
            Err(StatusError::VersionRollback {
                cached: 7,
                fetched: 6
            })
        );
        assert!(accept(true, Some(st(7, 100, 9000)), Some(&c), 200).is_ok());
        assert!(accept(true, Some(st(8, 100, 9000)), Some(&c), 200).is_ok());
    }

    #[test]
    fn expired_future_and_bad_window_rejected() {
        assert_eq!(
            accept(true, Some(st(1, 10, 100)), None, 100),
            Err(StatusError::Expired)
        );
        assert_eq!(
            accept(true, Some(st(1, 10_000_000, 20_000_000)), None, 100),
            Err(StatusError::IssuedInFuture)
        );
        assert_eq!(
            accept(true, Some(st(1, 50, 50)), None, 10),
            Err(StatusError::InvalidWindow)
        );
    }

    #[test]
    fn fresh_wins_over_cache() {
        let fresh = cached(9, 500, 9000);
        let old = cached(3, 100, 200);
        let (c, t) = effective_status(Fetch::Fresh(fresh.clone()), Some(&old), 500).expect("ok");
        assert_eq!((c, t), (fresh, Trust::Fresh));
    }

    #[test]
    fn offline_uses_cache_until_expiry_then_seven_days_then_refuses() {
        let exp = 1000 + 10 * DAY;
        let c = cached(1, 1000, exp);
        let (_, t) = effective_status(Fetch::Offline, Some(&c), exp - 1).expect("valid");
        assert_eq!(t, Trust::CachedValid);
        let (_, t) = effective_status(Fetch::Offline, Some(&c), exp).expect("grace start");
        assert_eq!(
            t,
            Trust::CachedGrace {
                remaining_secs: GRACE_SECS
            }
        );
        let (_, t) =
            effective_status(Fetch::Offline, Some(&c), exp + GRACE_SECS).expect("grace end");
        assert_eq!(t, Trust::CachedGrace { remaining_secs: 0 });
        assert_eq!(
            effective_status(Fetch::Offline, Some(&c), exp + GRACE_SECS + 1),
            Err(Refusal::KeyStatusStale)
        );
    }

    #[test]
    fn rejected_fetch_falls_back_to_cache() {
        let c = cached(4, 1000, 9000);
        let r = effective_status(
            Fetch::Rejected(StatusError::BadRootSignature),
            Some(&c),
            2000,
        );
        assert_eq!(r.map(|x| x.1), Ok(Trust::CachedValid));
    }

    #[test]
    fn no_cache_and_no_fresh_refuses() {
        assert_eq!(
            effective_status(Fetch::Offline, None, 5),
            Err(Refusal::NoKeyStatus)
        );
    }

    #[test]
    fn fresh_clock_rollback_cannot_reauthenticate_and_lower_trusted_time() {
        let previous = cached(1, 100_000, 900_000);
        let now = previous.verified_at - CLOCK_TOLERANCE_SECS - 1;
        // The root signature and sequence are valid. Re-fetching the same
        // still-valid policy must not turn a clock rollback into Fresh.
        let refreshed = accept(true, Some(previous.status.clone()), Some(&previous), now);
        assert_eq!(
            refreshed,
            Err(StatusError::ClockRollback),
            "valid root signature must not reset the trusted time"
        );
    }

    #[test]
    fn fresh_clock_selection_rechecks_high_water_after_concurrent_refresh() {
        let previous = cached(1, 100_000, 900_000);
        let now = previous.verified_at - CLOCK_TOLERANCE_SECS - 1;
        // Accepted before another task restored the higher persistent watermark.
        let fresh = cached(2, now, 900_000);
        assert_eq!(
            effective_status(Fetch::Fresh(fresh), Some(&previous), now),
            Err(Refusal::ClockRollback)
        );
    }

    #[test]
    fn fresh_clock_small_steps_cannot_ratchet_watermark_backwards() {
        let previous = cached(1, 100_000, 900_000);
        let now = previous.verified_at - CLOCK_TOLERANCE_SECS;
        let fresh = accept(true, Some(previous.status.clone()), Some(&previous), now)
            .expect("tolerated small step");
        assert_eq!(fresh.verified_at, previous.verified_at);
    }

    #[test]
    fn trusted_time_guard_preserves_first_fetch_rotation_and_existing_rejections() {
        let first = accept(true, Some(st(1, 900, 5000)), None, 1000)
            .expect("first fetch has no prior watermark");
        let mut rotated = st(2, 2000, 9000);
        rotated.active_keys = vec!["K2".into()];
        rotated.revoked_keys = vec!["K1".into()];
        let next = accept(true, Some(rotated.clone()), Some(&first), 5000)
            .expect("rotation can refresh an expired cache");
        assert_eq!(next.status, rotated);
        assert_eq!(next.verified_at, 5000);
        assert_eq!(
            accept(true, Some(st(1, 2000, 9000)), Some(&next), 5000),
            Err(StatusError::VersionRollback {
                cached: 2,
                fetched: 1
            })
        );
        assert_eq!(
            accept(true, Some(st(3, 2000, 5000)), Some(&next), 5000),
            Err(StatusError::Expired)
        );
        assert_eq!(
            accept(
                true,
                Some(st(3, 5000 + MAX_ISSUED_SKEW_SECS + 1, 1_000_000)),
                Some(&next),
                5000
            ),
            Err(StatusError::IssuedInFuture)
        );
        assert_eq!(
            accept(false, Some(rotated), Some(&next), 0),
            Err(StatusError::BadRootSignature),
            "signature check remains first"
        );
    }

    #[test]
    fn fresh_clock_selection_keeps_high_water_and_rejects_rollback_after_verification() {
        let previous = cached(1, 100_000, 900_000);
        let fresh = cached(2, 100_000 - CLOCK_TOLERANCE_SECS, 900_000);
        let (selected, trust) = effective_status(
            Fetch::Fresh(fresh),
            Some(&previous),
            100_000 - CLOCK_TOLERANCE_SECS,
        )
        .expect("boundary tolerated");
        assert_eq!(trust, Trust::Fresh);
        assert_eq!(selected.verified_at, 100_000);
        assert_eq!(
            accept(
                true,
                Some(selected.status.clone()),
                Some(&selected),
                100_000 - 2 * CLOCK_TOLERANCE_SECS
            ),
            Err(StatusError::ClockRollback)
        );
        assert_eq!(
            effective_status(Fetch::Fresh(previous), None, 0),
            Err(Refusal::ClockRollback),
            "time can roll back between verification and selection"
        );
        let near_max = cached(1, u64::MAX - 1, u64::MAX);
        assert!(
            effective_status(Fetch::Fresh(near_max), None, u64::MAX - 2).is_ok(),
            "tolerance addition cannot overflow"
        );
    }

    #[test]
    fn delayed_fresh_cannot_roll_back_concurrently_updated_revocations() {
        let fresh = cached(1, 1000, 9000);
        let mut current = cached(2, 1000, 9000);
        current.status.revoked_keys = vec!["K1".into()];
        current.status.active_keys = vec!["K2".into()];
        let (selected, trust) = effective_status(Fetch::Fresh(fresh), Some(&current), 1000)
            .expect("current cache remains usable");
        assert_eq!(selected, current);
        assert_eq!(
            trust,
            Trust::CachedValid,
            "delayed validation cannot claim fresh trust"
        );
    }

    #[test]
    fn same_sequence_different_revocations_is_rejected_and_keeps_current_cache() {
        let mut current = cached(2, 1000, 9000);
        current.status.revoked_keys = vec!["K1".into()];
        current.status.active_keys = vec!["K2".into()];
        let mut conflicting = current.clone();
        conflicting.status.revoked_keys.clear();
        conflicting.status.active_keys = vec!["K1".into(), "K2".into()];
        conflicting.status.expires_at = 1_000_000;
        assert_eq!(
            accept(true, Some(conflicting.status.clone()), Some(&current), 1000),
            Err(StatusError::VersionConflict { version: 2 })
        );
        let (selected, trust) =
            effective_status(Fetch::Fresh(conflicting.clone()), Some(&current), 1000)
                .expect("use existing signed cache only");
        assert_eq!(selected, current);
        assert_eq!(trust, Trust::CachedValid);
        assert_eq!(
            effective_status(
                Fetch::Fresh(conflicting),
                Some(&current),
                9000 + GRACE_SECS + 1
            ),
            Err(Refusal::KeyStatusStale),
            "conflicting expiry cannot extend the cached policy"
        );
    }

    #[test]
    fn delayed_fresh_uses_the_same_grace_and_time_guards_as_rejected_fetch() {
        let current = cached(2, 1000, 9000);
        let mut delayed = cached(1, 1000, 1_000_000);
        delayed.status.active_keys.push("NEW-UNAUTHORIZED".into());
        for now in [1000, 9000, 9000 + GRACE_SECS, 9000 + GRACE_SECS + 1] {
            assert_eq!(
                effective_status(Fetch::Fresh(delayed.clone()), Some(&current), now),
                effective_status(
                    Fetch::Rejected(StatusError::BadRootSignature),
                    Some(&current),
                    now
                )
            );
        }
        let current = cached(2, 100_000, 900_000);
        assert_eq!(
            effective_status(
                Fetch::Fresh(delayed),
                Some(&current),
                100_000 - CLOCK_TOLERANCE_SECS - 1
            ),
            Err(Refusal::ClockRollback)
        );
    }

    #[test]
    fn clock_rollback_refused_small_step_tolerated() {
        let c = cached(1, 100_000, 900_000);
        assert_eq!(
            effective_status(Fetch::Offline, Some(&c), 100_000 - CLOCK_TOLERANCE_SECS - 1),
            Err(Refusal::ClockRollback)
        );
        assert!(effective_status(Fetch::Offline, Some(&c), 100_000 - CLOCK_TOLERANCE_SECS).is_ok());
    }
}

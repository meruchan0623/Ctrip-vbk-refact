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

/// A status that passed verification, plus when we verified it (persisted
/// by the host between runs).
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
    Expired,
    IssuedInFuture,
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
    }
    if status.issued_at > now.saturating_add(MAX_ISSUED_SKEW_SECS) {
        return Err(StatusError::IssuedInFuture);
    }
    if status.expires_at <= now {
        return Err(StatusError::Expired);
    }
    Ok(CachedKeyStatus {
        status,
        verified_at: now,
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
    if let Fetch::Fresh(c) = fetch {
        return Ok((c, Trust::Fresh));
    }
    let c = cache.ok_or(Refusal::NoKeyStatus)?;
    if now.saturating_add(CLOCK_TOLERANCE_SECS) < c.verified_at {
        return Err(Refusal::ClockRollback);
    }
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
    fn clock_rollback_refused_small_step_tolerated() {
        let c = cached(1, 100_000, 900_000);
        assert_eq!(
            effective_status(Fetch::Offline, Some(&c), 100_000 - CLOCK_TOLERANCE_SECS - 1),
            Err(Refusal::ClockRollback)
        );
        assert!(effective_status(Fetch::Offline, Some(&c), 100_000 - CLOCK_TOLERANCE_SECS).is_ok());
    }
}

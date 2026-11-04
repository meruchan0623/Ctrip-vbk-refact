//! Signed-updater trust logic and system-integration parsers (std-only).
//!
//! Owner: release/update (I-19, I-20). No I/O, no clock, no crypto:
//!
//! * the host passes `now` (unix seconds) into every call;
//! * signature checks go through the [`keystatus::RootVerifier`] and
//!   [`flow::FlowOps`] traits, which the host implements with minisign /
//!   `WinVerifyTrust` / `codesign`. Tests use fakes. Nothing here implements
//!   cryptography.
//!
//! Modules:
//!
//! * [`version`]   - strict `x.y.z` versions.
//! * [`keystatus`] - `key-status.json` acceptance: root signature, version
//!   anti-rollback, expiry with a 7 day cache grace, clock-rollback guard.
//! * [`manifest`]  - https-only URLs, monotonic versions, `min_client_version`,
//!   dual-key (current / next) selection, embedded + online revocation.
//! * [`flow`]      - download -> minisign -> platform signature -> installer handoff;
//!   enforced as a state machine; pre-launch rejection attempts best-effort
//!   download cleanup; uncertain launch retains the artifact.
//! * [`deeplink`]  - own-scheme deep link whitelist parser and the
//!   second-instance argument plan.

pub mod deeplink;
pub mod flow;
pub mod keystatus;
pub mod manifest;
pub mod version;

/// Why an update (or a key-status refresh) was refused. Codes are stable
/// strings for diagnostics; they never embed untrusted input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// No cached key status and none could be fetched and verified.
    NoKeyStatus,
    /// Cached key status is older than `expires_at` + 7 days: "cannot confirm
    /// update key status".
    KeyStatusStale,
    /// System clock earlier than the time the cache was last verified.
    ClockRollback,
    /// Client older than `min_client_version`: manual download only.
    ClientTooOld,
    /// Manifest or artifact URL is not a well-formed https URL.
    InsecureUrl,
    /// Manifest version lower than one already seen (rollback).
    VersionRollback,
    /// Signing key is neither the current nor the next embedded key.
    UnknownSigningKey,
    /// Signing key is on the embedded or online revocation list.
    RevokedKey,
    /// Signing key is not listed in `active_keys` of the key status.
    KeyNotActive,
}

impl Refusal {
    /// Stable diagnostic code.
    pub fn code(&self) -> &'static str {
        match self {
            Refusal::NoKeyStatus => "update.no_key_status",
            Refusal::KeyStatusStale => "update.key_status_stale",
            Refusal::ClockRollback => "update.clock_rollback",
            Refusal::ClientTooOld => "update.client_too_old",
            Refusal::InsecureUrl => "update.insecure_url",
            Refusal::VersionRollback => "update.version_rollback",
            Refusal::UnknownSigningKey => "update.unknown_signing_key",
            Refusal::RevokedKey => "update.revoked_key",
            Refusal::KeyNotActive => "update.key_not_active",
        }
    }
}

//! Opaque identifiers minted by this crate.
//!
//! Ids are random ASCII hex so they are safe as path segments and never
//! leak a `buid`, phone number or login name into a directory name or log
//! line (archive §4.3). There is no crate registry, so randomness comes from
//! `std`'s per-process randomly keyed hasher mixed with the clock and a
//! counter.

use std::collections::hash_map::RandomState;
use std::fmt;
use std::hash::{BuildHasher, Hash, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(1);

/// 64 random-ish bits as 16 lowercase hex characters.
pub(crate) fn random_hex16(salt: &str) -> String {
    let state = RandomState::new();
    let mut h = state.build_hasher();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    nanos.hash(&mut h);
    COUNTER.fetch_add(1, Ordering::Relaxed).hash(&mut h);
    salt.hash(&mut h);
    format!("{:016x}", h.finish())
}

macro_rules! opaque_id {
    ($(#[$meta:meta])* $name:ident, $prefix:literal) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub struct $name(pub String);

        impl $name {
            /// Mints a fresh random id.
            pub fn mint() -> Self {
                Self(format!("{}{}", $prefix, random_hex16($prefix)))
            }

            pub fn new(id: impl Into<String>) -> Self {
                Self(id.into())
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}

opaque_id!(
    /// One login attempt. Known only to the login window that started it.
    AttemptId,
    "att_"
);

opaque_id!(
    /// A WebView2 profile (or data directory) name: random, ASCII, never
    /// derived from the buid.
    ProfileId,
    "p_"
);

/// Upstream Ctrip user id. Opaque here; it is only used as the stable key
/// of the identity index and never as a path segment or in a snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Buid(pub String);

impl Buid {
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Mints a new local `AccountId` (`acc_<16 hex>`).
pub(crate) fn mint_account_id() -> contracts::AccountId {
    contracts::AccountId::new(format!("acc_{}", random_hex16("acc")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_hex_and_distinct() {
        let a = AttemptId::mint();
        let b = AttemptId::mint();
        assert_ne!(a, b);
        assert!(a.as_str().starts_with("att_"));
        assert_eq!(a.as_str().len(), 4 + 16);
        assert!(a.as_str()[4..].chars().all(|c| c.is_ascii_hexdigit()));
        let p = ProfileId::mint();
        assert!(p.as_str().starts_with("p_"));
    }
}

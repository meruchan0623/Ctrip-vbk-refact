//! Identity contracts.
//!
//! Invariant (plan §2.1): identity must never drift with the UI. The persistent
//! identity is `(environment, account_id)`; the short-lived authorization is
//! `session_generation`. A view has its own `view_generation`. These are
//! separate because they guard different races and must not be collapsed
//! into a "current account".

use std::fmt;

/// Local opaque account identifier. It is minted by core-account after the
/// upstream identity (`buid`/`uid`) has been verified; it is never a value
/// the frontend chose.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct AccountId(pub String);

impl AccountId {
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for AccountId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Deployment environment. Participates in credential, profile, database,
/// backup and cache namespaces. Only `production` is a product value today;
/// anything else exists for test fixtures and must never reach a release
/// build's default.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Environment(pub String);

impl Environment {
    pub const PRODUCTION: &'static str = "production";

    pub fn production() -> Self {
        Self(Self::PRODUCTION.to_string())
    }

    pub fn named(name: impl Into<String>) -> Self {
        Self(name.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Default for Environment {
    fn default() -> Self {
        Self::production()
    }
}

/// `AccountContext = {account_id, environment, session_generation}`.
///
/// Every outbound action, inbound fact, draft, snapshot and alarm entry is
/// bound to the context it was created under. Late callbacks whose
/// `session_generation` is older than the account's current generation must
/// be rejected, even when only one identity is logged in.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct AccountContext {
    pub account_id: AccountId,
    pub environment: Environment,
    pub session_generation: u64,
}

impl AccountContext {
    pub fn new(account_id: AccountId, environment: Environment, session_generation: u64) -> Self {
        Self {
            account_id,
            environment,
            session_generation,
        }
    }

    /// Persistent identity key `(environment, account_id)`, independent of
    /// the session generation.
    pub fn persistent_key(&self) -> (&Environment, &AccountId) {
        (&self.environment, &self.account_id)
    }

    /// True when `other` refers to the same persistent identity *and* the
    /// same authorization generation. This is the check a core performs
    /// before accepting a late result.
    pub fn is_current_for(&self, other: &AccountContext) -> bool {
        self == other
    }

    /// True when `other` is the same persistent identity but an older
    /// generation (a stale callback).
    pub fn is_stale_generation_of(&self, other: &AccountContext) -> bool {
        self.persistent_key() == other.persistent_key()
            && other.session_generation < self.session_generation
    }

    /// Returns a context with the generation advanced by one. Used when a
    /// login becomes invalid, the user logs out or the identity is replaced.
    pub fn next_generation(&self) -> Self {
        Self {
            account_id: self.account_id.clone(),
            environment: self.environment.clone(),
            session_generation: self.session_generation + 1,
        }
    }
}

/// `ConversationRef = {account, gid}`. A `gid` alone never identifies a
/// conversation across accounts.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ConversationRef {
    pub account: AccountContext,
    pub gid: String,
}

impl ConversationRef {
    pub fn new(account: AccountContext, gid: impl Into<String>) -> Self {
        Self {
            account,
            gid: gid.into(),
        }
    }
}

/// `ViewContext = {webview_label, view_generation}`. Assigned by the host's
/// view registry; reusing a label, rebuilding a webview or rebinding it to
/// another account increments the generation. JS-reported origin is never
/// trusted.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ViewContext {
    pub webview_label: String,
    pub view_generation: u64,
}

impl ViewContext {
    pub fn new(webview_label: impl Into<String>, view_generation: u64) -> Self {
        Self {
            webview_label: webview_label.into(),
            view_generation,
        }
    }
}

/// `AggregateScope = {subscription_id, authorization_revision}`: a core-created
/// subscription over an authorized *set* of accounts (account list, alarm
/// queue, multi-account unread). Changing the set bumps the revision and
/// invalidates older snapshots.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct AggregateScope {
    pub subscription_id: String,
    pub authorization_revision: u64,
}

/// Scope of an event envelope / snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Scope {
    Account(AccountContext),
    Aggregate(AggregateScope),
    /// App-global domain; only for payloads that carry no customer or
    /// account data (e.g. preference and language changes).
    App,
}

impl Scope {
    pub fn account(&self) -> Option<&AccountContext> {
        match self {
            Scope::Account(ctx) => Some(ctx),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(gen: u64) -> AccountContext {
        AccountContext::new(AccountId::new("acc-1"), Environment::production(), gen)
    }

    #[test]
    fn stale_generation_is_detected_only_for_same_persistent_identity() {
        let current = ctx(3);
        assert!(current.is_stale_generation_of(&ctx(2)));
        assert!(!current.is_stale_generation_of(&ctx(3)));
        assert!(!current.is_stale_generation_of(&ctx(4)));

        let other_account =
            AccountContext::new(AccountId::new("acc-2"), Environment::production(), 1);
        assert!(!current.is_stale_generation_of(&other_account));
    }

    #[test]
    fn next_generation_keeps_persistent_key() {
        let c = ctx(7);
        let n = c.next_generation();
        assert_eq!(n.session_generation, 8);
        assert_eq!(n.persistent_key(), c.persistent_key());
        assert!(n.is_stale_generation_of(&c));
    }
}

//! Identity actor: login attempts, session generations, revocation of late
//! callbacks and the quick-login credential commit protocol (std-only).
//!
//! Design sources: `docs/dev/02-account-login.md`, the archived
//! `docs/archive/desktop-baseline/dev/02-account-login.md` §4.2–4.9, plan
//! §2 invariant 1, §7 ("登录验证与凭据发布", "关键凭据崩溃恢复",
//! "保留账号数据与重认领") and review rows F01 / F03.
//!
//! The crate is a **single-writer state machine**: [`AccountRegistry`] is a
//! plain struct with explicit methods. The host owns the one thread (or the
//! one `std::sync::mpsc` consumer) that calls into it; everything else only
//! reads the desensitized [`AccountListSnapshot`] and the drained events.
//!
//! Invariants enforced here:
//!
//! 1. Persistent identity is `(environment, account_id)`; `account_id` is a
//!    locally minted opaque id that maps 1:1 to the upstream
//!    `(environment, buid)` through a stable [`IdentityIndex`]. Re-auth of the
//!    same upstream identity (even after `Forget`) yields the **same**
//!    `account_id`, so drafts / rounds / unknown intents are never orphaned.
//! 2. A login attempt is isolated: it has an `attempt_id`, a pending
//!    `profile_id` and **no** `AccountContext` until the upstream identity has
//!    been verified and published.
//! 3. Every invalidation, logout, replace or forget **first** advances
//!    `session_generation` (so new requests are rejected) and only **then**
//!    returns a [`RevokeList`] describing what the host must tear down.
//! 4. Quick-login credentials follow `Prepared → SecretStaged →
//!    IndexCommitted`; the non-secret journal is written before the secret,
//!    the index switches atomically, old revisions are deleted only after the
//!    commit, and a restart resolves from the committed index, never from
//!    whether a "ready" event was emitted.
//! 5. Agent work status is a server read-back value and never changes because
//!    the transport dropped.
//!
//! Nothing in this crate holds a cookie, ticket or password: secrets only
//! pass through the abstract [`SecretStore`] as opaque bytes wrapped in
//! [`Secret`], whose `Debug` output is masked.

pub mod credential;
pub mod error;
pub mod ids;
pub mod index;
pub mod registry;

pub use credential::{
    CommitStage, CredentialJournal, CredentialLedger, CredentialRef, CredentialRevision,
    JournalEntry, MemorySecretStore, RecoveryReport, Secret, SecretStore, StagedRef,
};
pub use error::codes;
pub use ids::{AttemptId, Buid, ProfileId};
pub use index::{IdentityIndex, IndexEntry};
pub use registry::{
    AccountEvent, AccountListSnapshot, AccountRegistry, AccountState, AccountStateKind,
    AccountSummary, ChangeKind, CredentialAction, CredentialOperation, GenerationReason,
    LoginAttemptHandle, LogoutMode, ProfileAction, PublishOutcome, RevokeList, UpstreamIdentity,
    WorkStatus,
};

//! `AccountRegistry`: the single-writer account state machine.
//!
//! See the crate docs for the invariants. Every mutating method is
//! synchronous and total over its inputs; the host serializes calls (one
//! thread or one mailbox consumer) and drains the event outbox after each
//! call.

use std::collections::{BTreeMap, VecDeque};

use contracts::json::JsonValue;
use contracts::{
    AccountContext, AccountId, AggregateScope, AppError, Environment, EventEnvelope, Scope,
    Snapshot,
};

use crate::credential::{
    CredentialLedger, CredentialRef, CredentialRevision, RecoveryReport, Secret, SecretStore,
    StagedRef,
};
use crate::error::{codes, err};
use crate::ids::{AttemptId, Buid, ProfileId};
use crate::index::IdentityIndex;

/// Stream name of every envelope / snapshot this registry produces.
pub const ACCOUNT_STREAM: &str = "account";
/// `AggregateScope::subscription_id` of the account list snapshot.
pub const ACCOUNT_LIST_SUBSCRIPTION: &str = "account.list";

const CANCELLED_MEMORY: usize = 64;

// ----------------------------------------------------------------- types

/// Per-account state. Only `Online` authorizes business traffic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AccountState {
    /// No session, no quick-login credential.
    LoggedOut,
    /// A re-login attempt targets this account. No context is valid.
    LoginPending { attempt_id: AttemptId },
    Online(AccountContext),
    /// "退出在线（保留免密）": generation revoked, credential kept.
    Suspended(AccountContext),
    /// Ticket expired / server says not logged in. Generation revoked.
    Invalid { ctx: AccountContext, reason: String },
}

impl AccountState {
    pub fn kind(&self) -> AccountStateKind {
        match self {
            AccountState::LoggedOut => AccountStateKind::LoggedOut,
            AccountState::LoginPending { .. } => AccountStateKind::LoginPending,
            AccountState::Online(_) => AccountStateKind::Online,
            AccountState::Suspended(_) => AccountStateKind::Suspended,
            AccountState::Invalid { .. } => AccountStateKind::Invalid,
        }
    }

    /// The context carried by the state (not necessarily authorized).
    pub fn context(&self) -> Option<&AccountContext> {
        match self {
            AccountState::Online(c) | AccountState::Suspended(c) => Some(c),
            AccountState::Invalid { ctx, .. } => Some(ctx),
            AccountState::LoggedOut | AccountState::LoginPending { .. } => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AccountStateKind {
    LoggedOut,
    LoginPending,
    Online,
    Suspended,
    Invalid,
}

impl AccountStateKind {
    pub fn as_str(self) -> &'static str {
        match self {
            AccountStateKind::LoggedOut => "logged_out",
            AccountStateKind::LoginPending => "login_pending",
            AccountStateKind::Online => "online",
            AccountStateKind::Suspended => "suspended",
            AccountStateKind::Invalid => "invalid",
        }
    }
}

/// Agent work status ("在线/挂起/离开/下班"). A web business value that is
/// **only** updated from a server read-back; independent of login and
/// transport state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum WorkStatus {
    Online,
    Suspended,
    Away,
    OffDuty,
    #[default]
    Unknown,
}

/// Verified upstream identity (from the user-info endpoint). `buid` is the
/// stable key; `uid` / `agent_id` are opaque display-free identifiers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpstreamIdentity {
    pub buid: Buid,
    pub uid: String,
    pub agent_id: Option<String>,
    pub environment: Environment,
}

/// Handle of an isolated login attempt. It carries no `AccountContext`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoginAttemptHandle {
    pub attempt_id: AttemptId,
    pub environment: Environment,
    /// Pending profile the login webview must be created in.
    pub profile_id: ProfileId,
    /// Set for a re-login: the verified identity must map to this account.
    pub target: Option<AccountId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogoutMode {
    /// "退出在线（保留免密）": revoke the session, keep the credential.
    ExitOnline,
    /// "退出登录": revoke the session and delete the credential.
    Logout,
    /// "彻底移除": remove the account entry; the non-secret identity index
    /// is kept so a later re-auth re-associates the same `account_id`.
    Forget,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GenerationReason {
    Published,
    Replaced,
    Invalidated,
    ExitOnline,
    Logout,
    Forget,
    QuickLoginResumed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileAction {
    /// Nothing to do with the profile.
    Keep,
    /// Close all controllers; keep cookies (quick login may reuse it after
    /// it is fully stopped).
    Isolate,
    /// Close all controllers, then clear site data (cookies, storage,
    /// service workers) once the platform confirms release.
    ClearSiteData,
    /// Close, clear and delete the profile (retry on next start if busy).
    Delete,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CredentialAction {
    Keep,
    /// Delete this committed entry from the secret store.
    Delete(CredentialRef),
}

/// What the host must tear down **after** the generation has advanced.
/// Everything here is non-secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevokeList {
    pub account_id: AccountId,
    pub environment: Environment,
    /// The generation that is now rejected by [`AccountRegistry::validate`].
    pub revoked_generation: u64,
    /// The generation that replaced it (`None` after `Forget`).
    pub current_generation: Option<u64>,
    /// Detach the cookie jar / stop issuing requests for the old scope.
    pub revoke_jar: bool,
    /// Disconnect IM transport, cancel downloads / assistant tasks.
    pub stop_transport: bool,
    pub profile: Option<ProfileId>,
    pub profile_action: ProfileAction,
    pub credential: CredentialAction,
    /// Staged secrets of aborted in-flight credential commits.
    pub staged_to_discard: Vec<StagedRef>,
}

/// Result of publishing a verified identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishOutcome {
    pub ctx: AccountContext,
    pub is_new_account: bool,
    /// Present when an older session of the same account was replaced.
    pub revoke: Option<RevokeList>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeKind {
    State,
    Remark,
    WorkStatus,
    CredentialCommitted,
    CredentialMissing,
}

/// Events emitted into the outbox. Per-account events are scoped
/// `Scope::Account(ctx)`; `Reordered` is `Scope::App` and carries only
/// opaque local ids.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AccountEvent {
    Added {
        account_id: AccountId,
    },
    Changed {
        account_id: AccountId,
        change: ChangeKind,
    },
    Removed {
        account_id: AccountId,
    },
    GenerationAdvanced {
        account_id: AccountId,
        from: u64,
        to: u64,
        reason: GenerationReason,
    },
    Reordered {
        environment: Environment,
        order: Vec<AccountId>,
    },
}

/// Desensitized account row: no buid, uid, cookie or ticket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountSummary {
    pub account_id: AccountId,
    pub environment: Environment,
    pub state: AccountStateKind,
    pub session_generation: Option<u64>,
    pub remark: Option<String>,
    pub order: u32,
    pub work_status: WorkStatus,
    pub quick_login_available: bool,
    pub credential_revision: CredentialRevision,
    pub invalid_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AccountListSnapshot {
    /// Sorted by `(environment, order)`.
    pub accounts: Vec<AccountSummary>,
}

/// Handle of an in-flight credential commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialOperation {
    pub operation_id: String,
    pub account_id: AccountId,
    pub revision: CredentialRevision,
}

#[derive(Debug, Clone)]
struct AccountRecord {
    account_id: AccountId,
    environment: Environment,
    state: AccountState,
    /// State before a re-login attempt took over (restored on cancel).
    prior_state: Option<Box<AccountState>>,
    /// Last context ever issued (kept through LoggedOut / LoginPending).
    last_ctx: AccountContext,
    uid: String,
    agent_id: Option<String>,
    profile_id: Option<ProfileId>,
    remark: Option<String>,
    order: u32,
    work_status: WorkStatus,
    transport_connected: bool,
}

// -------------------------------------------------------------- registry

#[derive(Debug)]
pub struct AccountRegistry {
    boot_epoch: u64,
    index: IdentityIndex,
    ledger: CredentialLedger,
    accounts: BTreeMap<AccountId, AccountRecord>,
    attempts: BTreeMap<AttemptId, LoginAttemptHandle>,
    cancelled: VecDeque<AttemptId>,
    seq: u64,
    authorization_revision: u64,
    outbox: Vec<EventEnvelope<AccountEvent>>,
}

impl AccountRegistry {
    /// `boot_epoch` is a per-process value that must be larger than any
    /// generation a previous run could have issued (e.g. Unix seconds at
    /// start). It is the event stream epoch and the floor of every new
    /// generation, so a handle from a previous run, or from a restored
    /// backup, is never accepted again.
    pub fn new(boot_epoch: u64) -> Self {
        Self {
            boot_epoch,
            index: IdentityIndex::new(),
            ledger: CredentialLedger::new(),
            accounts: BTreeMap::new(),
            attempts: BTreeMap::new(),
            cancelled: VecDeque::new(),
            seq: 0,
            authorization_revision: 1,
            outbox: Vec::new(),
        }
    }

    pub fn boot_epoch(&self) -> u64 {
        self.boot_epoch
    }

    pub fn index(&self) -> &IdentityIndex {
        &self.index
    }

    pub fn ledger(&self) -> &CredentialLedger {
        &self.ledger
    }

    // ---------------------------------------------------------- events

    fn emit(&mut self, scope: Scope, payload: AccountEvent) {
        self.seq += 1;
        self.outbox.push(EventEnvelope {
            scope,
            stream: ACCOUNT_STREAM.to_string(),
            epoch: self.boot_epoch,
            seq: self.seq,
            payload,
        });
    }

    fn emit_for(&mut self, ctx: &AccountContext, payload: AccountEvent) {
        self.emit(Scope::Account(ctx.clone()), payload);
    }

    /// Takes every event produced since the last drain, in order.
    pub fn drain_events(&mut self) -> Vec<EventEnvelope<AccountEvent>> {
        std::mem::take(&mut self.outbox)
    }

    pub fn pending_event_count(&self) -> usize {
        self.outbox.len()
    }

    // ------------------------------------------------------ generations

    fn next_generation(&mut self, account_id: &AccountId) -> Result<u64, AppError> {
        let floor = self.boot_epoch;
        let entry = self
            .index
            .entry_for_mut(account_id)
            .ok_or_else(|| err(codes::ACCOUNT_UNKNOWN, "account has no index entry"))?;
        let next = (entry.last_generation + 1).max(floor);
        entry.last_generation = next;
        Ok(next)
    }

    fn record(&self, account_id: &AccountId) -> Result<&AccountRecord, AppError> {
        self.accounts
            .get(account_id)
            .ok_or_else(|| err(codes::ACCOUNT_UNKNOWN, "unknown account"))
    }

    fn record_mut(&mut self, account_id: &AccountId) -> Result<&mut AccountRecord, AppError> {
        self.accounts
            .get_mut(account_id)
            .ok_or_else(|| err(codes::ACCOUNT_UNKNOWN, "unknown account"))
    }

    /// Advances the generation of an existing account and returns
    /// `(old_ctx, new_ctx)`. Emits `GenerationAdvanced`.
    fn advance(
        &mut self,
        account_id: &AccountId,
        reason: GenerationReason,
    ) -> Result<(AccountContext, AccountContext), AppError> {
        let old = self.record(account_id)?.last_ctx.clone();
        let gen = self.next_generation(account_id)?;
        let new = AccountContext::new(account_id.clone(), old.environment.clone(), gen);
        self.record_mut(account_id)?.last_ctx = new.clone();
        self.emit_for(
            &new,
            AccountEvent::GenerationAdvanced {
                account_id: account_id.clone(),
                from: old.session_generation,
                to: gen,
                reason,
            },
        );
        Ok((old, new))
    }

    // ---------------------------------------------------------- attempts

    /// Starts an isolated "add account" attempt in `environment`.
    pub fn start_login(&mut self, environment: Environment) -> LoginAttemptHandle {
        let handle = LoginAttemptHandle {
            attempt_id: AttemptId::mint(),
            environment,
            profile_id: ProfileId::mint(),
            target: None,
        };
        self.attempts.insert(handle.attempt_id.clone(), handle.clone());
        handle
    }

    /// Starts a re-login attempt for an existing account. The verified
    /// identity must map to the same account or publishing fails with
    /// `account.identity_mismatch` and the target is untouched.
    pub fn start_relogin(&mut self, account_id: &AccountId) -> Result<LoginAttemptHandle, AppError> {
        let rec = self.record(account_id)?;
        if let AccountState::LoginPending { .. } = rec.state {
            return Err(err(codes::ACCOUNT_INVALID_STATE, "a re-login is already pending"));
        }
        let handle = LoginAttemptHandle {
            attempt_id: AttemptId::mint(),
            environment: rec.environment.clone(),
            profile_id: ProfileId::mint(),
            target: Some(account_id.clone()),
        };
        let is_online = matches!(rec.state, AccountState::Online(_));
        if !is_online {
            // Offline target: park it as LoginPending (restored on cancel).
            let rec = self.record_mut(account_id)?;
            let prior = std::mem::replace(
                &mut rec.state,
                AccountState::LoginPending {
                    attempt_id: handle.attempt_id.clone(),
                },
            );
            rec.prior_state = Some(Box::new(prior));
            let ctx = rec.last_ctx.clone();
            self.emit_for(
                &ctx,
                AccountEvent::Changed {
                    account_id: account_id.clone(),
                    change: ChangeKind::State,
                },
            );
        }
        self.attempts.insert(handle.attempt_id.clone(), handle.clone());
        Ok(handle)
    }

    pub fn attempt(&self, attempt_id: &AttemptId) -> Option<&LoginAttemptHandle> {
        self.attempts.get(attempt_id)
    }

    /// Cancels an attempt. Returns the pending profile the host must
    /// delete. A late identity result for this attempt is rejected with
    /// `account.attempt_cancelled`.
    pub fn cancel_login(&mut self, attempt_id: &AttemptId) -> Result<ProfileId, AppError> {
        let handle = self
            .attempts
            .remove(attempt_id)
            .ok_or_else(|| self.attempt_error(attempt_id))?;
        self.remember_cancelled(attempt_id.clone());
        if let Some(target) = &handle.target {
            if let Some(rec) = self.accounts.get_mut(target) {
                if matches!(&rec.state, AccountState::LoginPending { attempt_id: a } if a == attempt_id) {
                    rec.state = rec
                        .prior_state
                        .take()
                        .map(|b| *b)
                        .unwrap_or(AccountState::LoggedOut);
                    let ctx = rec.last_ctx.clone();
                    self.emit_for(
                        &ctx,
                        AccountEvent::Changed {
                            account_id: target.clone(),
                            change: ChangeKind::State,
                        },
                    );
                }
            }
        }
        Ok(handle.profile_id)
    }

    fn remember_cancelled(&mut self, attempt_id: AttemptId) {
        self.cancelled.push_back(attempt_id);
        while self.cancelled.len() > CANCELLED_MEMORY {
            self.cancelled.pop_front();
        }
    }

    fn attempt_error(&self, attempt_id: &AttemptId) -> AppError {
        if self.cancelled.contains(attempt_id) {
            err(codes::ACCOUNT_ATTEMPT_CANCELLED, "login attempt was cancelled")
        } else {
            err(codes::ACCOUNT_ATTEMPT_UNKNOWN, "unknown login attempt")
        }
    }

    /// Publishes a verified upstream identity for an attempt: resolves the
    /// stable `account_id`, advances the generation, creates/updates the
    /// account and emits events. If the account already had a session it
    /// is replaced and the returned `revoke` must be executed.
    pub fn publish_identity(
        &mut self,
        attempt_id: &AttemptId,
        identity: UpstreamIdentity,
    ) -> Result<PublishOutcome, AppError> {
        let handle = self
            .attempts
            .get(attempt_id)
            .cloned()
            .ok_or_else(|| self.attempt_error(attempt_id))?;
        if handle.environment != identity.environment {
            return Err(err(
                codes::ACCOUNT_ENVIRONMENT_MISMATCH,
                "attempt and identity environments differ",
            ));
        }
        let account_id = self
            .index
            .resolve_or_mint(&identity.environment, &identity.buid)
            .account_id
            .clone();
        if let Some(target) = &handle.target {
            if *target != account_id {
                return Err(err(
                    codes::ACCOUNT_IDENTITY_MISMATCH,
                    "verified identity does not belong to the target account",
                ));
            }
        }
        self.attempts.remove(attempt_id);

        let is_new = !self.accounts.contains_key(&account_id);
        if is_new {
            let gen = self.next_generation(&account_id)?;
            let ctx = AccountContext::new(account_id.clone(), identity.environment.clone(), gen);
            let order = self.next_order(&identity.environment);
            self.accounts.insert(
                account_id.clone(),
                AccountRecord {
                    account_id: account_id.clone(),
                    environment: identity.environment.clone(),
                    state: AccountState::Online(ctx.clone()),
                    prior_state: None,
                    last_ctx: ctx.clone(),
                    uid: identity.uid,
                    agent_id: identity.agent_id,
                    profile_id: Some(handle.profile_id),
                    remark: None,
                    order,
                    work_status: WorkStatus::Unknown,
                    transport_connected: false,
                },
            );
            self.authorization_revision += 1;
            self.emit_for(
                &ctx,
                AccountEvent::Added {
                    account_id: account_id.clone(),
                },
            );
            self.emit_for(
                &ctx,
                AccountEvent::GenerationAdvanced {
                    account_id: account_id.clone(),
                    from: 0,
                    to: gen,
                    reason: GenerationReason::Published,
                },
            );
            return Ok(PublishOutcome {
                ctx,
                is_new_account: true,
                revoke: None,
            });
        }

        // Existing account: advance first, then describe the teardown.
        let (old_ctx, new_ctx) = self.advance(&account_id, GenerationReason::Published)?;
        let rec = self.record_mut(&account_id)?;
        // Anything that still holds resources of the old generation (a
        // suspended / invalid session, or a profile) needs a teardown.
        let effective_state = match (&rec.state, &rec.prior_state) {
            (AccountState::LoginPending { .. }, Some(prior)) => prior.kind(),
            (s, _) => s.kind(),
        };
        let had_session = effective_state != AccountStateKind::LoggedOut || rec.profile_id.is_some();
        let old_profile = rec.profile_id.replace(handle.profile_id);
        rec.prior_state = None;
        rec.state = AccountState::Online(new_ctx.clone());
        rec.uid = identity.uid;
        rec.agent_id = identity.agent_id;
        rec.transport_connected = false;
        let revoke = had_session.then(|| RevokeList {
            account_id: account_id.clone(),
            environment: identity.environment.clone(),
            revoked_generation: old_ctx.session_generation,
            current_generation: Some(new_ctx.session_generation),
            revoke_jar: true,
            stop_transport: true,
            profile: old_profile,
            profile_action: ProfileAction::Delete,
            credential: CredentialAction::Keep,
            staged_to_discard: Vec::new(),
        });
        self.emit_for(
            &new_ctx,
            AccountEvent::Changed {
                account_id: account_id.clone(),
                change: ChangeKind::State,
            },
        );
        Ok(PublishOutcome {
            ctx: new_ctx,
            is_new_account: false,
            revoke,
        })
    }

    fn next_order(&self, environment: &Environment) -> u32 {
        self.accounts
            .values()
            .filter(|r| &r.environment == environment)
            .map(|r| r.order.saturating_add(1))
            .max()
            .unwrap_or(0)
    }

    // -------------------------------------------------------- validation

    /// Checks that `ctx` is the current, online authorization.
    pub fn validate(&self, ctx: &AccountContext) -> Result<(), AppError> {
        let rec = self
            .accounts
            .get(&ctx.account_id)
            .ok_or_else(|| err(codes::ACCOUNT_UNKNOWN, "unknown account"))?;
        if rec.environment != ctx.environment {
            return Err(err(codes::ACCOUNT_UNKNOWN, "environment does not match account"));
        }
        let current = rec.last_ctx.session_generation;
        if ctx.session_generation < current {
            return Err(err(
                codes::ACCOUNT_STALE_GENERATION,
                format!("generation {} is older than {}", ctx.session_generation, current),
            )
            .with_detail(format!("account_id={}", ctx.account_id)));
        }
        if ctx.session_generation > current {
            return Err(err(codes::ACCOUNT_UNKNOWN, "generation was never issued"));
        }
        match &rec.state {
            AccountState::Online(_) => Ok(()),
            other => Err(err(
                codes::ACCOUNT_NOT_ONLINE,
                format!("account is {}", other.kind().as_str()),
            )),
        }
    }

    /// Current context (online or not). `None` while logged out / pending.
    pub fn current_context(&self, account_id: &AccountId) -> Option<AccountContext> {
        self.accounts.get(account_id)?.state.context().cloned()
    }

    pub fn state(&self, account_id: &AccountId) -> Option<&AccountState> {
        self.accounts.get(account_id).map(|r| &r.state)
    }

    /// Profile bound to a *valid* context (for creating business webviews).
    pub fn profile_of(&self, ctx: &AccountContext) -> Result<ProfileId, AppError> {
        self.validate(ctx)?;
        self.record(&ctx.account_id)?
            .profile_id
            .clone()
            .ok_or_else(|| err(codes::ACCOUNT_INVALID_STATE, "no profile bound"))
    }

    /// Resolves the account id of an upstream identity without creating
    /// anything (for "is this already added?" checks).
    pub fn account_for(&self, environment: &Environment, buid: &Buid) -> Option<AccountId> {
        self.index
            .lookup(environment, buid)
            .filter(|e| self.accounts.contains_key(&e.account_id))
            .map(|e| e.account_id.clone())
    }

    pub fn account_ids(&self) -> Vec<AccountId> {
        self.sorted_records().map(|r| r.account_id.clone()).collect()
    }

    // ----------------------------------------------------- revocations

    fn abort_pending_credential_ops(&mut self, account_id: &AccountId) -> Vec<StagedRef> {
        let ops: Vec<_> = self
            .ledger
            .journal()
            .entries()
            .filter(|e| &e.account_id == account_id && e.stage != crate::credential::CommitStage::IndexCommitted)
            .map(|e| (e.operation_id.clone(), e.staged.clone()))
            .collect();
        let mut staged = Vec::new();
        for (op, s) in ops {
            let mut sink = NullStore;
            let _ = self.ledger.abort(&op, &mut sink);
            staged.extend(s);
        }
        staged
    }

    /// Ticket expired / server says not logged in. Advances the generation,
    /// moves to `Invalid`, keeps the credential reference (the host decides
    /// whether re-auth replaces it).
    pub fn invalidate(&mut self, account_id: &AccountId, reason: impl Into<String>) -> Result<RevokeList, AppError> {
        let rec = self.record(account_id)?;
        if !matches!(
            rec.state,
            AccountState::Online(_) | AccountState::Suspended(_) | AccountState::Invalid { .. }
        ) {
            return Err(err(codes::ACCOUNT_INVALID_STATE, "no session to invalidate"));
        }
        let (old, new) = self.advance(account_id, GenerationReason::Invalidated)?;
        let rec = self.record_mut(account_id)?;
        rec.state = AccountState::Invalid {
            ctx: new.clone(),
            reason: reason.into(),
        };
        rec.transport_connected = false;
        let profile = rec.profile_id.clone();
        self.emit_for(
            &new,
            AccountEvent::Changed {
                account_id: account_id.clone(),
                change: ChangeKind::State,
            },
        );
        Ok(RevokeList {
            account_id: account_id.clone(),
            environment: new.environment.clone(),
            revoked_generation: old.session_generation,
            current_generation: Some(new.session_generation),
            revoke_jar: true,
            stop_transport: true,
            profile,
            profile_action: ProfileAction::Isolate,
            credential: CredentialAction::Keep,
            staged_to_discard: Vec::new(),
        })
    }

    /// Logout in one of the three modes. Generation advances first.
    pub fn logout(&mut self, account_id: &AccountId, mode: LogoutMode) -> Result<RevokeList, AppError> {
        let rec = self.record(account_id)?;
        match (mode, &rec.state) {
            (LogoutMode::ExitOnline, AccountState::Online(_)) => {}
            (LogoutMode::ExitOnline, _) => {
                return Err(err(codes::ACCOUNT_INVALID_STATE, "exit-online requires an online account"))
            }
            (LogoutMode::Logout, AccountState::LoggedOut) => {
                return Err(err(codes::ACCOUNT_INVALID_STATE, "already logged out"))
            }
            (LogoutMode::Logout | LogoutMode::Forget, AccountState::LoginPending { .. }) => {
                return Err(err(codes::ACCOUNT_INVALID_STATE, "cancel the pending login first"))
            }
            _ => {}
        }
        let reason = match mode {
            LogoutMode::ExitOnline => GenerationReason::ExitOnline,
            LogoutMode::Logout => GenerationReason::Logout,
            LogoutMode::Forget => GenerationReason::Forget,
        };
        let (old, new) = self.advance(account_id, reason)?;

        match mode {
            LogoutMode::ExitOnline => {
                let has_credential = self.ledger.committed(account_id).is_some();
                let rec = self.record_mut(account_id)?;
                rec.state = if has_credential {
                    AccountState::Suspended(new.clone())
                } else {
                    AccountState::LoggedOut
                };
                rec.transport_connected = false;
                let profile = rec.profile_id.clone();
                self.emit_for(
                    &new,
                    AccountEvent::Changed {
                        account_id: account_id.clone(),
                        change: ChangeKind::State,
                    },
                );
                Ok(RevokeList {
                    account_id: account_id.clone(),
                    environment: new.environment.clone(),
                    revoked_generation: old.session_generation,
                    current_generation: Some(new.session_generation),
                    revoke_jar: true,
                    stop_transport: true,
                    profile,
                    profile_action: ProfileAction::Isolate,
                    credential: CredentialAction::Keep,
                    staged_to_discard: Vec::new(),
                })
            }
            LogoutMode::Logout => {
                let staged = self.abort_pending_credential_ops(account_id);
                let cred = self.ledger.remove_account(account_id);
                let rec = self.record_mut(account_id)?;
                rec.state = AccountState::LoggedOut;
                rec.transport_connected = false;
                let profile = rec.profile_id.take();
                self.emit_for(
                    &new,
                    AccountEvent::Changed {
                        account_id: account_id.clone(),
                        change: ChangeKind::State,
                    },
                );
                Ok(RevokeList {
                    account_id: account_id.clone(),
                    environment: new.environment.clone(),
                    revoked_generation: old.session_generation,
                    current_generation: Some(new.session_generation),
                    revoke_jar: true,
                    stop_transport: true,
                    profile,
                    profile_action: ProfileAction::ClearSiteData,
                    credential: cred.map(CredentialAction::Delete).unwrap_or(CredentialAction::Keep),
                    staged_to_discard: staged,
                })
            }
            LogoutMode::Forget => {
                let staged = self.abort_pending_credential_ops(account_id);
                let cred = self.ledger.remove_account(account_id);
                let rec = self
                    .accounts
                    .remove(account_id)
                    .ok_or_else(|| err(codes::ACCOUNT_UNKNOWN, "unknown account"))?;
                self.authorization_revision += 1;
                self.emit_for(
                    &new,
                    AccountEvent::Removed {
                        account_id: account_id.clone(),
                    },
                );
                Ok(RevokeList {
                    account_id: account_id.clone(),
                    environment: rec.environment,
                    revoked_generation: old.session_generation,
                    current_generation: None,
                    revoke_jar: true,
                    stop_transport: true,
                    profile: rec.profile_id,
                    profile_action: ProfileAction::Delete,
                    credential: cred.map(CredentialAction::Delete).unwrap_or(CredentialAction::Keep),
                    staged_to_discard: staged,
                })
            }
        }
    }

    /// Re-keys an online session (e.g. the host must restart the transport
    /// under a new generation). With `new_profile`, the old profile is
    /// released for deletion.
    pub fn replace_identity(
        &mut self,
        account_id: &AccountId,
        new_profile: Option<ProfileId>,
    ) -> Result<(AccountContext, RevokeList), AppError> {
        let rec = self.record(account_id)?;
        if !matches!(rec.state, AccountState::Online(_)) {
            return Err(err(codes::ACCOUNT_INVALID_STATE, "replace requires an online account"));
        }
        let (old, new) = self.advance(account_id, GenerationReason::Replaced)?;
        let rec = self.record_mut(account_id)?;
        rec.state = AccountState::Online(new.clone());
        rec.transport_connected = false;
        let (profile, action) = match new_profile {
            Some(p) => (rec.profile_id.replace(p), ProfileAction::Delete),
            None => (rec.profile_id.clone(), ProfileAction::Keep),
        };
        self.emit_for(
            &new,
            AccountEvent::Changed {
                account_id: account_id.clone(),
                change: ChangeKind::State,
            },
        );
        Ok((
            new.clone(),
            RevokeList {
                account_id: account_id.clone(),
                environment: new.environment.clone(),
                revoked_generation: old.session_generation,
                current_generation: Some(new.session_generation),
                revoke_jar: true,
                stop_transport: true,
                profile,
                profile_action: action,
                credential: CredentialAction::Keep,
                staged_to_discard: Vec::new(),
            },
        ))
    }

    /// A suspended / invalid account was re-validated with its committed
    /// quick-login credential (server confirmed). Issues a fresh generation
    /// and goes online. A pure network failure must **not** call this and
    /// must not clear anything either.
    pub fn resume_quick_login(&mut self, account_id: &AccountId) -> Result<AccountContext, AppError> {
        let rec = self.record(account_id)?;
        if !matches!(rec.state, AccountState::Suspended(_) | AccountState::Invalid { .. }) {
            return Err(err(codes::ACCOUNT_INVALID_STATE, "quick login requires a suspended account"));
        }
        if self.ledger.committed(account_id).is_none() {
            return Err(err(codes::ACCOUNT_INVALID_STATE, "no committed credential"));
        }
        if rec.profile_id.is_none() {
            return Err(err(codes::ACCOUNT_INVALID_STATE, "no profile bound"));
        }
        let (_, new) = self.advance(account_id, GenerationReason::QuickLoginResumed)?;
        let rec = self.record_mut(account_id)?;
        rec.state = AccountState::Online(new.clone());
        rec.transport_connected = false;
        self.emit_for(
            &new,
            AccountEvent::Changed {
                account_id: account_id.clone(),
                change: ChangeKind::State,
            },
        );
        Ok(new)
    }

    // ------------------------------------------------------ credentials

    fn key_prefix(ctx: &AccountContext) -> String {
        format!("ticket:{}:{}", ctx.environment.as_str(), ctx.account_id.as_str())
    }

    /// Step 1 of the commit protocol (journal only).
    pub fn begin_credential_commit(&mut self, ctx: &AccountContext) -> Result<CredentialOperation, AppError> {
        self.validate(ctx)?;
        let profile = self
            .record(&ctx.account_id)?
            .profile_id
            .clone()
            .ok_or_else(|| err(codes::ACCOUNT_INVALID_STATE, "no profile bound"))?;
        let entry = self
            .ledger
            .prepare(&ctx.account_id, &profile, &Self::key_prefix(ctx));
        Ok(CredentialOperation {
            operation_id: entry.operation_id,
            account_id: ctx.account_id.clone(),
            revision: entry.new_ref.revision,
        })
    }

    /// Step 2: the secret goes to the store under the new revision.
    pub fn stage_credential(
        &mut self,
        operation_id: &str,
        store: &mut dyn SecretStore,
        secret: &Secret,
    ) -> Result<StagedRef, AppError> {
        self.ledger.stage(operation_id, store, secret)
    }

    /// Step 3: atomic index switch, then old revision cleanup. Only after
    /// this returns may the host announce "ready".
    pub fn commit_credential(&mut self, operation_id: &str, store: &mut dyn SecretStore) -> Result<CredentialRef, AppError> {
        let account_id = self
            .ledger
            .journal()
            .get(operation_id)
            .map(|e| e.account_id.clone())
            .ok_or_else(|| err(codes::ACCOUNT_CREDENTIAL_OPERATION, "unknown operation"))?;
        let cref = self.ledger.commit(operation_id, store)?;
        if let Some(ctx) = self.accounts.get(&account_id).map(|r| r.last_ctx.clone()) {
            self.emit_for(
                &ctx,
                AccountEvent::Changed {
                    account_id,
                    change: ChangeKind::CredentialCommitted,
                },
            );
        }
        Ok(cref)
    }

    pub fn abort_credential(&mut self, operation_id: &str, store: &mut dyn SecretStore) -> Result<(), AppError> {
        self.ledger.abort(operation_id, store)
    }

    /// Absorbs a candidate credential update (e.g. a `Set-Cookie` observed
    /// in the profile). `based_on` is the committed revision the observer
    /// saw when it captured the candidate; anything older than the current
    /// revision is rejected so a late response cannot roll back a newer
    /// credential. Runs all three protocol steps.
    pub fn apply_credential_update(
        &mut self,
        ctx: &AccountContext,
        based_on: CredentialRevision,
        store: &mut dyn SecretStore,
        secret: &Secret,
    ) -> Result<CredentialRef, AppError> {
        self.validate(ctx)?;
        self.ledger.check_revision(&ctx.account_id, based_on)?;
        let op = self.begin_credential_commit(ctx)?;
        if let Err(e) = self.stage_credential(&op.operation_id, store, secret) {
            let _ = self.ledger.abort(&op.operation_id, store);
            return Err(e);
        }
        self.commit_credential(&op.operation_id, store)
    }

    pub fn credential_revision(&self, account_id: &AccountId) -> CredentialRevision {
        self.ledger.committed(account_id).map(|r| r.revision).unwrap_or(0)
    }

    /// Restart resolution. Must run before anything is published. Accounts
    /// whose committed secret is missing from the store fall back to
    /// `LoggedOut` and must re-authenticate.
    pub fn recover_credentials(&mut self, store: &mut dyn SecretStore) -> RecoveryReport {
        let report = self.ledger.recover(store);
        for account_id in &report.missing_secret {
            self.ledger.remove_account(account_id);
            if let Some(rec) = self.accounts.get_mut(account_id) {
                if matches!(rec.state, AccountState::Suspended(_)) {
                    rec.state = AccountState::LoggedOut;
                }
                let ctx = rec.last_ctx.clone();
                self.emit_for(
                    &ctx,
                    AccountEvent::Changed {
                        account_id: account_id.clone(),
                        change: ChangeKind::CredentialMissing,
                    },
                );
            }
        }
        report
    }

    // ------------------------------------------------------ work status

    /// Server read-back of the agent work status. The only writer.
    pub fn set_work_status_readback(&mut self, ctx: &AccountContext, status: WorkStatus) -> Result<(), AppError> {
        self.validate(ctx)?;
        let rec = self.record_mut(&ctx.account_id)?;
        if rec.work_status != status {
            rec.work_status = status;
            self.emit_for(
                ctx,
                AccountEvent::Changed {
                    account_id: ctx.account_id.clone(),
                    change: ChangeKind::WorkStatus,
                },
            );
        }
        Ok(())
    }

    pub fn work_status(&self, account_id: &AccountId) -> Option<WorkStatus> {
        self.accounts.get(account_id).map(|r| r.work_status)
    }

    /// Transport dropped. Records connectivity only; the work status is a
    /// business value and is **not** touched.
    pub fn on_transport_disconnected(&mut self, ctx: &AccountContext) -> Result<(), AppError> {
        self.validate(ctx)?;
        self.record_mut(&ctx.account_id)?.transport_connected = false;
        Ok(())
    }

    pub fn on_transport_connected(&mut self, ctx: &AccountContext) -> Result<(), AppError> {
        self.validate(ctx)?;
        self.record_mut(&ctx.account_id)?.transport_connected = true;
        Ok(())
    }

    pub fn transport_connected(&self, account_id: &AccountId) -> Option<bool> {
        self.accounts.get(account_id).map(|r| r.transport_connected)
    }

    // ------------------------------------------------------ list mgmt

    fn sorted_records(&self) -> impl Iterator<Item = &AccountRecord> {
        let mut v: Vec<&AccountRecord> = self.accounts.values().collect();
        v.sort_by(|a, b| {
            (&a.environment, a.order, &a.account_id).cmp(&(&b.environment, b.order, &b.account_id))
        });
        v.into_iter()
    }

    fn env_order(&self, environment: &Environment) -> Vec<AccountId> {
        self.sorted_records()
            .filter(|r| &r.environment == environment)
            .map(|r| r.account_id.clone())
            .collect()
    }

    /// Moves an account to `position` within its environment's list.
    pub fn move_account(&mut self, account_id: &AccountId, position: usize) -> Result<(), AppError> {
        let environment = self.record(account_id)?.environment.clone();
        let mut order = self.env_order(&environment);
        let from = order
            .iter()
            .position(|id| id == account_id)
            .ok_or_else(|| err(codes::ACCOUNT_UNKNOWN, "unknown account"))?;
        let id = order.remove(from);
        let to = position.min(order.len());
        order.insert(to, id);
        self.set_order(&environment, order)
    }

    /// Replaces the ordering of one environment. The list must contain
    /// exactly the accounts of that environment.
    pub fn set_order(&mut self, environment: &Environment, order: Vec<AccountId>) -> Result<(), AppError> {
        let mut expected = self.env_order(environment);
        expected.sort();
        let mut given = order.clone();
        given.sort();
        given.dedup();
        if expected != given || given.len() != order.len() {
            return Err(err(
                codes::ACCOUNT_ORDER_INVALID,
                "order must list exactly the accounts of the environment once",
            ));
        }
        for (i, id) in order.iter().enumerate() {
            if let Some(rec) = self.accounts.get_mut(id) {
                rec.order = i as u32;
            }
        }
        self.emit(
            Scope::App,
            AccountEvent::Reordered {
                environment: environment.clone(),
                order,
            },
        );
        Ok(())
    }

    pub fn set_remark(&mut self, account_id: &AccountId, remark: Option<String>) -> Result<(), AppError> {
        let rec = self.record_mut(account_id)?;
        if rec.remark != remark {
            rec.remark = remark;
            let ctx = rec.last_ctx.clone();
            self.emit_for(
                &ctx,
                AccountEvent::Changed {
                    account_id: account_id.clone(),
                    change: ChangeKind::Remark,
                },
            );
        }
        Ok(())
    }

    /// Desensitized list snapshot taken from the same commit sequence as
    /// the events (`seq` = last emitted seq).
    pub fn account_snapshot(&self) -> Snapshot<AccountListSnapshot> {
        let accounts = self
            .sorted_records()
            .map(|r| AccountSummary {
                account_id: r.account_id.clone(),
                environment: r.environment.clone(),
                state: r.state.kind(),
                session_generation: r.state.context().map(|c| c.session_generation),
                remark: r.remark.clone(),
                order: r.order,
                work_status: r.work_status,
                quick_login_available: matches!(r.state, AccountState::Suspended(_))
                    && self.ledger.committed(&r.account_id).is_some(),
                credential_revision: self.credential_revision(&r.account_id),
                invalid_reason: match &r.state {
                    AccountState::Invalid { reason, .. } => Some(reason.clone()),
                    _ => None,
                },
            })
            .collect();
        Snapshot {
            scope: Scope::Aggregate(AggregateScope {
                subscription_id: ACCOUNT_LIST_SUBSCRIPTION.to_string(),
                authorization_revision: self.authorization_revision,
            }),
            stream: ACCOUNT_STREAM.to_string(),
            epoch: self.boot_epoch,
            seq: self.seq,
            data: AccountListSnapshot { accounts },
        }
    }

    // ------------------------------------------------------ persistence

    /// Non-secret persistent document: identity index, credential ledger
    /// (references only) and account rows. Work status and transport
    /// connectivity are runtime values and are not persisted.
    pub fn to_json(&self) -> JsonValue {
        let accounts = self
            .sorted_records()
            .map(|r| {
                let mut o = JsonValue::object();
                o.insert("account_id", JsonValue::string(r.account_id.as_str()));
                o.insert("environment", JsonValue::string(r.environment.as_str()));
                o.insert("uid", JsonValue::string(&r.uid));
                o.insert(
                    "agent_id",
                    r.agent_id.as_deref().map(JsonValue::string).unwrap_or(JsonValue::Null),
                );
                o.insert(
                    "profile_id",
                    r.profile_id.as_ref().map(|p| JsonValue::string(p.as_str())).unwrap_or(JsonValue::Null),
                );
                o.insert(
                    "remark",
                    r.remark.as_deref().map(JsonValue::string).unwrap_or(JsonValue::Null),
                );
                o.insert("order", JsonValue::number_from_i64(r.order as i64));
                let (state, reason) = match &r.state {
                    AccountState::Invalid { reason, .. } => ("invalid", Some(reason.clone())),
                    AccountState::LoggedOut => ("logged_out", None),
                    // Online / Suspended / LoginPending all restart as
                    // "needs validation with the committed credential".
                    _ => ("suspended", None),
                };
                o.insert("state", JsonValue::string(state));
                o.insert(
                    "invalid_reason",
                    reason.map(JsonValue::string).unwrap_or(JsonValue::Null),
                );
                o
            })
            .collect();
        let mut doc = JsonValue::object();
        doc.insert("version", JsonValue::number_from_i64(1));
        doc.insert("index", self.index.to_json());
        doc.insert("ledger", self.ledger.to_json());
        doc.insert("accounts", JsonValue::Array(accounts));
        doc
    }

    /// Restores from [`AccountRegistry::to_json`]. Every restored account
    /// starts with a fresh generation floor (`boot_epoch`), so contexts
    /// from the previous run are stale. Call
    /// [`AccountRegistry::recover_credentials`] next.
    pub fn restore(doc: &JsonValue, boot_epoch: u64) -> Result<Self, AppError> {
        let corrupt = |m: &str| err(codes::ACCOUNT_RESTORE_CORRUPT, format!("registry: {m}"));
        let index = IdentityIndex::from_json(doc.get("index").ok_or_else(|| corrupt("missing index"))?)?;
        let ledger = CredentialLedger::from_json(doc.get("ledger").ok_or_else(|| corrupt("missing ledger"))?)?;
        let mut reg = Self::new(boot_epoch);
        reg.index = index;
        reg.ledger = ledger;
        let rows = doc
            .get("accounts")
            .and_then(JsonValue::as_array)
            .ok_or_else(|| corrupt("missing accounts"))?;
        for row in rows {
            let s = |k: &str| row.get(k).and_then(JsonValue::as_str).map(str::to_string);
            let account_id = AccountId::new(s("account_id").ok_or_else(|| corrupt("account_id"))?);
            let environment = Environment::named(s("environment").ok_or_else(|| corrupt("environment"))?);
            let entry = reg
                .index
                .entry_for_mut(&account_id)
                .ok_or_else(|| corrupt("account without index entry"))?;
            if entry.environment != environment {
                return Err(corrupt("account environment differs from index"));
            }
            // A restart revokes every handle of the previous run: the
            // restored generation is strictly newer than anything issued
            // before (and at least `boot_epoch`, so an older backup cannot
            // bring a used generation back).
            entry.last_generation = (entry.last_generation + 1).max(boot_epoch);
            let last_ctx = AccountContext::new(account_id.clone(), environment.clone(), entry.last_generation);
            let has_credential = reg.ledger.committed(&account_id).is_some();
            let profile_id = s("profile_id").map(ProfileId::new);
            let state = match s("state").as_deref() {
                Some("invalid") => AccountState::Invalid {
                    ctx: last_ctx.clone(),
                    reason: s("invalid_reason").unwrap_or_else(|| "restored".to_string()),
                },
                Some("suspended") if has_credential && profile_id.is_some() => {
                    AccountState::Suspended(last_ctx.clone())
                }
                _ => AccountState::LoggedOut,
            };
            reg.accounts.insert(
                account_id.clone(),
                AccountRecord {
                    account_id,
                    environment,
                    state,
                    prior_state: None,
                    last_ctx,
                    uid: s("uid").unwrap_or_default(),
                    agent_id: s("agent_id"),
                    profile_id,
                    remark: s("remark"),
                    order: u32::try_from(row.get("order").and_then(JsonValue::as_i64).unwrap_or(0).max(0))
                        .unwrap_or(u32::MAX),
                    work_status: WorkStatus::Unknown,
                    transport_connected: false,
                },
            );
        }
        reg.authorization_revision = 1;
        Ok(reg)
    }
}

/// Store used when a pending operation is aborted during logout: the
/// staged secret is reported in the `RevokeList` instead of being deleted
/// here, because the registry has no store handle at that point.
struct NullStore;

impl SecretStore for NullStore {
    fn stage(&mut self, _: &CredentialRef, _: &Secret) -> Result<StagedRef, AppError> {
        Err(err(codes::ACCOUNT_CREDENTIAL_STORE, "null store"))
    }
    fn commit(&mut self, _: &StagedRef) -> Result<(), AppError> {
        Err(err(codes::ACCOUNT_CREDENTIAL_STORE, "null store"))
    }
    fn discard(&mut self, _: &StagedRef) -> Result<(), AppError> {
        Ok(())
    }
    fn delete(&mut self, _: &CredentialRef) -> Result<(), AppError> {
        Ok(())
    }
    fn contains(&self, _: &CredentialRef) -> bool {
        false
    }
}

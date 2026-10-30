//! Lifecycle scenarios through the public API (ACC-01 / ACC-04 / F01 / F03).

use contracts::{AccountContext, Environment, Scope};
use core_account::{
    codes, AccountEvent, AccountRegistry, AccountState, AccountStateKind, Buid, CredentialAction,
    GenerationReason, LogoutMode, MemorySecretStore, ProfileAction, Secret, UpstreamIdentity,
    WorkStatus,
};

const BOOT: u64 = 1;

fn env() -> Environment {
    Environment::named("test-env")
}

fn identity(buid: &str) -> UpstreamIdentity {
    UpstreamIdentity {
        buid: Buid::new(buid),
        uid: format!("uid-{buid}"),
        agent_id: Some(format!("agent-{buid}")),
        environment: env(),
    }
}

fn login(reg: &mut AccountRegistry, buid: &str) -> AccountContext {
    let attempt = reg.start_login(env());
    reg.publish_identity(&attempt.attempt_id, identity(buid))
        .expect("publish")
        .ctx
}

fn commit_secret(
    reg: &mut AccountRegistry,
    store: &mut MemorySecretStore,
    ctx: &AccountContext,
    bytes: &[u8],
) {
    let op = reg.begin_credential_commit(ctx).expect("prepare");
    reg.stage_credential(&op.operation_id, store, &Secret::new(bytes.to_vec()))
        .expect("stage");
    reg.commit_credential(&op.operation_id, store)
        .expect("commit");
}

#[test]
fn attempt_has_no_context_until_identity_is_published() {
    let mut reg = AccountRegistry::new(BOOT);
    let attempt = reg.start_login(env());
    assert!(reg.account_snapshot().data.accounts.is_empty());
    assert!(
        reg.drain_events().is_empty(),
        "starting an attempt publishes nothing"
    );

    let out = reg
        .publish_identity(&attempt.attempt_id, identity("buid-a"))
        .expect("publish");
    assert!(out.is_new_account);
    assert!(out.revoke.is_none());
    assert_eq!(out.ctx.environment, env());
    assert_eq!(reg.validate(&out.ctx), Ok(()));

    let events = reg.drain_events();
    assert!(matches!(events[0].payload, AccountEvent::Added { .. }));
    assert!(matches!(
        events[1].payload,
        AccountEvent::GenerationAdvanced {
            reason: GenerationReason::Published,
            ..
        }
    ));
    assert!(events
        .iter()
        .all(|e| e.scope == Scope::Account(out.ctx.clone())));

    // The attempt is consumed; a second publish for it is a late callback.
    let late = reg
        .publish_identity(&attempt.attempt_id, identity("buid-a"))
        .expect_err("late");
    assert!(late.is(codes::ACCOUNT_ATTEMPT_UNKNOWN));
}

#[test]
fn cancelled_attempt_rejects_late_identity_result() {
    let mut reg = AccountRegistry::new(BOOT);
    let attempt = reg.start_login(env());
    let profile = reg.cancel_login(&attempt.attempt_id).expect("cancel");
    assert_eq!(profile, attempt.profile_id);
    let late = reg
        .publish_identity(&attempt.attempt_id, identity("buid-a"))
        .expect_err("late result after cancel");
    assert!(late.is(codes::ACCOUNT_ATTEMPT_CANCELLED));
    assert!(reg.account_snapshot().data.accounts.is_empty());
}

#[test]
fn late_callback_with_old_generation_is_rejected_after_logout() {
    let mut reg = AccountRegistry::new(BOOT);
    let ctx = login(&mut reg, "buid-a");
    assert_eq!(reg.validate(&ctx), Ok(()));

    let revoke = reg
        .logout(&ctx.account_id, LogoutMode::Logout)
        .expect("logout");
    // Generation advanced BEFORE resources are released.
    assert_eq!(revoke.revoked_generation, ctx.session_generation);
    assert!(revoke.current_generation.expect("current") > ctx.session_generation);
    assert!(revoke.revoke_jar && revoke.stop_transport);
    assert_eq!(revoke.profile_action, ProfileAction::ClearSiteData);

    // A late HTTP / IM callback carrying the old context must be rejected.
    let e = reg.validate(&ctx).expect_err("stale");
    assert!(e.is(codes::ACCOUNT_STALE_GENERATION));
    assert!(reg.on_transport_disconnected(&ctx).is_err());
    assert!(reg
        .set_work_status_readback(&ctx, WorkStatus::OffDuty)
        .expect_err("stale")
        .is(codes::ACCOUNT_STALE_GENERATION));

    // Even the *new* generation is not usable: the account is logged out.
    let new_ctx = ctx.next_generation();
    let e = reg.validate(&new_ctx).expect_err("not online");
    assert!(e.is(codes::ACCOUNT_NOT_ONLINE));

    // Unknown id and forged future generation.
    let unknown = AccountContext::new(contracts::AccountId::new("acc_nope"), env(), 1);
    assert!(reg
        .validate(&unknown)
        .expect_err("unknown")
        .is(codes::ACCOUNT_UNKNOWN));
    let forged = AccountContext::new(ctx.account_id.clone(), env(), 10_000);
    assert!(reg
        .validate(&forged)
        .expect_err("forged")
        .is(codes::ACCOUNT_UNKNOWN));
}

#[test]
fn two_accounts_are_fully_isolated() {
    let mut reg = AccountRegistry::new(BOOT);
    let a = login(&mut reg, "buid-a");
    let b = login(&mut reg, "buid-b");
    assert_ne!(a.account_id, b.account_id);
    reg.drain_events();

    // Invalidate A: B's context stays valid, and every event is scoped to A.
    let revoke = reg
        .invalidate(&a.account_id, "ticket expired")
        .expect("invalidate");
    assert_eq!(revoke.account_id, a.account_id);
    assert_eq!(reg.validate(&b), Ok(()));
    assert!(reg
        .validate(&a)
        .expect_err("a stale")
        .is(codes::ACCOUNT_STALE_GENERATION));
    let events = reg.drain_events();
    assert!(!events.is_empty());
    for e in &events {
        let scope = e.scope.account().expect("account scoped");
        assert_eq!(scope.account_id, a.account_id);
        assert_ne!(scope.account_id, b.account_id);
    }

    // A context with A's generation but B's id is not valid for B.
    let crossed = AccountContext::new(b.account_id.clone(), env(), a.session_generation);
    assert!(reg.validate(&crossed).is_err() || a.session_generation == b.session_generation);

    // Work status and remarks are per account.
    reg.set_work_status_readback(&b, WorkStatus::Away)
        .expect("readback");
    assert_eq!(reg.work_status(&a.account_id), Some(WorkStatus::Unknown));
    assert_eq!(reg.work_status(&b.account_id), Some(WorkStatus::Away));

    let snap = reg.account_snapshot();
    assert_eq!(snap.data.accounts.len(), 2);
    let text = format!("{:?}", snap);
    assert!(
        !text.contains("buid-"),
        "snapshot must not carry the upstream buid"
    );
    assert!(!text.contains("uid-"), "snapshot must not carry the uid");
}

#[test]
fn same_upstream_identity_reauth_maps_to_same_account_with_new_generation() {
    let mut reg = AccountRegistry::new(BOOT);
    let first = login(&mut reg, "buid-a");
    reg.logout(&first.account_id, LogoutMode::Logout)
        .expect("logout");
    reg.drain_events();

    let second = login(&mut reg, "buid-a");
    assert_eq!(
        second.account_id, first.account_id,
        "same (env,buid) → same AccountId"
    );
    assert!(second.session_generation > first.session_generation);
    assert_eq!(reg.validate(&second), Ok(()));
    assert!(reg
        .validate(&first)
        .expect_err("old")
        .is(codes::ACCOUNT_STALE_GENERATION));
    assert_eq!(reg.account_snapshot().data.accounts.len(), 1);

    // A different buid is a different account.
    let other = login(&mut reg, "buid-b");
    assert_ne!(other.account_id, first.account_id);
    assert_eq!(reg.account_snapshot().data.accounts.len(), 2);
}

#[test]
fn relogin_while_online_replaces_session_and_revokes_old_one() {
    let mut reg = AccountRegistry::new(BOOT);
    let first = login(&mut reg, "buid-a");
    let attempt = reg.start_relogin(&first.account_id).expect("relogin");
    assert!(matches!(
        reg.state(&first.account_id),
        Some(AccountState::Online(_))
    ));
    let out = reg
        .publish_identity(&attempt.attempt_id, identity("buid-a"))
        .expect("publish");
    assert!(!out.is_new_account);
    let revoke = out.revoke.expect("old session revoked");
    assert_eq!(revoke.revoked_generation, first.session_generation);
    assert_eq!(revoke.profile_action, ProfileAction::Delete);
    assert_eq!(
        reg.profile_of(&out.ctx).expect("profile"),
        attempt.profile_id
    );
    assert!(reg.validate(&first).is_err());
}

#[test]
fn relogin_with_different_identity_does_not_touch_target() {
    let mut reg = AccountRegistry::new(BOOT);
    let a = login(&mut reg, "buid-a");
    reg.invalidate(&a.account_id, "ticket expired")
        .expect("invalidate");
    let attempt = reg.start_relogin(&a.account_id).expect("relogin");
    assert_eq!(
        reg.state(&a.account_id).map(AccountState::kind),
        Some(AccountStateKind::LoginPending)
    );
    assert!(
        reg.current_context(&a.account_id).is_none(),
        "pending login has no context"
    );
    let e = reg
        .publish_identity(&attempt.attempt_id, identity("buid-b"))
        .expect_err("mismatch");
    assert!(e.is(codes::ACCOUNT_IDENTITY_MISMATCH));
    // Target untouched, attempt still open so the host can cancel it.
    assert_eq!(reg.account_snapshot().data.accounts.len(), 1);
    assert!(reg.attempt(&attempt.attempt_id).is_some());
    reg.cancel_login(&attempt.attempt_id).expect("cancel");
    assert_eq!(
        reg.state(&a.account_id).map(AccountState::kind),
        Some(AccountStateKind::Invalid)
    );

    // A successful re-login of the same identity replaces the invalid session.
    let attempt = reg.start_relogin(&a.account_id).expect("relogin");
    let out = reg
        .publish_identity(&attempt.attempt_id, identity("buid-a"))
        .expect("publish");
    assert_eq!(out.ctx.account_id, a.account_id);
    assert!(
        out.revoke.is_some(),
        "the invalid session's profile is released"
    );
    assert_eq!(reg.validate(&out.ctx), Ok(()));
}

#[test]
fn forget_then_reauth_reassociates_same_account_id() {
    let mut reg = AccountRegistry::new(BOOT);
    let mut store = MemorySecretStore::new();
    let first = login(&mut reg, "buid-a");
    commit_secret(&mut reg, &mut store, &first, b"PLACEHOLDER-1");
    reg.set_remark(&first.account_id, Some("shop A".into()))
        .expect("remark");
    reg.drain_events();

    let revoke = reg
        .logout(&first.account_id, LogoutMode::Forget)
        .expect("forget");
    assert_eq!(revoke.profile_action, ProfileAction::Delete);
    assert!(matches!(revoke.credential, CredentialAction::Delete(_)));
    assert!(revoke.current_generation.is_none());
    assert!(reg.account_snapshot().data.accounts.is_empty());
    assert!(reg.state(&first.account_id).is_none());
    let events = reg.drain_events();
    assert!(events
        .iter()
        .any(|e| matches!(e.payload, AccountEvent::Removed { .. })));
    // The non-secret stable index survives.
    assert_eq!(reg.index().len(), 1);

    let again = login(&mut reg, "buid-a");
    assert_eq!(
        again.account_id, first.account_id,
        "forget keeps the stable index"
    );
    assert!(again.session_generation > first.session_generation);
    assert!(reg
        .validate(&first)
        .expect_err("old")
        .is(codes::ACCOUNT_STALE_GENERATION));
    // Credential was dropped with the account; quick login not available.
    assert_eq!(reg.credential_revision(&again.account_id), 0);
}

#[test]
fn exit_online_keeps_credential_and_quick_login_resumes_with_new_generation() {
    let mut reg = AccountRegistry::new(BOOT);
    let mut store = MemorySecretStore::new();
    let ctx = login(&mut reg, "buid-a");
    commit_secret(&mut reg, &mut store, &ctx, b"PLACEHOLDER-1");

    let revoke = reg
        .logout(&ctx.account_id, LogoutMode::ExitOnline)
        .expect("exit online");
    assert_eq!(revoke.credential, CredentialAction::Keep);
    assert_eq!(revoke.profile_action, ProfileAction::Isolate);
    assert!(matches!(
        reg.state(&ctx.account_id),
        Some(AccountState::Suspended(_))
    ));
    let snap = reg.account_snapshot();
    assert!(snap.data.accounts[0].quick_login_available);
    assert!(reg.validate(&ctx).is_err());

    let resumed = reg.resume_quick_login(&ctx.account_id).expect("resume");
    assert!(resumed.session_generation > revoke.current_generation.expect("gen"));
    assert_eq!(reg.validate(&resumed), Ok(()));
}

#[test]
fn work_status_is_not_changed_by_transport_disconnect() {
    let mut reg = AccountRegistry::new(BOOT);
    let ctx = login(&mut reg, "buid-a");
    reg.set_work_status_readback(&ctx, WorkStatus::Online)
        .expect("readback");
    reg.on_transport_connected(&ctx).expect("connected");
    assert_eq!(reg.transport_connected(&ctx.account_id), Some(true));
    reg.drain_events();

    reg.on_transport_disconnected(&ctx).expect("disconnected");
    assert_eq!(reg.transport_connected(&ctx.account_id), Some(false));
    assert_eq!(reg.work_status(&ctx.account_id), Some(WorkStatus::Online));
    assert!(reg.drain_events().is_empty(), "no work-status change event");

    // Even invalidation leaves the last read-back value alone.
    reg.invalidate(&ctx.account_id, "ticket expired")
        .expect("invalidate");
    assert_eq!(reg.work_status(&ctx.account_id), Some(WorkStatus::Online));
}

#[test]
fn ordering_and_remarks_emit_app_or_account_scoped_events_with_monotonic_seq() {
    let mut reg = AccountRegistry::new(BOOT);
    let a = login(&mut reg, "buid-a");
    let b = login(&mut reg, "buid-b");
    let c = login(&mut reg, "buid-c");
    reg.drain_events();
    let seq0 = reg.account_snapshot().seq;

    reg.move_account(&c.account_id, 0).expect("move");
    let snap = reg.account_snapshot();
    let ids: Vec<_> = snap
        .data
        .accounts
        .iter()
        .map(|s| s.account_id.clone())
        .collect();
    assert_eq!(
        ids,
        vec![
            c.account_id.clone(),
            a.account_id.clone(),
            b.account_id.clone()
        ]
    );
    assert!(snap.seq > seq0);

    let events = reg.drain_events();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].scope, Scope::App);
    assert!(matches!(events[0].payload, AccountEvent::Reordered { .. }));
    assert_eq!(events[0].seq, snap.seq);

    reg.set_remark(&b.account_id, Some("备注".into()))
        .expect("remark");
    let events = reg.drain_events();
    assert_eq!(events[0].scope, Scope::Account(b.clone()));
    assert!(events[0].seq > snap.seq);

    let bad = reg.set_order(&env(), vec![a.account_id.clone()]);
    assert!(bad
        .expect_err("incomplete order")
        .is(codes::ACCOUNT_ORDER_INVALID));
}

#[test]
fn restart_restores_accounts_and_never_reaccepts_old_generations() {
    let mut reg = AccountRegistry::new(100);
    let mut store = MemorySecretStore::new();
    let ctx = login(&mut reg, "buid-a");
    commit_secret(&mut reg, &mut store, &ctx, b"PLACEHOLDER-1");
    let doc = reg.to_json();
    let text = doc.to_json();
    assert!(!text.contains("PLACEHOLDER"));

    // Restart with a larger boot epoch (as a clock-derived value would be).
    let parsed = contracts::json::JsonValue::parse(&text).expect("parse");
    let mut restarted = AccountRegistry::restore(&parsed, 200).expect("restore");
    let report = restarted.recover_credentials(&mut store);
    assert!(report.missing_secret.is_empty());
    assert!(matches!(
        restarted.state(&ctx.account_id),
        Some(AccountState::Suspended(_))
    ));
    assert!(restarted
        .validate(&ctx)
        .expect_err("old run")
        .is(codes::ACCOUNT_STALE_GENERATION));

    let resumed = restarted
        .resume_quick_login(&ctx.account_id)
        .expect("resume");
    assert!(resumed.session_generation >= 200);

    // A restore from an *older* backup with the same clock floor still
    // cannot reuse the generation issued above.
    let mut from_backup = AccountRegistry::restore(&parsed, 200).expect("restore");
    from_backup.recover_credentials(&mut store);
    let again = from_backup
        .resume_quick_login(&ctx.account_id)
        .expect("resume");
    assert!(again.session_generation >= 200);
    assert!(from_backup.validate(&ctx).is_err());
}

#[test]
fn restored_order_at_u32_max_does_not_overflow_when_adding_an_account() {
    // QA regression: `next_order` computed `order + 1`; a restored row with
    // order u32::MAX (hostile or truncated document) made the next
    // `publish_identity` panic.
    let mut reg = AccountRegistry::new(BOOT);
    let ctx = login(&mut reg, "buid-a");
    let mut doc = reg.to_json();
    let mut accounts = doc
        .get("accounts")
        .and_then(|v| v.as_array().cloned())
        .expect("accounts");
    accounts[0].insert(
        "order",
        contracts::json::JsonValue::number_from_i64(i64::from(u32::MAX)),
    );
    doc.insert("accounts", contracts::json::JsonValue::Array(accounts));
    let mut reg = AccountRegistry::restore(&doc, BOOT + 1).expect("restore");
    let other = login(&mut reg, "buid-b");
    assert_ne!(other.account_id, ctx.account_id);
    let snap = reg.account_snapshot();
    assert_eq!(snap.data.accounts.len(), 2);
    // Out-of-range orders saturate instead of truncating to a small value.
    let mut doc = reg.to_json();
    let mut accounts = doc
        .get("accounts")
        .and_then(|v| v.as_array().cloned())
        .expect("accounts");
    accounts[0].insert(
        "order",
        contracts::json::JsonValue::number_from_i64(1 << 40),
    );
    doc.insert("accounts", contracts::json::JsonValue::Array(accounts));
    let reg = AccountRegistry::restore(&doc, BOOT + 2).expect("restore");
    assert!(reg
        .account_snapshot()
        .data
        .accounts
        .iter()
        .any(|a| a.order == u32::MAX));
}

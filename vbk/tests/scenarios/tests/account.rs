//! Q11 — account: Forget then re-auth with the same `(environment, buid)`
//! yields the same `AccountId` (so store namespaces and im snapshots are
//! re-associated); credential journal crash recovery; transport disconnect
//! never changes the work status; events are scoped per account (plan §7
//! "保留账号数据与重认领" / "关键凭据崩溃恢复", F01/F03).
#![allow(clippy::unwrap_used)]

mod common;

use common::*;
use contracts::json::JsonValue;
use contracts::{AccountContext, Environment, Scope};
use core_account::{
    AccountEvent, AccountRegistry, AccountStateKind, Buid, CommitStage, LogoutMode,
    MemorySecretStore, Secret, UpstreamIdentity, WorkStatus,
};
use core_im::ImCore;
use core_store::{DraftRepo, MemoryStore, Namespace, SendIntentRecord, SendIntentRepo, Store};

fn env() -> Environment {
    Environment::named("test")
}

fn identity(buid: &str) -> UpstreamIdentity {
    UpstreamIdentity {
        buid: Buid::new(buid),
        uid: format!("uid-{buid}"),
        agent_id: None,
        environment: env(),
    }
}

fn login(reg: &mut AccountRegistry, buid: &str) -> AccountContext {
    let h = reg.start_login(env());
    reg.publish_identity(&h.attempt_id, identity(buid))
        .unwrap()
        .ctx
}

#[test]
fn forget_then_reauth_keeps_account_id_and_reattaches_store_and_im_state() {
    let mut reg = AccountRegistry::new(10);
    let store = MemoryStore::new();
    let ctx1 = login(&mut reg, "buid-1");
    let ns = Namespace::from_context(&ctx1);
    // Unique local data under the identity: a draft and an unknown intent.
    let mut txn = store.begin(&ns).unwrap();
    DraftRepo::save_draft(&store, &mut txn, GID, "draft", 0).unwrap();
    SendIntentRepo::put(&mut txn, &SendIntentRecord::new("l1", GID, ctx1.clone(), 1)).unwrap();
    store.commit(txn).unwrap();
    let mut h = ImHarness::with_account(ctx1.clone());
    h.message(customer("c1", 10_000));
    let im_state = h.core.persisted_state();

    let revoke = reg.logout(&ctx1.account_id, LogoutMode::Forget).unwrap();
    assert_eq!(revoke.current_generation, None);
    assert!(reg.state(&ctx1.account_id).is_none());
    assert!(
        reg.account_for(&env(), &Buid::new("buid-1")).is_none(),
        "not an account any more"
    );
    store.logout_lock(&ns).unwrap();
    // The non-secret index survives a restart.
    let doc = reg.to_json();
    let text = doc.to_json();
    assert!(!text.contains("PLACEHOLDER"));
    let mut reg = AccountRegistry::restore(&JsonValue::parse(&text).unwrap(), 20).unwrap();

    let ctx2 = login(&mut reg, "buid-1");
    assert_eq!(
        ctx2.account_id, ctx1.account_id,
        "same upstream identity → same local id"
    );
    assert!(ctx2.session_generation > ctx1.session_generation);
    assert!(reg
        .validate(&ctx1)
        .unwrap_err()
        .is(contracts::codes::ACCOUNT_STALE_GENERATION));
    // Store namespace is the same; im snapshot re-binds under the new context.
    assert_eq!(Namespace::from_context(&ctx2), ns);
    store.unlock_after_reauth(&ns).unwrap();
    assert_eq!(
        DraftRepo::load(&store, &ns, GID).unwrap().unwrap().text,
        "draft"
    );
    assert_eq!(
        SendIntentRepo::unknown_intents(&store, &ns).unwrap().len(),
        1
    );
    let core = ImCore::restore_as(im_state, ctx2.clone()).unwrap();
    assert_eq!(core.account(), &ctx2);
    assert!(core.round_state(GID).is_pending());
    // A different buid in the same environment is a different account.
    let ctx3 = login(&mut reg, "buid-2");
    assert_ne!(ctx3.account_id, ctx2.account_id);
    assert_ne!(Namespace::from_context(&ctx3), ns);
}

#[test]
fn credential_journal_recovers_from_a_crash_at_every_stage() {
    // Stage: journal written, secret staged, index not switched → rollback.
    let mut reg = AccountRegistry::new(10);
    let mut store = MemorySecretStore::new();
    let ctx = login(&mut reg, "buid-1");
    let op1 = reg.begin_credential_commit(&ctx).unwrap();
    reg.stage_credential(
        &op1.operation_id,
        &mut store,
        &Secret::new(b"PLACEHOLDER-R1".to_vec()),
    )
    .unwrap();
    reg.commit_credential(&op1.operation_id, &mut store)
        .unwrap();
    assert_eq!(reg.credential_revision(&ctx.account_id), 1);
    let op2 = reg.begin_credential_commit(&ctx).unwrap();
    reg.stage_credential(
        &op2.operation_id,
        &mut store,
        &Secret::new(b"PLACEHOLDER-R2".to_vec()),
    )
    .unwrap();
    assert_eq!(
        reg.ledger().journal().get(&op2.operation_id).unwrap().stage,
        CommitStage::SecretStaged
    );
    // ---- crash: persist the non-secret document, restart ----
    let doc = reg.to_json().to_json();
    assert!(
        !doc.contains("PLACEHOLDER"),
        "no secret in the registry document"
    );
    let mut reg = AccountRegistry::restore(&JsonValue::parse(&doc).unwrap(), 20).unwrap();
    let report = reg.recover_credentials(&mut store);
    assert_eq!(report.rolled_back, vec![op2.operation_id.clone()]);
    assert!(report.missing_secret.is_empty());
    assert_eq!(
        reg.credential_revision(&ctx.account_id),
        1,
        "previous revision stays effective"
    );
    assert_eq!(store.committed_keys().len(), 1);
    assert!(store.staged_keys().is_empty(), "staged r2 discarded");
    assert_eq!(
        reg.state(&ctx.account_id).unwrap().kind(),
        AccountStateKind::Suspended,
        "quick login available"
    );
    // A revision number is never reused after a rollback.
    let ctx2 = reg.resume_quick_login(&ctx.account_id).unwrap();
    let op3 = reg.begin_credential_commit(&ctx2).unwrap();
    assert_eq!(op3.revision, 3);

    // Stage: index switched, old revision not yet deleted → cleanup only.
    reg.stage_credential(
        &op3.operation_id,
        &mut store,
        &Secret::new(b"PLACEHOLDER-R3".to_vec()),
    )
    .unwrap();
    reg.commit_credential(&op3.operation_id, &mut store)
        .unwrap();
    assert_eq!(reg.credential_revision(&ctx.account_id), 3);
    assert!(reg.ledger().journal().is_empty());

    // Stage: committed entry missing from the store → must re-authenticate.
    let doc = reg.to_json().to_json();
    let mut reg = AccountRegistry::restore(&JsonValue::parse(&doc).unwrap(), 30).unwrap();
    let mut empty = MemorySecretStore::new();
    let report = reg.recover_credentials(&mut empty);
    assert_eq!(report.missing_secret, vec![ctx.account_id.clone()]);
    assert_eq!(
        reg.state(&ctx.account_id).unwrap().kind(),
        AccountStateKind::LoggedOut
    );
    assert!(reg.resume_quick_login(&ctx.account_id).is_err());
    assert_eq!(reg.credential_revision(&ctx.account_id), 0);
}

#[test]
fn stale_credential_update_cannot_roll_back_a_newer_revision() {
    let mut reg = AccountRegistry::new(10);
    let mut store = MemorySecretStore::new();
    let ctx = login(&mut reg, "buid-1");
    let r1 = reg
        .apply_credential_update(&ctx, 0, &mut store, &Secret::new(b"PLACEHOLDER-1".to_vec()))
        .unwrap();
    let r2 = reg
        .apply_credential_update(
            &ctx,
            r1.revision,
            &mut store,
            &Secret::new(b"PLACEHOLDER-2".to_vec()),
        )
        .unwrap();
    assert_eq!(r2.revision, 2);
    let e = reg
        .apply_credential_update(
            &ctx,
            r1.revision,
            &mut store,
            &Secret::new(b"PLACEHOLDER-OLD".to_vec()),
        )
        .unwrap_err();
    assert!(e.is(core_account::codes::ACCOUNT_STALE_CREDENTIAL_REVISION));
    assert_eq!(reg.credential_revision(&ctx.account_id), 2);
    assert_eq!(
        store.read_committed(&r2).unwrap().expose(),
        b"PLACEHOLDER-2"
    );
    // After logout the old context cannot write credentials either.
    reg.logout(&ctx.account_id, LogoutMode::Logout).unwrap();
    assert!(reg
        .apply_credential_update(
            &ctx,
            2,
            &mut store,
            &Secret::new(b"PLACEHOLDER-LATE".to_vec())
        )
        .unwrap_err()
        .is(contracts::codes::ACCOUNT_STALE_GENERATION));
}

#[test]
fn transport_disconnect_never_changes_work_status_and_events_are_account_scoped() {
    let mut reg = AccountRegistry::new(10);
    let a = login(&mut reg, "buid-a");
    let b = login(&mut reg, "buid-b");
    reg.drain_events();
    reg.set_work_status_readback(&a, WorkStatus::Online)
        .unwrap();
    reg.set_work_status_readback(&b, WorkStatus::Away).unwrap();
    reg.on_transport_connected(&a).unwrap();
    reg.on_transport_disconnected(&a).unwrap();
    assert_eq!(reg.work_status(&a.account_id), Some(WorkStatus::Online));
    assert_eq!(reg.transport_connected(&a.account_id), Some(false));
    // Even repeated drops and a reconnect leave the business value alone.
    for _ in 0..3 {
        reg.on_transport_disconnected(&a).unwrap();
        reg.on_transport_connected(&a).unwrap();
    }
    assert_eq!(reg.work_status(&a.account_id), Some(WorkStatus::Online));
    assert_eq!(reg.work_status(&b.account_id), Some(WorkStatus::Away));
    let events = reg.drain_events();
    assert!(!events.is_empty());
    for e in &events {
        match &e.scope {
            Scope::Account(ctx) => match &e.payload {
                AccountEvent::Changed { account_id, .. } => assert_eq!(account_id, &ctx.account_id),
                other => panic!("unexpected {other:?}"),
            },
            other => panic!("transport/work-status events must be account scoped, got {other:?}"),
        }
    }
    assert!(events.iter().all(|e| !matches!(
        e.payload,
        AccountEvent::Changed {
            change: core_account::ChangeKind::WorkStatus,
            ..
        }
    ) || e.scope.account().is_some()));
    // Invalidating b does not touch a's events or status.
    reg.invalidate(&b.account_id, "ticket expired").unwrap();
    let events = reg.drain_events();
    assert!(events
        .iter()
        .all(|e| e.scope.account().map(|c| &c.account_id) == Some(&b.account_id)));
    assert_eq!(reg.work_status(&a.account_id), Some(WorkStatus::Online));
    assert!(reg.validate(&a).is_ok());
    // The desensitized snapshot carries neither buid nor uid.
    let snap = reg.account_snapshot();
    let text = format!("{snap:?}");
    assert!(!text.contains("buid-"));
    assert!(!text.contains("uid-"));
}

#[test]
fn relogin_with_another_identity_leaves_the_target_untouched() {
    let mut reg = AccountRegistry::new(10);
    let a = login(&mut reg, "buid-a");
    let h = reg.start_relogin(&a.account_id).unwrap();
    let e = reg
        .publish_identity(&h.attempt_id, identity("buid-other"))
        .unwrap_err();
    assert!(e.is(core_account::codes::ACCOUNT_IDENTITY_MISMATCH));
    assert!(
        reg.validate(&a).is_ok(),
        "target still online under its generation"
    );
    assert!(reg.account_for(&env(), &Buid::new("buid-other")).is_none());
    // Cancelled attempt: a late identity result is dropped.
    let h2 = reg.start_login(env());
    reg.cancel_login(&h2.attempt_id).unwrap();
    assert!(reg
        .publish_identity(&h2.attempt_id, identity("buid-late"))
        .unwrap_err()
        .is(core_account::codes::ACCOUNT_ATTEMPT_CANCELLED));
}

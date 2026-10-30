//! Credential commit protocol through the registry (ACC-03 / F03).

use contracts::json::JsonValue;
use contracts::{AccountContext, Environment};
use core_account::{
    codes, AccountEvent, AccountRegistry, Buid, ChangeKind, CommitStage, MemorySecretStore, Secret,
    SecretStore, UpstreamIdentity,
};

fn env() -> Environment {
    Environment::named("test-env")
}

fn login(reg: &mut AccountRegistry) -> AccountContext {
    let attempt = reg.start_login(env());
    reg.publish_identity(
        &attempt.attempt_id,
        UpstreamIdentity {
            buid: Buid::new("buid-a"),
            uid: "uid-a".into(),
            agent_id: None,
            environment: env(),
        },
    )
    .expect("publish")
    .ctx
}

#[test]
fn commit_ordering_journal_then_secret_then_index_then_cleanup() {
    let mut reg = AccountRegistry::new(1);
    let mut store = MemorySecretStore::new();
    let ctx = login(&mut reg);
    reg.drain_events();

    let op = reg.begin_credential_commit(&ctx).expect("prepare");
    assert_eq!(op.revision, 1);
    assert_eq!(
        reg.ledger()
            .journal()
            .get(&op.operation_id)
            .map(|e| e.stage),
        Some(CommitStage::Prepared)
    );
    assert!(
        store.staged_keys().is_empty(),
        "journal is written before any secret"
    );
    assert_eq!(reg.credential_revision(&ctx.account_id), 0);

    reg.stage_credential(
        &op.operation_id,
        &mut store,
        &Secret::new(b"PLACEHOLDER-1".to_vec()),
    )
    .expect("stage");
    assert_eq!(store.staged_keys().len(), 1);
    assert_eq!(
        reg.credential_revision(&ctx.account_id),
        0,
        "index unchanged before commit"
    );
    assert!(
        reg.drain_events().is_empty(),
        "nothing published before commit"
    );

    let r1 = reg
        .commit_credential(&op.operation_id, &mut store)
        .expect("commit");
    assert_eq!(reg.credential_revision(&ctx.account_id), 1);
    assert!(store.contains(&r1));
    let events = reg.drain_events();
    assert!(matches!(
        events[0].payload,
        AccountEvent::Changed {
            change: ChangeKind::CredentialCommitted,
            ..
        }
    ));

    // Second revision: old one survives until the index switched.
    let op2 = reg.begin_credential_commit(&ctx).expect("prepare");
    reg.stage_credential(
        &op2.operation_id,
        &mut store,
        &Secret::new(b"PLACEHOLDER-2".to_vec()),
    )
    .expect("stage");
    assert!(store.contains(&r1));
    let r2 = reg
        .commit_credential(&op2.operation_id, &mut store)
        .expect("commit");
    assert!(
        !store.contains(&r1),
        "old revision discarded only after commit"
    );
    assert!(store.contains(&r2));
    assert!(reg.ledger().journal().is_empty());
}

#[test]
fn crash_between_stage_and_index_commit_resolves_to_previous_revision() {
    let mut reg = AccountRegistry::new(1);
    let mut store = MemorySecretStore::new();
    let ctx = login(&mut reg);

    // Revision 1 fully committed.
    let op = reg.begin_credential_commit(&ctx).expect("prepare");
    reg.stage_credential(
        &op.operation_id,
        &mut store,
        &Secret::new(b"PLACEHOLDER-1".to_vec()),
    )
    .expect("stage");
    let r1 = reg
        .commit_credential(&op.operation_id, &mut store)
        .expect("commit");

    // Revision 2: journal + staged secret, then "crash" before the index.
    let op2 = reg.begin_credential_commit(&ctx).expect("prepare");
    reg.stage_credential(
        &op2.operation_id,
        &mut store,
        &Secret::new(b"PLACEHOLDER-2".to_vec()),
    )
    .expect("stage");
    let persisted = reg.to_json().to_json();
    assert!(persisted.contains("secret_staged"), "journal row persisted");
    assert!(!persisted.contains("PLACEHOLDER"));
    drop(reg);

    // Restart: the store still has the staged secret and r1.
    assert_eq!(store.staged_keys().len(), 1);
    let doc = JsonValue::parse(&persisted).expect("parse");
    let mut restarted = AccountRegistry::restore(&doc, 50).expect("restore");
    let report = restarted.recover_credentials(&mut store);
    assert_eq!(report.rolled_back, vec![op2.operation_id.clone()]);
    assert!(report.completed.is_empty());
    assert!(report.missing_secret.is_empty());
    assert_eq!(restarted.credential_revision(&ctx.account_id), 1);
    assert!(
        store.contains(&r1),
        "previous revision is the effective one"
    );
    assert!(
        store.staged_keys().is_empty(),
        "orphan staged secret discarded"
    );
    assert!(restarted.ledger().journal().is_empty());

    // The next revision number is never reused for a different secret.
    let resumed = restarted
        .resume_quick_login(&ctx.account_id)
        .expect("resume");
    let op3 = restarted
        .begin_credential_commit(&resumed)
        .expect("prepare");
    assert_eq!(op3.revision, 3);
}

#[test]
fn crash_after_index_commit_only_finishes_cleanup() {
    let mut reg = AccountRegistry::new(1);
    let mut store = MemorySecretStore::new();
    let ctx = login(&mut reg);
    let op = reg.begin_credential_commit(&ctx).expect("prepare");
    reg.stage_credential(
        &op.operation_id,
        &mut store,
        &Secret::new(b"PLACEHOLDER-1".to_vec()),
    )
    .expect("stage");
    let r1 = reg
        .commit_credential(&op.operation_id, &mut store)
        .expect("commit");

    // Simulate "index committed but old revision deletion did not run":
    // hand-craft the journal row in the persisted document.
    let op2 = reg.begin_credential_commit(&ctx).expect("prepare");
    reg.stage_credential(
        &op2.operation_id,
        &mut store,
        &Secret::new(b"PLACEHOLDER-2".to_vec()),
    )
    .expect("stage");
    let mut doc = reg.to_json();
    let staged = reg
        .ledger()
        .journal()
        .get(&op2.operation_id)
        .and_then(|e| e.staged.clone())
        .expect("staged");
    store.commit(&staged).expect("store commit");
    // Patch: stage → index_committed and index → r2 (as one SQLite txn would).
    let ledger = doc.get("ledger").cloned().expect("ledger");
    let mut ledger_obj = ledger.clone();
    let mut index = JsonValue::object();
    let mut r2 = JsonValue::object();
    r2.insert("key", JsonValue::string(&staged.target.key));
    r2.insert("revision", JsonValue::number_from_i64(2));
    index.insert(ctx.account_id.as_str(), r2);
    ledger_obj.insert("index", index);
    let journal: Vec<JsonValue> = ledger
        .get("journal")
        .and_then(JsonValue::as_array)
        .cloned()
        .expect("journal")
        .into_iter()
        .map(|mut row| {
            row.insert("stage", JsonValue::string("index_committed"));
            row
        })
        .collect();
    ledger_obj.insert("journal", JsonValue::Array(journal));
    doc.insert("ledger", ledger_obj);

    let mut restarted = AccountRegistry::restore(&doc, 50).expect("restore");
    let report = restarted.recover_credentials(&mut store);
    assert_eq!(report.completed, vec![op2.operation_id]);
    assert!(report.rolled_back.is_empty());
    assert_eq!(restarted.credential_revision(&ctx.account_id), 2);
    assert!(!store.contains(&r1), "old revision cleaned up on restart");
    assert!(store.contains(&staged.target));
}

#[test]
fn stale_credential_revision_update_is_rejected() {
    let mut reg = AccountRegistry::new(1);
    let mut store = MemorySecretStore::new();
    let ctx = login(&mut reg);

    let r1 = reg
        .apply_credential_update(&ctx, 0, &mut store, &Secret::new(b"PLACEHOLDER-1".to_vec()))
        .expect("first");
    assert_eq!(r1.revision, 1);
    let r2 = reg
        .apply_credential_update(&ctx, 1, &mut store, &Secret::new(b"PLACEHOLDER-2".to_vec()))
        .expect("second");
    assert_eq!(r2.revision, 2);

    // A late Set-Cookie captured while revision 1 was current.
    let e = reg
        .apply_credential_update(
            &ctx,
            1,
            &mut store,
            &Secret::new(b"PLACEHOLDER-OLD".to_vec()),
        )
        .expect_err("stale");
    assert!(e.is(codes::ACCOUNT_STALE_CREDENTIAL_REVISION));
    assert_eq!(reg.credential_revision(&ctx.account_id), 2);
    assert_eq!(
        store.read_committed(&r2).map(Secret::expose),
        Some(&b"PLACEHOLDER-2"[..])
    );
    assert!(
        reg.ledger().journal().is_empty(),
        "rejected update leaves no journal row"
    );

    // And a stale *generation* is rejected before the revision is even looked at.
    reg.logout(&ctx.account_id, core_account::LogoutMode::ExitOnline)
        .expect("exit");
    let e = reg
        .apply_credential_update(&ctx, 2, &mut store, &Secret::new(b"PLACEHOLDER-3".to_vec()))
        .expect_err("stale generation");
    assert!(e.is(codes::ACCOUNT_STALE_GENERATION));
}

#[test]
fn stage_failure_aborts_without_touching_committed_revision() {
    let mut reg = AccountRegistry::new(1);
    let mut store = MemorySecretStore::new();
    let ctx = login(&mut reg);
    let r1 = reg
        .apply_credential_update(&ctx, 0, &mut store, &Secret::new(b"PLACEHOLDER-1".to_vec()))
        .expect("first");
    store.fail_next_stage();
    let e = reg
        .apply_credential_update(&ctx, 1, &mut store, &Secret::new(b"PLACEHOLDER-2".to_vec()))
        .expect_err("store failure");
    assert!(e.is(codes::ACCOUNT_CREDENTIAL_STORE));
    assert_eq!(reg.credential_revision(&ctx.account_id), 1);
    assert!(store.contains(&r1));
    assert!(reg.ledger().journal().is_empty());
}

#[test]
fn logout_lists_pending_staged_secret_for_discard() {
    let mut reg = AccountRegistry::new(1);
    let mut store = MemorySecretStore::new();
    let ctx = login(&mut reg);
    let op = reg.begin_credential_commit(&ctx).expect("prepare");
    let staged = reg
        .stage_credential(
            &op.operation_id,
            &mut store,
            &Secret::new(b"PLACEHOLDER-1".to_vec()),
        )
        .expect("stage");
    let revoke = reg
        .logout(&ctx.account_id, core_account::LogoutMode::Logout)
        .expect("logout");
    assert_eq!(revoke.staged_to_discard, vec![staged.clone()]);
    assert!(reg.ledger().journal().is_empty());
    // Host executes the revoke list after the generation advanced.
    store.discard(&staged).expect("discard");
    assert!(store.staged_keys().is_empty());
    assert!(reg.commit_credential(&op.operation_id, &mut store).is_err());
}


#[test]
fn unavailable_probe_preserves_committed_revision_across_restart() {
    use core_account::{CredentialRef, StagedRef};
    use contracts::AppError;
    struct Unavailable;
    impl SecretStore for Unavailable {
        fn stage(&mut self, _: &CredentialRef, _: &Secret) -> Result<StagedRef, AppError> { panic!("no stage during probe") }
        fn commit(&mut self, _: &StagedRef) -> Result<(), AppError> { panic!("no commit during probe") }
        fn discard(&mut self, _: &StagedRef) -> Result<(), AppError> { panic!("no discard during probe") }
        fn delete(&mut self, _: &CredentialRef) -> Result<(), AppError> { panic!("no delete during probe") }
        fn contains(&self, _: &CredentialRef) -> bool { false }
        fn probe(&self, _: &CredentialRef) -> Result<bool, AppError> { Err(AppError::new(codes::ACCOUNT_CREDENTIAL_STORE, "synthetic temporarily unavailable")) }
    }
    let mut reg = AccountRegistry::new(1);
    let mut store = MemorySecretStore::new();
    let ctx = login(&mut reg);
    let committed = reg.apply_credential_update(&ctx, 0, &mut store, &Secret::new(b"SYNTHETIC MARKER".to_vec())).expect("commit");
    let mut restarted = AccountRegistry::restore(&reg.to_json(), 50).expect("restore");
    let report = restarted.recover_credentials(&mut Unavailable);
    assert!(report.missing_secret.is_empty(), "access error is not missing credential evidence");
    assert_eq!(report.unavailable_secret, vec![ctx.account_id.clone()]);
    assert_eq!(restarted.ledger().committed(&ctx.account_id), Some(&committed));
    assert_eq!(restarted.credential_revision(&ctx.account_id), committed.revision);
    let retry = restarted.recover_credentials(&mut store);
    assert!(retry.missing_secret.is_empty());
    assert!(retry.unavailable_secret.is_empty());
    assert_eq!(restarted.credential_revision(&ctx.account_id), committed.revision);
}

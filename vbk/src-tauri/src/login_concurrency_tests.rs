use super::*;
use std::sync::{mpsc, Arc};

fn state() -> LoginState {
    LoginState {
        inner: Mutex::new(Inner::default()),
        persist_lock: Mutex::new(()),
        start_lock: Mutex::new(()),
        lifecycle_lock: Mutex::new(()),
        restoring: AtomicBool::new(true),
        active_visit_epoch: AtomicU64::new(0),
        data_dir: std::env::temp_dir().join(format!("vbk-login-test-{}", uuid::Uuid::new_v4())),
    }
}

fn attempt(profile: &str) -> AttemptRec {
    AttemptRec {
        profile_id: profile.into(),
        login_window: None,
        candidate: false,
        importing: false,
        browser_imported: false,
    }
}

#[test]
fn login_stays_gated_until_restore_and_cleanup_complete() {
    let state = state();
    let completion = RestoreCompletion(&state.restoring);
    // This includes time blocked on the credential store, before any accounts
    // have been restored. No new attempt may be issued during that interval.
    let error = state.ensure_ready().unwrap_err();
    assert!(error.retryable);
    assert_eq!(error.code, core_account::codes::ACCOUNT_INVALID_STATE);
    assert!(state.lock().attempts.is_empty());
    drop(completion);
    assert!(state.ensure_ready().is_ok());
}

#[test]
fn unknown_or_stale_cancel_keeps_the_current_attempt() {
    let mut inner = Inner::default();
    inner.attempts.insert("new".into(), attempt("new-profile"));
    assert!(take_attempt(&mut inner, "old").is_none());
    assert!(inner.attempts.contains_key("new"));
}

#[test]
fn cancel_removes_only_owned_profile_and_retains_other_attempts() {
    let mut inner = Inner::default();
    inner.attempts.insert("old".into(), attempt("old-profile"));
    inner.attempts.insert("new".into(), attempt("new-profile"));
    inner
        .bindings
        .insert("acct-old-profile".into(), Binding::Attempt("old".into()));
    inner
        .bindings
        .insert("acct-new-profile".into(), Binding::Attempt("new".into()));
    let removed = take_attempt(&mut inner, "old").unwrap();
    assert_eq!(removed.profile_id, "old-profile");
    // No window was assigned to the old attempt: cancellation must not
    // substitute the window of another attempt just because its label matches.
    assert!(removed.login_window.is_none());
    assert!(!inner.bindings.contains_key("acct-old-profile"));
    assert!(inner.bindings.contains_key("acct-new-profile"));
    assert!(inner.attempts.contains_key("new"));
}

#[test]
fn concurrent_starts_recheck_the_attempt_after_first_creation_finishes() {
    let state = Arc::new(state());
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let first = state.clone();
    let creator = std::thread::spawn(move || {
        first.with_start(|| {
            assert!(first.lock().attempts.is_empty());
            entered_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            first
                .lock()
                .attempts
                .insert("first".into(), attempt("first-profile"));
        })
    });
    entered_rx.recv().unwrap();
    let second = state.clone();
    let (started_tx, started_rx) = mpsc::channel();
    let (checked_tx, checked_rx) = mpsc::channel();
    let other = std::thread::spawn(move || {
        started_tx.send(()).unwrap();
        second.with_start(|| {
            checked_tx.send(()).unwrap();
            // The same recheck as the production start path sees the first
            // attempt rather than creating a second isolated profile/window.
            assert!(second.lock().attempts.contains_key("first"));
        });
    });
    started_rx.recv().unwrap();
    assert!(checked_rx.recv_timeout(Duration::from_millis(50)).is_err());
    release_tx.send(()).unwrap();
    creator.join().unwrap();
    other.join().unwrap();
    checked_rx.recv().unwrap();
    assert_eq!(state.lock().attempts.len(), 1);
}

#[test]
fn concurrent_persist_takes_snapshot_after_previous_write_finishes() {
    let state = Arc::new(state());
    state.lock().active = Some("old".into());
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let first = state.clone();
    let writer = std::thread::spawn(move || {
        first
            .persist_snapshot(|| {
                let active = first.lock().active.clone();
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Ok(PersistDoc {
                    version: PERSIST_VERSION,
                    active_account_id: active,
                    accounts: BTreeMap::new(),
                    registry: json!({}),
                })
            })
            .unwrap();
    });
    entered_rx.recv().unwrap();
    state.lock().active = Some("new".into());
    let second = state.clone();
    let (started_tx, started_rx) = mpsc::channel();
    let (snapshot_tx, snapshot_rx) = mpsc::channel();
    let later = std::thread::spawn(move || {
        started_tx.send(()).unwrap();
        second
            .persist_snapshot(|| {
                snapshot_tx.send(()).unwrap();
                Ok(PersistDoc {
                    version: PERSIST_VERSION,
                    active_account_id: second.lock().active.clone(),
                    accounts: BTreeMap::new(),
                    registry: json!({}),
                })
            })
            .unwrap();
    });
    started_rx.recv().unwrap();
    assert!(
        snapshot_rx.recv_timeout(Duration::from_millis(50)).is_err(),
        "snapshot must wait for the preceding write, not only serialize rename"
    );
    release_tx.send(()).unwrap();
    writer.join().unwrap();
    later.join().unwrap();
    snapshot_rx.recv().unwrap();
    let (load, doc) = load_doc(&state.data_dir.join(ACCOUNTS_FILE));
    assert_eq!(load, IndexLoad::Restored);
    assert_eq!(doc.unwrap().active_account_id.as_deref(), Some("new"));
    assert!(!state.data_dir.join("accounts.json.tmp").exists());
    std::fs::remove_dir_all(&state.data_dir).unwrap();
}

fn upstream() -> UpstreamIdentity {
    UpstreamIdentity {
        buid: Buid::new("synthetic-merchant"),
        uid: "synthetic-agent".into(),
        agent_id: None,
        environment: Environment::production(),
    }
}

#[test]
fn publish_winner_cannot_be_cancelled_between_core_and_metadata_commit() {
    let state = Arc::new(state());
    let mut registry = AccountRegistry::new(1);
    let handle = registry.start_login(Environment::production());
    let attempt_id = handle.attempt_id.as_str().to_string();
    let profile_id = handle.profile_id.as_str().to_string();
    state
        .lock()
        .attempts
        .insert(attempt_id.clone(), attempt(&profile_id));
    let registry = Arc::new(Mutex::new(registry));
    let (published_tx, published_rx) = mpsc::channel();
    let (finish_tx, finish_rx) = mpsc::channel();
    let publisher_state = state.clone();
    let publisher_registry = registry.clone();
    let published_attempt = attempt_id.clone();
    let publisher = std::thread::spawn(move || {
        let lifecycle = publisher_state.lifecycle();
        let profile = publisher_state.lock().attempts[&published_attempt]
            .profile_id
            .clone();
        let outcome = publisher_registry
            .lock()
            .unwrap()
            .publish_identity(&AttemptId::new(published_attempt.clone()), upstream())
            .unwrap();
        // Reproduce the old vulnerable interval: core publication (including
        // a potentially blocking credential commit) precedes host metadata.
        published_tx.send(()).unwrap();
        finish_rx.recv().unwrap();
        let mut inner = publisher_state.lock();
        inner.attempts.remove(&published_attempt).unwrap();
        inner.meta.insert(
            outcome.ctx.account_id.as_str().into(),
            AccountMeta {
                profile_id: Some(profile),
                ..Default::default()
            },
        );
        drop(inner);
        drop(lifecycle);
    });
    published_rx.recv().unwrap();
    let canceller_state = state.clone();
    let canceller_registry = registry.clone();
    let (started_tx, started_rx) = mpsc::channel();
    let (settled_tx, settled_rx) = mpsc::channel();
    let canceller = std::thread::spawn(move || {
        started_tx.send(()).unwrap();
        let lifecycle = canceller_state.lifecycle();
        let removed = take_attempt(&mut canceller_state.lock(), &attempt_id);
        if removed.is_some() {
            canceller_registry
                .lock()
                .unwrap()
                .cancel_login(&AttemptId::new(attempt_id))
                .unwrap();
        }
        drop(lifecycle);
        // Profile deletion is allowed only if cancellation actually won.
        settled_tx.send(removed.is_some()).unwrap();
    });
    started_rx.recv().unwrap();
    assert!(settled_rx.recv_timeout(Duration::from_millis(50)).is_err());
    finish_tx.send(()).unwrap();
    publisher.join().unwrap();
    canceller.join().unwrap();
    assert!(
        !settled_rx.recv().unwrap(),
        "published profile must not be deleted"
    );
    let ids = registry.lock().unwrap().account_ids();
    assert_eq!(ids.len(), 1);
    assert_eq!(
        state.lock().meta[ids[0].as_str()].profile_id.as_deref(),
        Some(profile_id.as_str())
    );
    assert!(state.lock().attempts.is_empty());
}

#[test]
fn cancel_winner_prevents_late_publish_and_orphan_metadata() {
    let state = Arc::new(state());
    let mut registry = AccountRegistry::new(1);
    let handle = registry.start_login(Environment::production());
    let attempt_id = handle.attempt_id.as_str().to_string();
    state
        .lock()
        .attempts
        .insert(attempt_id.clone(), attempt(handle.profile_id.as_str()));
    let registry = Arc::new(Mutex::new(registry));
    let lifecycle = state.lifecycle();
    let removed = take_attempt(&mut state.lock(), &attempt_id).unwrap();
    registry
        .lock()
        .unwrap()
        .cancel_login(&handle.attempt_id)
        .unwrap();
    let late_state = state.clone();
    let late_registry = registry.clone();
    let (started_tx, started_rx) = mpsc::channel();
    let late = std::thread::spawn(move || {
        started_tx.send(()).unwrap();
        let _lifecycle = late_state.lifecycle();
        // A binding captured before cancellation must recheck the attempt
        // under the lifecycle lock before publishing or committing a marker.
        if !late_state.lock().attempts.contains_key(&attempt_id) {
            return false;
        }
        late_registry
            .lock()
            .unwrap()
            .publish_identity(&AttemptId::new(attempt_id), upstream())
            .unwrap();
        true
    });
    started_rx.recv().unwrap();
    drop(lifecycle);
    assert!(!late.join().unwrap());
    assert_eq!(removed.profile_id, handle.profile_id.as_str());
    assert!(registry.lock().unwrap().account_ids().is_empty());
    assert!(state.lock().meta.is_empty());
}

#[test]
fn active_visit_epoch_invalidates_actions_before_any_adapter_read_and_after_account_aba() {
    let state = state();
    {
        let mut inner = state.lock();
        state.set_active_for_visit(&mut inner, "account-a".into());
    }
    let captured = state.active_visit_epoch.load(Ordering::Acquire);
    {
        let mut inner = state.lock();
        state.set_active_for_visit(&mut inner, "account-a".into());
    }
    assert_eq!(
        state.active_visit_epoch.load(Ordering::Acquire),
        captured,
        "selecting the same account keeps the current visit"
    );
    {
        let mut inner = state.lock();
        state.set_active_for_visit(&mut inner, "account-b".into());
    }
    assert_eq!(state.lock().active.as_deref(), Some("account-b"));
    assert_ne!(
        state.active_visit_epoch.load(Ordering::Acquire),
        captured,
        "switch invalidates old actions immediately, without adapter focus updates"
    );
    {
        let mut inner = state.lock();
        state.set_active_for_visit(&mut inner, "account-a".into());
    }
    assert_eq!(state.lock().active.as_deref(), Some("account-a"));
    assert_eq!(
        state.active_visit_epoch.load(Ordering::Acquire),
        captured + 2,
        "returning to A creates a new visit"
    );
    // Bind this regression to the production command's authorized switch path.
    let command = include_str!("login.rs")
        .split("pub async fn account_switch(")
        .nth(1)
        .unwrap()
        .split("#[tauri::command]")
        .next()
        .unwrap();
    assert!(
        command.find("check_account(&app, &account)?").unwrap()
            < command
                .find("ls.set_active_for_visit(&mut inner, id.clone())")
                .unwrap()
    );
}

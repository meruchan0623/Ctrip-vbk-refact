//! Q14 — label / secret leakage: nothing in `AlarmSnapshot`,
//! `AccountSummary`, `AccountEvent`, store documents or the `Debug` output
//! of credential-bearing types contains a raw secret or unmasked message
//! text (README 不变量 6, 00-architecture §4, F11).
#![allow(clippy::unwrap_used)]

mod common;

use common::*;
use contracts::json::JsonValue;
use contracts::{Environment, SendDisposition};
use core_account::{
    AccountRegistry, Buid, LoginAttemptHandle, MemorySecretStore, Secret, UpstreamIdentity,
};
use core_assistant::{
    login, translate_request, LoginForm, MultipartPart, SecretString, TokenData, TsimRequest,
    TsimSession,
};
use core_notify::NotifyCore;
use core_store::{
    DraftRepo, FileStore, Namespace, ReminderStateRepo, RoundRecord, SendIntentRecord,
    SendIntentRepo, Store, SyncWatermarkRepo,
};

const SECRETS: [&str; 6] = [
    "PLACEHOLDER-TICKET",
    "PLACEHOLDER-PASSWORD",
    "PLACEHOLDER-TOKEN",
    "bticket=PLACEHOLDER",
    "Cookie: vbkticket=PLACEHOLDER",
    "PLACEHOLDER-SECRET-2",
];
const CUSTOMER_TEXT: &str = "PLACEHOLDER-CUSTOMER-NICK-张三丰";

fn assert_clean(what: &str, text: &str) {
    for s in SECRETS {
        assert!(!text.contains(s), "{what} leaks {s}: {text}");
    }
    assert!(
        !text.contains(CUSTOMER_TEXT),
        "{what} leaks the raw label: {text}"
    );
    assert!(
        !core_store::looks_secret_like(text),
        "{what} looks secret-like: {text}"
    );
}

#[test]
fn credential_type_debug_output_is_masked() {
    let secret = Secret::new(SECRETS[0].as_bytes().to_vec());
    assert_clean("Secret", &format!("{secret:?}"));
    let mut store = MemorySecretStore::new();
    let mut reg = AccountRegistry::new(10);
    let h = reg.start_login(Environment::named("test"));
    let ctx = reg
        .publish_identity(
            &h.attempt_id,
            UpstreamIdentity {
                buid: Buid::new("buid-PLACEHOLDER"),
                uid: "uid-x".into(),
                agent_id: None,
                environment: Environment::named("test"),
            },
        )
        .unwrap()
        .ctx;
    let op = reg.begin_credential_commit(&ctx).unwrap();
    reg.stage_credential(&op.operation_id, &mut store, &secret)
        .unwrap();
    // Staged + committed secrets live only in the store; every surface
    // around them is masked.
    assert_clean("MemorySecretStore (staged)", &format!("{store:?}"));
    reg.commit_credential(&op.operation_id, &mut store).unwrap();
    assert_clean("MemorySecretStore (committed)", &format!("{store:?}"));
    assert_clean("AccountRegistry", &format!("{reg:?}"));
    assert_clean("ledger json", &reg.ledger().to_json().to_json());
    assert_clean("registry json", &reg.to_json().to_json());
    let snap = reg.account_snapshot();
    let text = format!("{snap:?}");
    assert_clean("AccountListSnapshot", &text);
    assert!(
        !text.contains("buid-PLACEHOLDER"),
        "no buid in the list snapshot"
    );
    assert!(!text.contains("uid-x"), "no uid in the list snapshot");
    for e in reg.drain_events() {
        let t = format!("{e:?}");
        assert_clean("AccountEvent", &t);
        assert!(!t.contains("buid-"));
    }
    let revoke = reg
        .logout(&ctx.account_id, core_account::LogoutMode::Logout)
        .unwrap();
    assert_clean("RevokeList", &format!("{revoke:?}"));
    let handle: LoginAttemptHandle = reg.start_login(Environment::named("test"));
    assert_clean("LoginAttemptHandle", &format!("{handle:?}"));
    // Store keys of the credential ledger never look like a cookie line.
    for k in store.committed_keys() {
        assert!(!core_store::looks_secret_like(&k), "{k}");
    }
}

#[test]
fn assistant_request_and_session_debug_output_redacts_tokens_and_passwords() {
    let form = LoginForm {
        username: "alice".into(),
        password: SecretString::new(SECRETS[1]),
    };
    assert_clean("LoginForm", &format!("{form:?}"));
    let req = login(&form, "Boundary123").unwrap();
    assert_clean("login TsimRequest", &format!("{req:?}"));
    // The encoded body does carry it (that is its job) — but only there.
    assert!(String::from_utf8_lossy(&req.body.encode()).contains(SECRETS[1]));
    let token = TokenData {
        access_token: SecretString::new(SECRETS[2]),
        token_type: "bearer".into(),
        session_ref: "s".into(),
        expires_at_ms: None,
    };
    assert_clean("TokenData", &format!("{token:?}"));
    let session = TsimSession::from_token(token, 0, 1);
    assert_clean("TsimSession", &format!("{session:?}"));
    let (req, params) = translate_request(&session, "你好", "en", "d-1", "v1").unwrap();
    assert_clean("translate TsimRequest", &format!("{req:?}"));
    assert_clean("TranslateParams", &format!("{params:?}"));
    let get: TsimRequest = core_assistant::profile(SECRETS[2]);
    assert_clean("profile TsimRequest", &format!("{get:?}"));
    let part = MultipartPart::secret("password", &SecretString::new(SECRETS[1]));
    assert_clean("MultipartPart", &format!("{part:?}"));
    assert_clean(
        "SecretString",
        &format!("{:?}", SecretString::new(SECRETS[2])),
    );
    // Error values built from responses carry codes, not bodies.
    let e = core_assistant::parse_envelope(
        200,
        &format!(r#"{{"success":false,"message":"{}"}}"#, SECRETS[0]),
    )
    .unwrap_err();
    assert!(!e.message.contains(SECRETS[0]));
}

#[test]
fn alarm_snapshot_and_round_events_carry_only_masked_labels() {
    let mut h = ImHarness::new();
    let mut n = NotifyCore::new();
    // The host supplies an already masked label; the raw nick never
    // enters core-im. Here we feed the masked form and check nothing
    // reconstructs it.
    let masked = core_im::mask_label(CUSTOMER_TEXT);
    assert_ne!(masked, CUSTOMER_TEXT);
    assert_eq!(masked.chars().count(), 7);
    h.core.set_conversation_label(GID, masked.clone());
    h.message(customer("c1", T0_SERVER + 10_000));
    let ev = h.events();
    for e in &ev {
        assert_clean("RoundEvent", &format!("{e:?}"));
    }
    feed(&mut n, ev, &clock(10_000));
    drive(&mut n, &clock(10_000), 0, 31);
    let snap = n.snapshot(&clock(41_000));
    assert_clean("AlarmSnapshot", &format!("{snap:?}"));
    assert_eq!(snap.entries[0].label, masked);
    // Locked screen: even the masked label is replaced.
    n.set_system_state(
        core_notify::SystemState {
            locked: true,
            ..Default::default()
        },
        &clock(42_000),
    );
    let snap = n.snapshot(&clock(42_000));
    assert_eq!(snap.entries.len(), 1);
    assert_eq!(snap.entries[0].label, core_notify::LOCKED_LABEL);
    assert_clean("locked AlarmSnapshot", &format!("{snap:?}"));
    // Without a host label the label is the masked gid, never the raw gid
    // in full.
    let mut h2 = ImHarness::new();
    h2.message(customer("c9", 1));
    let ev = h2.events();
    let contracts::RoundEvent::Started { label, .. } = &ev[0] else {
        panic!("started")
    };
    assert_eq!(label, &core_im::mask_label(GID));
    assert_ne!(label, GID);
    // Persisted im state and the core's Debug output hold no message text
    // and no label at all.
    let text = format!("{:?}", h.core.persisted_state());
    assert_clean("PersistedImState", &text);
    assert!(!text.contains(&masked));
    assert_clean("ImCore debug", &format!("{:?}", h.core));
}

#[test]
fn store_documents_hold_no_secret_and_no_customer_text() {
    let dir = std::env::temp_dir().join(format!("vbk-qa-leak-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let store = FileStore::open(&dir).unwrap();
    let ns = Namespace::from_context(&acc(1));
    let mut txn = store.begin(&ns).unwrap();
    ReminderStateRepo::put(
        &mut txn,
        &RoundRecord {
            gid: GID.into(),
            round_id: format!("{GID}:c1"),
            version: 1,
            start_message_id: Some("c1".into()),
            start_time_ms: Some(1),
            start_confirmed: true,
            reminded_version: 1,
            hidden_version: 0,
            snoozed_until_ms: None,
        },
    );
    let mut rec = SendIntentRecord::new("l1", GID, acc(1), 1);
    rec.disposition = SendDisposition::Rejected {
        code: "E".into(),
        reason: "server said no".into(),
    };
    SendIntentRepo::put(&mut txn, &rec).unwrap();
    DraftRepo::save_draft(&store, &mut txn, GID, "my own unsent reply", 0).unwrap();
    SyncWatermarkRepo::set_page_breakpoint(&store, &mut txn, GID, 5).unwrap();
    store.commit(txn).unwrap();
    let doc = std::fs::read_to_string(store.namespace_dir(&ns).join("state.json")).unwrap();
    assert_clean("state.json", &doc);
    let parsed = JsonValue::parse(&doc).unwrap();
    // No collection may hold a field that could carry a message body.
    let cols = parsed.get("collections").unwrap().as_object().unwrap();
    for (name, records) in cols {
        for (key, v) in records.as_object().unwrap() {
            for field in v.as_object().unwrap().keys() {
                let f = field.to_ascii_lowercase();
                assert!(
                    !(f.contains("body")
                        || f.contains("content")
                        || f.contains("nick")
                        || f.contains("cookie")
                        || f.contains("ticket")),
                    "{name}/{key}: suspicious field {field}"
                );
            }
        }
    }
    // Debug guard rejects credential-like keys before they are written.
    let r = std::panic::catch_unwind(|| {
        let store = core_store::MemoryStore::new();
        let mut txn = store.begin(&Namespace::from_context(&acc(1))).unwrap();
        txn.put("rounds", "x; bticket=PLACEHOLDER", JsonValue::Null);
    });
    assert!(r.is_err(), "secret-like key must trip the debug guard");
    let _ = std::fs::remove_dir_all(&dir);
}

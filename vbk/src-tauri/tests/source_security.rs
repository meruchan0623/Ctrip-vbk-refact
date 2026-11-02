use contracts::{AccountId, Environment};
use core_store::{DraftRepo, MemoryStore, Namespace, Store};
use serde_json::Value;
use vbk_host::prefs::LocalPrefs;
use vbk_host::startup_args;
use vbk_host::views::{Role, ViewRegistry};

fn assert_no_credential_keys(value: &Value) {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                assert!(
                    ![
                        "password", "passwd", "pwd", "remember_password", "rememberpassword",
                        "bticket", "vbkticket", "cookie", "cookies",
                    ]
                    .contains(&key.to_ascii_lowercase().as_str()),
                    "credential key in persistent schema: {key}"
                );
                assert_no_credential_keys(value);
            }
        }
        Value::Array(values) => values.iter().for_each(assert_no_credential_keys),
        _ => {}
    }
}

#[test]
fn persistent_preferences_and_draft_schema_have_no_password_fields() {
    assert_no_credential_keys(&serde_json::to_value(LocalPrefs::default()).unwrap());
    let store = MemoryStore::new();
    let ns = Namespace::new(Environment::production(), AccountId::new("security-fixture"));
    let mut txn = store.begin(&ns).unwrap();
    DraftRepo::save_draft(&store, &mut txn, "conversation-fixture", "synthetic draft", 0).unwrap();
    store.commit(txn).unwrap();
    let draft = store.get(&ns, "drafts", "conversation-fixture").unwrap().unwrap();
    let json: Value = serde_json::from_str(&draft.to_json()).unwrap();
    assert_no_credential_keys(&json);
    assert_eq!(json.as_object().unwrap().len(), 3);
}

#[test]
fn remote_webview_cannot_invoke_any_registered_non_adapter_command() {
    let commands = include_str!("../commands.txt");
    let adapter = ["adapter_ready", "adapter_identity", "adapter_push_fact", "adapter_push_display", "adapter_reply"];
    let mut registry = ViewRegistry::default();
    registry.register("acct-security-fixture");
    for command in commands.lines().map(str::trim).filter(|line| !line.is_empty() && !line.starts_with('#')) {
        assert_eq!(Role::Adapter.allows(command), adapter.contains(&command), "remote role: {command}");
        assert_eq!(registry.authorize("acct-security-fixture", command).is_ok(), adapter.contains(&command), "remote registry: {command}");
    }
    for label in ["login-remote-fixture", "webview-security-fixture", "https://vbooking.ctrip.com"] {
        registry.register(label);
        for command in adapter {
            assert!(registry.authorize(label, command).is_err(), "untrusted label: {label}");
        }
    }
}

#[test]
fn launch_argument_allowlist_rejects_node_debug_tls_and_deep_link_options() {
    assert!(startup_args::allows(Vec::<String>::new()));
    assert!(startup_args::allows(["--show".to_owned()]));
    for arg in [
        "--inspect", "--inspect=9229", "--remote-debugging-port=0", "--ignore-certificate-errors",
        "--disable-web-security", "--require=untrusted.js", "--eval=untrusted()",
        "vbookingChat://send?text=synthetic", "https://vbooking.ctrip.com", "--show=1",
    ] {
        assert!(!startup_args::allows([arg.to_owned()]), "unexpected argument accepted: {arg}");
        assert!(!startup_args::allows(["--show".to_owned(), arg.to_owned()]));
    }
}

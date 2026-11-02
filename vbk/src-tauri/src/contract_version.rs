//! App-command IPC gate. Validate every call so a stale script cannot inherit
//! an earlier handshake, and a compatible reload never inherits a poisoned view.
use contracts::validate_contract_version;
use tauri::{
    ipc::{Invoke, InvokeBody},
    Runtime,
};

use crate::dto::AppErrorDto;

fn validate_payload(payload: &InvokeBody) -> Result<(), contracts::AppError> {
    let version = match payload {
        InvokeBody::Json(value) => value
            .get("_contract_version")
            .and_then(serde_json::Value::as_u64),
        InvokeBody::Raw(_) => None,
    };
    validate_contract_version(version)
}

/// Wrap the generated handler; no command gets dispatched before this gate.
/// Plugin commands use Tauri's separate plugin routing and are unaffected.
pub fn with_contract_version<R: Runtime>(
    handler: impl Fn(Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        if let Err(error) = validate_payload(invoke.message.payload()) {
            // Fixed metadata only; never include an argument, URL or token.
            log::warn!("contract.version_mismatch: rejected incompatible IPC invocation");
            invoke.resolver.reject(AppErrorDto::from(error));
            return true;
        }
        handler(invoke)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use contracts::CONTRACT_VERSION_MISMATCH;
    use serde_json::json;

    #[tauri::command]
    fn version_probe(calls: tauri::State<'_, std::sync::atomic::AtomicUsize>) -> &'static str {
        calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        "dispatched"
    }

    #[test]
    fn actual_invoke_middleware_rejects_before_generated_command_dispatch() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tauri::Manager;
        let app = tauri::test::mock_builder()
            .manage(AtomicUsize::new(0))
            .invoke_handler(with_contract_version(tauri::generate_handler![
                version_probe
            ]))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock host");
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock window");
        let invoke = |body| {
            tauri::test::get_ipc_response(
                &window,
                tauri::webview::InvokeRequest {
                    cmd: "version_probe".into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: if cfg!(windows) {
                        "http://tauri.localhost"
                    } else {
                        "tauri://localhost"
                    }
                    .parse()
                    .expect("local origin"),
                    body: InvokeBody::Json(body),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.into(),
                },
            )
        };
        for body in [
            json!({}),
            json!({"_contract_version": "1"}),
            json!({"_contract_version": 2}),
        ] {
            let error = invoke(body).expect_err("incompatible invoke must fail");
            assert_eq!(error["code"], CONTRACT_VERSION_MISMATCH);
            assert_eq!(app.state::<AtomicUsize>().load(Ordering::SeqCst), 0);
        }
        assert_eq!(
            invoke(json!({"_contract_version": 1}))
                .expect("compatible invoke")
                .deserialize::<String>()
                .expect("response"),
            "dispatched"
        );
        assert_eq!(app.state::<AtomicUsize>().load(Ordering::SeqCst), 1);
        assert!(
            invoke(json!({})).is_err(),
            "no compatibility lease from previous call"
        );
        assert_eq!(app.state::<AtomicUsize>().load(Ordering::SeqCst), 1);
        assert!(
            invoke(json!({"_contract_version": 1})).is_ok(),
            "compatible reload recovers"
        );
        assert_eq!(app.state::<AtomicUsize>().load(Ordering::SeqCst), 2);
    }

    #[test]
    fn missing_wrong_type_wrong_version_and_raw_payloads_fail_closed() {
        for value in [
            json!(null),
            json!([]),
            json!({}),
            json!({"_contract_version": null}),
            json!({"_contract_version": "1"}),
            json!({"_contract_version": true}),
            json!({"_contract_version": 1.0}),
            json!({"_contract_version": -1}),
            json!({"_contract_version": 2}),
            json!({"payload": {"_contract_version": 1}}),
        ] {
            let error = validate_payload(&InvokeBody::Json(value)).expect_err("invalid version");
            assert_eq!(error.code, CONTRACT_VERSION_MISMATCH);
            assert!(!error.retryable);
        }
        assert!(validate_payload(&InvokeBody::Raw(vec![1])).is_err());
        assert!(validate_payload(&InvokeBody::Json(json!({"_contract_version": 1}))).is_ok());
        assert!(
            validate_payload(&InvokeBody::Json(json!({}))).is_err(),
            "valid earlier call grants no lease"
        );
        assert!(
            validate_payload(&InvokeBody::Json(json!({"_contract_version": 1}))).is_ok(),
            "bad earlier call does not poison reload"
        );
    }
}

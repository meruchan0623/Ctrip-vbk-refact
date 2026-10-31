use super::*;
use contracts::codes as shared;
use core_assistant::TsimRequest;
use std::future::Future;
use std::sync::{
    atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering},
    Arc, Mutex,
};

const NOW: i64 = 1_793_000_000_000;
const TOKEN: &str = "SYNTHETIC_IMPORTED_BROWSER_TOKEN";
#[derive(Clone, Default)]
struct MemoryVault {
    value: Arc<Mutex<Option<String>>>,
    fail_save: Arc<AtomicBool>,
    fail_clear: Arc<AtomicBool>,
}
impl Vault for MemoryVault {
    fn load(&self) -> Result<Option<String>, AppError> {
        Ok(self.value.lock().unwrap().clone())
    }
    fn save(&self, value: &str) -> Result<(), AppError> {
        if self.fail_save.load(Ordering::SeqCst) {
            return Err(AppError::new(shared::STORE_IO, "synthetic save failure"));
        }
        *self.value.lock().unwrap() = Some(value.into());
        Ok(())
    }
    fn clear(&self) -> Result<(), AppError> {
        if self.fail_clear.load(Ordering::SeqCst) {
            return Err(AppError::new(shared::STORE_IO, "synthetic clear failure"));
        }
        *self.value.lock().unwrap() = None;
        Ok(())
    }
}
#[derive(Clone, Default)]
struct Http {
    paths: Arc<Mutex<Vec<String>>>,
    mode: Arc<AtomicUsize>,
}
fn response(status: u16, body: &str) -> Result<HttpResponse, AppError> {
    Ok(HttpResponse {
        status,
        body: body.into(),
    })
}
fn path(req: &TsimRequest) -> &str {
    req.url
        .strip_prefix("https://csapi.tsim.tech")
        .unwrap()
        .split('?')
        .next()
        .unwrap()
}
impl Executor for Http {
    async fn execute(&self, req: &TsimRequest) -> Result<HttpResponse, AppError> {
        let path = path(req);
        self.paths.lock().unwrap().push(path.into());
        let mode = self.mode.load(Ordering::SeqCst);
        assert!(!format!("{req:?}").contains(TOKEN));
        match path {
            "/agent/profile" => match mode {
                1 => response(401, "{}"),
                3 => response(
                    200,
                    r#"{"success":true,"data":{"id":7,"username":"server-user","is_active":false,"permissions":["complaint_records"]}}"#,
                ),
                4 => response(
                    200,
                    r#"{"success":true,"data":{"id":7,"username":"server-user","is_active":true,"permissions":["translate"]}}"#,
                ),
                6 => Err(AppError::new(shared::NET_TIMEOUT, "synthetic timeout")),
                7 => response(
                    200,
                    r#"{"success":true,"data":{"id":7,"is_active":true,"permissions":["complaint_records"]}}"#,
                ),
                _ => response(
                    200,
                    r#"{"success":true,"data":{"id":7,"username":"server-user","is_active":true,"permissions":["complaint_records"]}}"#,
                ),
            },
            "/agent/auth/session-status" => match mode {
                2 => response(
                    200,
                    r#"{"success":true,"data":{"state":"revoked","session_ref":"server-shared-ref"}}"#,
                ),
                5 => response(503, "{}"),
                _ => response(
                    200,
                    r#"{"success":true,"data":{"state":"active","session_ref":"server-shared-ref"}}"#,
                ),
            },
            "/agent/auth/refresh" => response(
                200,
                r#"{"success":true,"data":{"access_token":"SYNTHETIC_REFRESHED_TOKEN","token_type":"bearer","session_ref":"server-shared-ref","expires_at":"2030-01-01T00:00:00Z"}}"#,
            ),
            "/agent/login" => response(
                200,
                r#"{"success":true,"data":{"access_token":"SYNTHETIC_PASSWORD_LOGIN_TOKEN","token_type":"bearer","session_ref":"server-new-owned-ref"}}"#,
            ),
            "/agent/logout" => response(200, r#"{"success":true,"data":null}"#),
            _ => panic!("unexpected synthetic import endpoint"),
        }
    }
}
fn run<F: Future>(future: F) -> F::Output {
    tauri::async_runtime::block_on(future)
}
fn fixture() -> (
    Arc<Service<Http, MemoryVault>>,
    Http,
    MemoryVault,
    Arc<AtomicI64>,
) {
    let http = Http::default();
    let vault = MemoryVault::default();
    let clock = Arc::new(AtomicI64::new(NOW));
    let now = clock.clone();
    let service = Arc::new(Service::new(
        http.clone(),
        vault.clone(),
        Box::new(move || now.load(Ordering::SeqCst)),
    ));
    (service, http, vault, clock)
}
#[test]
fn imported_browser_session_uses_only_two_authoritative_gets_and_local_logout_never_revokes_it() {
    run(async {
        let (service, http, vault, _) = fixture();
        let status = service.import_session(TOKEN.into()).await.unwrap();
        assert!(status.logged_in);
        assert_eq!(status.user.as_deref(), Some("server-user"));
        let stored = vault.load().unwrap().unwrap();
        service.logout().await.unwrap();
        assert_eq!(
            *http.paths.lock().unwrap(),
            ["/agent/profile", "/agent/auth/session-status"],
            "browser session must never receive remote logout"
        );
        let value: serde_json::Value = serde_json::from_str(&stored).unwrap();
        assert_eq!(value["borrowed_session"], true);
        assert!(vault.load().unwrap().is_none());
        let dto = serde_json::to_string(&status).unwrap();
        assert!(
            !dto.contains(TOKEN)
                && !dto.contains("server-shared-ref")
                && !dto.contains("borrowed_session")
        );
    });
}
#[test]
fn borrowed_ownership_survives_restore_refresh_and_password_replacement_without_logging_out_browser(
) {
    run(async {
        let (service, http, vault, clock) = fixture();
        service.import_session(TOKEN.into()).await.unwrap();
        let now = clock.clone();
        let restored = Service::new(
            http.clone(),
            vault.clone(),
            Box::new(move || now.load(Ordering::SeqCst)),
        );
        restored.restore();
        clock.store(NOW + 31 * 60 * 1000, Ordering::SeqCst);
        restored.maintain().await;
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&vault.load().unwrap().unwrap()).unwrap()
                ["borrowed_session"],
            true
        );
        restored
            .login("normal-user", "SYNTHETIC_PASSWORD".into())
            .await
            .unwrap();
        assert!(
            !http
                .paths
                .lock()
                .unwrap()
                .iter()
                .any(|p| p == "/agent/logout"),
            "replacement must not revoke a shared browser session"
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&vault.load().unwrap().unwrap()).unwrap()
                ["borrowed_session"],
            false
        );
        http.paths.lock().unwrap().clear();
        restored.logout().await.unwrap();
        assert_eq!(
            *http.paths.lock().unwrap(),
            ["/agent/logout"],
            "a later password-created session still owns normal logout"
        );
    });
}
#[test]
fn rejected_or_unverifiable_imports_never_report_login_success_or_persist_a_token() {
    run(async {
        for mode in 1..=7 {
            let (service, http, vault, _) = fixture();
            http.mode.store(mode, Ordering::SeqCst);
            assert!(
                service.import_session(TOKEN.into()).await.is_err(),
                "mode {mode}"
            );
            assert!(!service.status().logged_in && service.status().user.is_none());
            assert!(vault.load().unwrap().is_none());
            assert!(!http
                .paths
                .lock()
                .unwrap()
                .iter()
                .any(|p| p == "/agent/login"
                    || p == "/agent/logout"
                    || p == "/agent/auth/refresh"));
        }
        let (service, http, _, _) = fixture();
        http.mode.store(1, Ordering::SeqCst);
        assert!(service
            .import_session("e30.eyJzdWIiOiJmYWtlIiwiZXhwIjo5OTk5OTk5OTk5fQ.signature".into())
            .await
            .is_err());
        assert!(!service.status().logged_in);
        assert_eq!(*http.paths.lock().unwrap(), ["/agent/profile"]);
    });
}
#[test]
fn import_storage_failure_is_not_login_success_and_never_logs_out_the_browser() {
    run(async {
        let (service, http, vault, _) = fixture();
        vault.fail_save.store(true, Ordering::SeqCst);
        assert!(service
            .import_session(TOKEN.into())
            .await
            .unwrap_err()
            .is(shared::STORE_IO));
        assert!(!service.status().logged_in);
        assert!(vault.load().unwrap().is_none());
        assert!(!http
            .paths
            .lock()
            .unwrap()
            .iter()
            .any(|p| p == "/agent/logout"));
        let (service, http, vault, _) = fixture();
        vault.fail_clear.store(true, Ordering::SeqCst);
        assert!(service
            .import_session(TOKEN.into())
            .await
            .unwrap_err()
            .is(shared::STORE_IO));
        assert!(!service.status().logged_in);
        assert!(http.paths.lock().unwrap().is_empty());
    });
}
#[derive(Clone)]
struct Gate {
    http: Http,
    path: &'static str,
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
}
impl Executor for Gate {
    async fn execute(&self, request: &TsimRequest) -> Result<HttpResponse, AppError> {
        if path(request) == self.path {
            self.entered.notify_one();
            self.release.notified().await;
        }
        self.http.execute(request).await
    }
}
#[test]
fn import_remains_provisional_through_both_http_stages_and_logout_cancels_queued_imports() {
    run(async {
        for paused in ["/agent/profile", "/agent/auth/session-status"] {
            let gate = Gate {
                http: Http::default(),
                path: paused,
                entered: Arc::default(),
                release: Arc::default(),
            };
            let vault = MemoryVault::default();
            let service = Arc::new(Service::new(gate.clone(), vault.clone(), Box::new(|| NOW)));
            let first = service.clone();
            let pending =
                tauri::async_runtime::spawn(
                    async move { first.import_session(TOKEN.into()).await },
                );
            gate.entered.notified().await;
            assert!(!service.status().logged_in && service.status().user.is_none());
            assert!(vault.load().unwrap().is_none());
            let mut queued = Box::pin(service.import_session("SYNTHETIC_SECOND_TOKEN".into()));
            std::future::poll_fn(|cx| {
                assert!(queued.as_mut().poll(cx).is_pending());
                std::task::Poll::Ready(())
            })
            .await;
            service.logout().await.unwrap();
            gate.release.notify_one();
            assert!(pending.await.unwrap().is_err());
            gate.release.notify_one();
            assert!(queued.await.is_err());
            assert!(!service.status().logged_in);
            assert!(vault.load().unwrap().is_none());
            assert!(!gate
                .http
                .paths
                .lock()
                .unwrap()
                .iter()
                .any(|p| p == "/agent/logout"));
        }
    });
}

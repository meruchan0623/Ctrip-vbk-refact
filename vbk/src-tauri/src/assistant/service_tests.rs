//! Offline tests: a scripted executor and an in-memory vault stand in for
//! reqwest and the keychain. No network access.

use std::future::Future;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use contracts::{codes as shared, AccountContext, AccountId, AppError, Environment};
use core_assistant::session::codes;
use core_assistant::{Body, Method, TsimRequest};

use super::*;
use crate::assistant::http::{Executor, HttpResponse};

type Handler = Box<dyn Fn(&TsimRequest) -> Result<HttpResponse, AppError> + Send + Sync>;

#[derive(Clone)]
struct Mock {
    log: Arc<Mutex<Vec<TsimRequest>>>,
    handler: Arc<Mutex<Handler>>,
}

impl Mock {
    fn new(
        h: impl Fn(&TsimRequest) -> Result<HttpResponse, AppError> + Send + Sync + 'static,
    ) -> Self {
        Self {
            log: Arc::default(),
            handler: Arc::new(Mutex::new(Box::new(h))),
        }
    }
    fn set(
        &self,
        h: impl Fn(&TsimRequest) -> Result<HttpResponse, AppError> + Send + Sync + 'static,
    ) {
        *self.handler.lock().expect("h") = Box::new(h);
    }
    fn paths(&self) -> Vec<String> {
        self.log
            .lock()
            .expect("log")
            .iter()
            .map(|r| path_of(r).to_string())
            .collect()
    }
    fn take(&self) -> Vec<TsimRequest> {
        std::mem::take(&mut *self.log.lock().expect("log"))
    }
}

impl Executor for Mock {
    fn execute(
        &self,
        req: &TsimRequest,
    ) -> impl Future<Output = Result<HttpResponse, AppError>> + Send {
        self.log.lock().expect("log").push(req.clone());
        let out = (self.handler.lock().expect("h"))(req);
        async move { out }
    }
}

#[derive(Clone, Default)]
struct MemVault(Arc<Mutex<Option<String>>>);

impl Vault for MemVault {
    fn load(&self) -> Result<Option<String>, AppError> {
        Ok(self.0.lock().expect("v").clone())
    }
    fn save(&self, value: &str) -> Result<(), AppError> {
        *self.0.lock().expect("v") = Some(value.to_string());
        Ok(())
    }
    fn clear(&self) -> Result<(), AppError> {
        *self.0.lock().expect("v") = None;
        Ok(())
    }
}

const T0: i64 = 1_793_000_000_000;

fn path_of(r: &TsimRequest) -> &str {
    let rest = r
        .url
        .strip_prefix("https://csapi.tsim.tech")
        .expect("origin");
    rest.split('?').next().expect("path")
}

fn ok(body: &str) -> Result<HttpResponse, AppError> {
    Ok(HttpResponse {
        status: 200,
        body: body.to_string(),
    })
}

fn status(code: u16) -> Result<HttpResponse, AppError> {
    Ok(HttpResponse {
        status: code,
        body: "{}".into(),
    })
}

fn json_body(r: &TsimRequest) -> contracts::json::JsonValue {
    match &r.body {
        Body::Json(s) => contracts::json::JsonValue::parse(s).expect("json"),
        other => panic!("not json: {other:?}"),
    }
}

const LOGIN_OK: &str =
    r#"{"success":true,"data":{"access_token":"tok-1","token_type":"bearer","session_ref":"s1"}}"#;
const PROFILE_OK: &str =
    r#"{"success":true,"data":{"id":7,"is_active":true,"permissions":["complaint_records"]}}"#;

/// Default TSim behaviour: login, profile, refresh, logout, translate echo.
fn tsim(r: &TsimRequest) -> Result<HttpResponse, AppError> {
    match path_of(r) {
        "/agent/login" => ok(LOGIN_OK),
        "/agent/profile" => ok(PROFILE_OK),
        "/agent/auth/refresh" => ok(
            r#"{"success":true,"data":{"access_token":"tok-2","token_type":"bearer","expires_at":"2026-10-30T12:00:00Z","session_ref":"s2"}}"#,
        ),
        "/agent/logout" => ok(r#"{"success":true,"message":"bye","data":null}"#),
        "/agent/translate" => {
            let b = json_body(r);
            let id = b
                .get("draft_request_id")
                .and_then(|v| v.as_str())
                .expect("id")
                .to_string();
            let ver = b
                .get("composer_content_version")
                .and_then(|v| v.as_str())
                .expect("ver")
                .to_string();
            ok(&format!(
                r#"{{"success":true,"data":{{"translated_text":"Hello","draft_request_id":"{id}","composer_content_version":"{ver}"}}}}"#
            ))
        }
        "/agent/package-query/perform" => ok(r#"{"code":1,"result":{"query_id":"q-1"}}"#),
        "/agent/package-query/dataplan-list" => {
            ok(r#"{"code":1,"result":[{"card_dataplan_id":"c-9","iccid":"89860000000000000001"}]}"#)
        }
        "/agent/package-query/detail" => ok(
            r#"{"code":1,"result":{"iccid":"89860000000000000001","channel_dataplan_name":"7天5GB","package_status":"使用中","supplier_name":"S","total_flow":"5"}}"#,
        ),
        "/agent/package-query/live-detail" => {
            ok(r#"{"code":1,"result":{"remain":"2.5","apn":"a.apn"}}"#)
        }
        p => panic!("unexpected path {p}"),
    }
}

struct Fx {
    svc: Service<Mock, MemVault>,
    http: Mock,
    vault: MemVault,
    clock: Arc<AtomicI64>,
}

fn fx() -> Fx {
    let http = Mock::new(tsim);
    let vault = MemVault::default();
    let clock = Arc::new(AtomicI64::new(T0));
    let c = clock.clone();
    let svc = Service::new(
        http.clone(),
        vault.clone(),
        Box::new(move || c.load(Ordering::SeqCst)),
    );
    Fx {
        svc,
        http,
        vault,
        clock,
    }
}

fn run<F: Future>(f: F) -> F::Output {
    tauri::async_runtime::block_on(f)
}

fn acct(generation: u64) -> AccountContext {
    AccountContext::new(AccountId::new("a1"), Environment::named("prod"), generation)
}

fn accept_all(_: &AccountContext) -> Result<(), AppError> {
    Ok(())
}

fn logged_in() -> Fx {
    let f = fx();
    run(f.svc.login(" alice ", "pw-secret".into())).expect("login");
    f.http.take();
    f
}

#[test]
fn login_sends_multipart_without_bearer_and_stores_token_only() {
    let f = fx();
    let st = run(f.svc.login(" alice ", "pw-secret".into())).expect("login");
    assert_eq!(
        st,
        TsimStatus {
            logged_in: true,
            user: Some("alice".into())
        }
    );
    let reqs = f.http.take();
    assert_eq!(reqs.len(), 2);
    let login = &reqs[0];
    assert_eq!(login.method, Method::Post);
    assert!(login.header("authorization").is_none());
    assert!(login
        .header("content-type")
        .expect("ct")
        .starts_with("multipart/form-data; boundary=vbk-tsim-"));
    assert!(!format!("{login:?}").contains("pw-secret"));
    assert!(!login.follow_redirects);
    assert_eq!(path_of(&reqs[1]), "/agent/profile");
    assert_eq!(reqs[1].header("authorization"), Some("Bearer tok-1"));
    let stored = f.vault.load().expect("load").expect("saved");
    assert!(stored.contains("tok-1"));
    assert!(stored.contains("alice"));
    assert!(
        !stored.contains("pw-secret"),
        "password must never be persisted"
    );
}

#[test]
fn login_rejected_keeps_logged_out() {
    let f = fx();
    f.http.set(|r| match path_of(r) {
        "/agent/login" => status(401),
        p => panic!("unexpected {p}"),
    });
    let e = run(f.svc.login("alice", "bad".into())).expect_err("401");
    assert!(e.is(codes::BAD_CREDENTIALS));
    assert!(!f.svc.status().logged_in);
    assert!(f.vault.load().expect("load").is_none());
    let e = run(f.svc.login("  ", "x".into())).expect_err("empty");
    assert!(e.is(codes::INVALID_INPUT));
}

#[test]
fn inactive_profile_fails_login() {
    let f = fx();
    f.http.set(|r| match path_of(r) {
        "/agent/profile" => {
            ok(r#"{"success":true,"data":{"id":1,"is_active":false,"permissions":[]}}"#)
        }
        _ => tsim(r),
    });
    let e = run(f.svc.login("alice", "pw".into())).expect_err("inactive");
    assert!(e.is(codes::FORBIDDEN));
    assert!(!f.svc.status().logged_in);
    assert!(f.vault.load().expect("load").is_none());
}

#[test]
fn translate_requires_login_and_makes_no_request() {
    let f = fx();
    let e = run(f.svc.translate(&acct(1), 3, "你好", "en", &accept_all)).expect_err("no login");
    assert!(e.is(codes::NOT_LOGGED_IN));
    assert_eq!(e.code, "assistant.tsim_unauthenticated");
    assert!(f.http.paths().is_empty());
}

#[test]
fn translate_sends_six_fields_and_reuses_cache() {
    let f = logged_in();
    let t = run(f.svc.translate(&acct(1), 3, "你好", "en", &accept_all)).expect("translate");
    assert_eq!(t, "Hello");
    let reqs = f.http.take();
    assert_eq!(reqs.len(), 1);
    let b = json_body(&reqs[0]);
    let keys: Vec<&String> = b.as_object().expect("obj").keys().collect();
    assert_eq!(
        keys,
        [
            "composer_content_version",
            "draft_request_id",
            "purpose",
            "source_lang",
            "target_lang",
            "text"
        ]
    );
    assert_eq!(
        b.get("composer_content_version").and_then(|v| v.as_str()),
        Some("3")
    );
    assert_eq!(b.get("purpose").and_then(|v| v.as_str()), Some("outbound"));
    assert_eq!(reqs[0].header("authorization"), Some("Bearer tok-1"));
    // Same account / text / target: served from the cache.
    let t = run(f.svc.translate(&acct(1), 4, "你好", "en", &accept_all)).expect("cached");
    assert_eq!(t, "Hello");
    assert!(f.http.paths().is_empty());
    // Another account generation is a different cache key.
    run(f.svc.translate(&acct(2), 4, "你好", "en", &accept_all)).expect("other gen");
    assert_eq!(f.http.paths(), ["/agent/translate"]);
}

#[test]
fn translate_401_clears_session_and_vault() {
    let f = logged_in();
    f.http.set(|r| match path_of(r) {
        "/agent/translate" => status(401),
        _ => tsim(r),
    });
    let e = run(f.svc.translate(&acct(1), 1, "你好", "en", &accept_all)).expect_err("401");
    assert!(e.is(codes::NOT_LOGGED_IN));
    assert!(!f.svc.status().logged_in);
    assert!(f.vault.load().expect("load").is_none());
}

#[test]
fn translate_403_keeps_session() {
    let f = logged_in();
    f.http.set(|r| match path_of(r) {
        "/agent/translate" => status(403),
        _ => tsim(r),
    });
    let e = run(f.svc.translate(&acct(1), 1, "你好", "en", &accept_all)).expect_err("403");
    assert!(e.is(codes::FORBIDDEN));
    assert!(f.svc.status().logged_in);
}

#[test]
fn translate_timeout_is_not_retried() {
    let f = logged_in();
    f.http.set(|r| match path_of(r) {
        "/agent/translate" => Err(AppError::new(shared::NET_TIMEOUT, "t").retryable()),
        _ => tsim(r),
    });
    let e = run(f.svc.translate(&acct(1), 1, "你好", "en", &accept_all)).expect_err("timeout");
    assert!(e.is(shared::NET_TIMEOUT));
    assert_eq!(f.http.paths(), ["/agent/translate"]);
    // The single-flight marker was released: a retry by the user goes out.
    f.http.set(tsim);
    run(f.svc.translate(&acct(1), 1, "你好", "en", &accept_all)).expect("retry");
}

#[test]
fn translate_echo_mismatch_is_rejected() {
    let f = logged_in();
    f.http.set(|r| match path_of(r) {
        "/agent/translate" => ok(r#"{"success":true,"data":{"translated_text":"x","draft_request_id":"other","composer_content_version":"1"}}"#),
        _ => tsim(r),
    });
    let e = run(f.svc.translate(&acct(1), 1, "你好", "en", &accept_all)).expect_err("mismatch");
    assert!(e.is(codes::TRANSLATION_MISMATCH));
}

#[test]
fn translate_rejects_stale_generation_after_the_request() {
    let f = logged_in();
    let calls = AtomicI64::new(0);
    let validate = |_: &AccountContext| {
        if calls.fetch_add(1, Ordering::SeqCst) == 0 {
            Ok(())
        } else {
            Err(AppError::new(shared::ACCOUNT_STALE_GENERATION, "old"))
        }
    };
    let e = run(f.svc.translate(&acct(1), 1, "你好", "en", &validate)).expect_err("stale");
    assert!(e.is(shared::ACCOUNT_STALE_GENERATION));
}

#[test]
fn restore_refreshes_when_due_and_persists_new_token() {
    let f = logged_in();
    // Fallback cycle (token is not a JWT): due 30 minutes after issue.
    f.clock.store(T0 + 31 * 60 * 1000, Ordering::SeqCst);
    let restored = fx();
    restored
        .vault
        .save(&f.vault.load().expect("l").expect("s"))
        .expect("copy");
    restored.clock.store(T0 + 31 * 60 * 1000, Ordering::SeqCst);
    restored.svc.restore();
    assert_eq!(
        restored.svc.status(),
        TsimStatus {
            logged_in: true,
            user: Some("alice".into())
        }
    );
    run(restored.svc.maintain());
    assert_eq!(
        restored.http.paths(),
        ["/agent/auth/refresh", "/agent/profile"]
    );
    let stored = restored.vault.load().expect("l").expect("s");
    assert!(stored.contains("tok-2") && !stored.contains("tok-1"));
    // Not due any more: no second refresh.
    restored.http.take();
    run(restored.svc.translate(&acct(1), 1, "a", "en", &accept_all)).expect("tr");
    assert_eq!(restored.http.paths(), ["/agent/translate"]);
}

#[test]
fn refresh_401_clears_restored_session() {
    let f = logged_in();
    let stored = f.vault.load().expect("l").expect("s");
    let r = fx();
    r.vault.save(&stored).expect("copy");
    r.clock.store(T0 + 31 * 60 * 1000, Ordering::SeqCst);
    r.http.set(|req| match path_of(req) {
        "/agent/auth/refresh" => status(401),
        _ => tsim(req),
    });
    r.svc.restore();
    run(r.svc.maintain());
    assert!(!r.svc.status().logged_in);
    assert!(r.vault.load().expect("l").is_none());
}

#[test]
fn refresh_503_keeps_unexpired_token_and_backs_off() {
    let f = logged_in();
    f.clock.store(T0 + 31 * 60 * 1000, Ordering::SeqCst);
    f.http.set(|r| match path_of(r) {
        "/agent/auth/refresh" => status(503),
        _ => tsim(r),
    });
    run(f.svc.translate(&acct(1), 1, "a", "en", &accept_all)).expect("old token still used");
    assert_eq!(f.http.paths(), ["/agent/auth/refresh", "/agent/translate"]);
    f.http.take();
    run(f.svc.translate(&acct(1), 2, "b", "en", &accept_all)).expect("backoff");
    assert_eq!(
        f.http.paths(),
        ["/agent/translate"],
        "no refresh during back-off"
    );
    assert!(f.svc.status().logged_in);
}

#[test]
fn malformed_vault_entry_is_dropped() {
    let f = fx();
    f.vault.save("not json").expect("s");
    f.svc.restore();
    assert!(!f.svc.status().logged_in);
    assert!(f.vault.load().expect("l").is_none());
}

#[test]
fn logout_clears_and_calls_server() {
    let f = logged_in();
    let st = run(f.svc.logout());
    assert_eq!(
        st,
        TsimStatus {
            logged_in: false,
            user: None
        }
    );
    assert!(f.vault.load().expect("l").is_none());
    let reqs = f.http.take();
    assert_eq!(reqs.len(), 1);
    assert_eq!(path_of(&reqs[0]), "/agent/logout");
    assert_eq!(reqs[0].header("authorization"), Some("Bearer tok-1"));
    // Server failure does not keep anything locally either.
    let f = logged_in();
    f.http.set(|_| status(500));
    assert!(!run(f.svc.logout()).logged_in);
}

#[test]
fn package_chain_maps_summary_and_caches_60s() {
    let f = logged_in();
    let iccid = "89860000000000000001";
    let p = run(f.svc.package_quick_view(iccid)).expect("package");
    assert_eq!(p.iccid, iccid);
    assert_eq!(p.plan, "7天5GB");
    assert_eq!(p.status, "使用中");
    assert_eq!(p.supplier, "S");
    assert_eq!(p.apn, "a.apn");
    assert_eq!(p.remain, "2.5");
    assert_eq!(p.total, "5");
    assert!((p.remain_pct - 50.0).abs() < 1e-9);
    assert_eq!(p.fetched_at_ms, T0);
    let reqs = f.http.take();
    let paths: Vec<&str> = reqs.iter().map(path_of).collect();
    assert_eq!(
        paths,
        [
            "/agent/package-query/perform",
            "/agent/package-query/dataplan-list",
            "/agent/package-query/detail",
            "/agent/package-query/live-detail"
        ]
    );
    assert!(reqs[1].url.ends_with("?query_id=q-1"));
    assert!(reqs[2].url.ends_with("?card_dataplan_id=c-9"));
    assert_eq!(
        json_body(&reqs[0])
            .get("order_nums")
            .and_then(|v| v.as_str()),
        Some(iccid)
    );
    f.clock.store(T0 + 59_000, Ordering::SeqCst);
    run(f.svc.package_quick_view(iccid)).expect("cached");
    assert!(f.http.paths().is_empty());
    f.clock.store(T0 + 61_000, Ordering::SeqCst);
    run(f.svc.package_quick_view(iccid)).expect("expired");
    assert_eq!(f.http.paths().len(), 4);
}

#[test]
fn package_supplement_failure_is_empty_block() {
    let f = logged_in();
    f.http.set(|r| match path_of(r) {
        "/agent/package-query/live-detail" => status(500),
        _ => tsim(r),
    });
    let p = run(f.svc.package_quick_view("89860000000000000001")).expect("package");
    assert_eq!(p.apn, "");
    assert_eq!(p.remain, "");
}

#[test]
fn package_requires_complaint_records_and_login() {
    let f = fx();
    let e = run(f.svc.package_quick_view("8986")).expect_err("no login");
    assert!(e.is(codes::NOT_LOGGED_IN));
    f.http.set(|r| match path_of(r) {
        "/agent/profile" => ok(
            r#"{"success":true,"data":{"id":1,"is_active":true,"permissions":["package_query"]}}"#,
        ),
        _ => tsim(r),
    });
    run(f.svc.login("alice", "pw".into())).expect("login");
    f.http.take();
    let e = run(f.svc.package_quick_view("8986")).expect_err("gate");
    assert!(e.is(codes::PERMISSION_DENIED));
    assert!(f.http.paths().is_empty());
    let e = run(f.svc.package_quick_view("a\nb")).expect_err("invalid");
    assert!(e.is(codes::INVALID_INPUT));
}

#[test]
fn package_not_found_and_401() {
    let f = logged_in();
    f.http.set(|r| match path_of(r) {
        "/agent/package-query/dataplan-list" => ok(r#"{"code":1,"result":[]}"#),
        _ => tsim(r),
    });
    let e = run(f.svc.package_quick_view("8986")).expect_err("none");
    assert!(e.is(codes::PACKAGE_NOT_FOUND));
    f.http.set(|r| match path_of(r) {
        "/agent/package-query/perform" => status(423),
        _ => tsim(r),
    });
    let e = run(f.svc.package_quick_view("8986")).expect_err("423");
    assert!(e.is(codes::NOT_LOGGED_IN));
    assert!(!f.svc.status().logged_in);
}

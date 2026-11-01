//! Synthetic list/detail/live responses only; no credentials or real HTTP.
use super::*;
use core_assistant::TsimRequest;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
const NOW: i64 = 1_793_000_000_000;
#[derive(Clone, Default)]
struct MemoryVault(Arc<Mutex<Option<String>>>);
impl Vault for MemoryVault {
    fn load(&self) -> Result<Option<String>, AppError> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn save(&self, value: &str) -> Result<(), AppError> {
        *self.0.lock().unwrap() = Some(value.into());
        Ok(())
    }
    fn clear(&self) -> Result<(), AppError> {
        *self.0.lock().unwrap() = None;
        Ok(())
    }
}
#[derive(Clone)]
struct Http {
    calls: Arc<Mutex<Vec<String>>>,
    cards: usize,
    live_mode: Arc<AtomicUsize>,
    failed_detail: Arc<AtomicUsize>,
    gated: Arc<AtomicBool>,
    entered: Arc<tokio::sync::Notify>,
    gates: Arc<Vec<tokio::sync::Semaphore>>,
    gated_live: Arc<AtomicBool>,
    live_entered: Arc<tokio::sync::Notify>,
    live_release: Arc<tokio::sync::Semaphore>,
    active: Arc<AtomicUsize>,
    peak: Arc<AtomicUsize>,
}
impl Http {
    fn new(cards: usize) -> Self {
        Self {
            calls: Arc::default(),
            cards,
            live_mode: Arc::new(AtomicUsize::new(0)),
            failed_detail: Arc::new(AtomicUsize::new(usize::MAX)),
            gated: Arc::new(AtomicBool::new(false)),
            entered: Arc::default(),
            gates: Arc::new((0..cards).map(|_| tokio::sync::Semaphore::new(0)).collect()),
            gated_live: Arc::new(AtomicBool::new(false)),
            live_entered: Arc::default(),
            live_release: Arc::new(tokio::sync::Semaphore::new(0)),
            active: Arc::default(),
            peak: Arc::default(),
        }
    }
    fn calls(&self, name: &str) -> usize {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|url| url.contains(name))
            .count()
    }
}
fn reply(status: u16, value: serde_json::Value) -> Result<HttpResponse, AppError> {
    Ok(HttpResponse {
        status,
        body: value.to_string(),
    })
}
impl Executor for Http {
    async fn execute(&self, request: &TsimRequest) -> Result<HttpResponse, AppError> {
        self.calls.lock().unwrap().push(request.url.clone());
        assert!(!format!("{request:?}").contains("SYNTHETIC_TOKEN"));
        let route = request
            .url
            .strip_prefix("https://csapi.tsim.tech")
            .unwrap()
            .split('?')
            .next()
            .unwrap();
        let index = || {
            request
                .url
                .split("card_dataplan_id=plan-")
                .nth(1)
                .unwrap()
                .parse::<usize>()
                .unwrap()
        };
        match route {
            "/agent/login" => reply(
                200,
                serde_json::json!({"success":true,"data":{"access_token":"SYNTHETIC_TOKEN","token_type":"bearer","session_ref":"synthetic-reference"}}),
            ),
            "/agent/profile" => reply(
                200,
                serde_json::json!({"success":true,"data":{"id":1,"username":"synthetic-user","is_active":true,"permissions":["complaint_records"]}}),
            ),
            "/agent/logout" => reply(200, serde_json::json!({"success":true,"data":null})),
            "/agent/package-query/perform" => reply(
                200,
                serde_json::json!({"code":1,"result":{"query_id":"synthetic-query"}}),
            ),
            "/agent/package-query/dataplan-list" => reply(
                200,
                serde_json::json!({"code":1,"result":(0..self.cards).map(|i| serde_json::json!({"card_dataplan_id":format!("plan-{i}"),"iccid":format!("SYNTHETIC_ICCID_{i}")})).collect::<Vec<_>>()}),
            ),
            "/agent/package-query/detail" => {
                let i = index();
                if self.gated.load(Ordering::SeqCst) {
                    let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
                    self.peak.fetch_max(active, Ordering::SeqCst);
                    self.entered.notify_one();
                    self.gates[i].acquire().await.unwrap().forget();
                    self.active.fetch_sub(1, Ordering::SeqCst);
                }
                if self.failed_detail.load(Ordering::SeqCst) == i {
                    return reply(503, serde_json::json!({"success":false}));
                }
                reply(
                    200,
                    serde_json::json!({"code":1,"result":{"card_dataplan_id":format!("plan-{i}"),"iccid":format!("SYNTHETIC_ICCID_{i}"),"channel_dataplan_name":format!("SYNTHETIC 渠道套餐 {i} 8GB"),"dataplan_name":format!("来源套餐 {i}"),"supplier_name":"SYNTHETIC_CARRIER","apn":"synthetic.apn","status":"success","query_status":"success","package_status":"not_activated"}}),
                )
            }
            "/agent/package-query/live-detail" => {
                if self.gated_live.load(Ordering::SeqCst) {
                    self.live_entered.notify_one();
                    self.live_release.acquire().await.unwrap().forget();
                }
                match self.live_mode.load(Ordering::SeqCst) {
                    1 => reply(
                        200,
                        serde_json::json!({"code":1,"result":{"package_status":"using","volume":2048,"data_usage":0}}),
                    ),
                    2 => reply(503, serde_json::json!({"success":false})),
                    3 => reply(200, serde_json::json!({"code":1,"result":null})),
                    4 => reply(401, serde_json::json!({})),
                    5 => reply(403, serde_json::json!({})),
                    6 => Err(AppError::new(
                        contracts::codes::NET_OFFLINE,
                        "synthetic network failure",
                    )
                    .retryable()),
                    7 => reply(
                        200,
                        serde_json::json!({"code":0,"msg":"vendor live snapshot unavailable"}),
                    ),
                    8 => reply(
                        200,
                        serde_json::json!({"code":1,"result":"unexpected live shape"}),
                    ),
                    9 => reply(
                        200,
                        serde_json::json!({"code":1,"result":{"package_status":"using","volume":2048,"data_usage":512}}),
                    ),
                    10 => std::future::pending().await,
                    11 => reply(423, serde_json::json!({})),
                    12 => reply(404, serde_json::json!({})),
                    13 => reply(429, serde_json::json!({})),
                    _ => reply(
                        200,
                        serde_json::json!({"code":1,"result":{"package_status":"using","data_usage":0,"today_usage":0,"spec_name":"8GB"}}),
                    ),
                }
            }
            "/agent/package-query/cdr-more" => reply(
                200,
                serde_json::json!({"code":1,"result":[]}),
            ),
            _ => panic!("unexpected synthetic endpoint"),
        }
    }
}
fn scope() -> OrderScope {
    OrderScope {
        account: AccountContext::new(
            AccountId::new("synthetic-account"),
            Environment::named("synthetic-env"),
            1,
        ),
        gid: "synthetic-gid".into(),
        order_id: "0000000000000001".into(),
        context_revision: uuid::Uuid::new_v4().to_string(),
    }
}
fn run<F: Future>(future: F) -> F::Output {
    tauri::async_runtime::block_on(future)
}
async fn fixture(
    cards: usize,
) -> (
    Arc<OrderBook<Http, MemoryVault>>,
    Arc<Service<Http, MemoryVault>>,
    Http,
    Arc<AtomicI64>,
    u64,
) {
    let http = Http::new(cards);
    let now = Arc::new(AtomicI64::new(NOW));
    let clock = now.clone();
    let service = Arc::new(Service::new(
        http.clone(),
        MemoryVault::default(),
        Box::new(move || clock.load(Ordering::SeqCst)),
    ));
    let epoch = service
        .login("synthetic-user", "synthetic-password".into())
        .await
        .unwrap()
        .session_epoch;
    http.calls.lock().unwrap().clear();
    (
        Arc::new(OrderBook::new(service.clone())),
        service,
        http,
        now,
        epoch,
    )
}
#[test]
fn automatic_summary_hydrates_sparse_list_with_real_detail_and_live_without_guessing_quota() {
    run(async {
        let (book, _, http, now, epoch) = fixture(2).await;
        let scope = scope();
        let valid = || async { Ok(()) };
        let result = book.summary(scope.clone(), epoch, &valid).await.unwrap();
        assert_eq!(result.total, 2);
        assert_eq!(result.plans.len(), 2);
        for (i, plan) in result.plans.iter().enumerate() {
            assert_eq!(plan.info.iccid, format!("SYNTHETIC_ICCID_{i}"));
            assert_eq!(plan.info.plan, format!("SYNTHETIC 渠道套餐 {i} 8GB"));
            assert_eq!(plan.info.status, "using");
            assert_eq!(plan.info.supplier, "SYNTHETIC_CARRIER");
            assert_eq!(plan.info.apn, "synthetic.apn");
            assert!(plan.info.remain_pct.is_none());
            assert!(plan.info.remain.is_empty() && plan.info.total.is_empty());
        }
        assert_eq!(http.calls("/detail?"), 2);
        assert_eq!(http.calls("/live-detail?"), 2);
        assert_eq!(http.calls("/cdr-more?"), 2);
        let calls = http.calls.lock().unwrap().len();
        book.summary(scope.clone(), epoch, &valid).await.unwrap();
        assert_eq!(http.calls.lock().unwrap().len(), calls);
        now.store(NOW + 61_000, Ordering::SeqCst);
        book.summary(scope, epoch, &valid).await.unwrap();
        assert_eq!(http.calls("/detail?"), 4);
    });
}

#[test]
fn live_absence_is_cacheable_but_transient_or_malformed_live_is_unknown_and_not_reused() {
    run(async {
        for mode in [2, 3, 6, 7, 8, 12, 13] {
            let (book, _, http, _, epoch) = fixture(1).await;
            http.live_mode.store(mode, Ordering::SeqCst);
            let scope = scope();
            let valid = || async { Ok(()) };
            let result = book.summary(scope.clone(), epoch, &valid).await.unwrap();
            assert_eq!(result.plans[0].info.plan, "SYNTHETIC 渠道套餐 0 8GB");
            assert_eq!(result.plans[0].info.status, "not_activated");
            assert!(result.plans[0].info.remain_pct.is_none());
            assert!(
                book.resolve(
                    &scope.account,
                    &scope.gid,
                    &result.query_handle,
                    &result.plans[0].detail_handle
                )
                .is_ok(),
                "degraded summaries still issue usable detail handles"
            );
            let requests = http.calls.lock().unwrap().len();
            book.summary(scope, epoch, &valid).await.unwrap();
            assert_eq!(
                http.calls.lock().unwrap().len(),
                if mode == 3 { requests } else { requests + 5 },
                "mode {mode}"
            );
        }
    });
}
#[test]
fn required_detail_or_live_authorization_failure_never_creates_partial_handles_or_cache() {
    run(async {
        for live_mode in [4, 5, 11] {
            let (book, _, http, _, epoch) = fixture(2).await;
            http.live_mode.store(live_mode, Ordering::SeqCst);
            assert!(book
                .summary(scope(), epoch, &|| async { Ok(()) })
                .await
                .is_err());
            assert!(book.queries.lock().unwrap().is_empty());
        }
        let (book, _, http, _, epoch) = fixture(5).await;
        http.failed_detail.store(0, Ordering::SeqCst);
        assert!(book
            .summary(scope(), epoch, &|| async { Ok(()) })
            .await
            .is_err());
        assert!(book.queries.lock().unwrap().is_empty());
        assert!(
            http.calls("/detail?") <= 4,
            "a failed batch never starts a fifth card"
        );
    });
}
#[test]
fn bounded_parallel_hydration_retains_all_one_hundred_plans_in_list_order() {
    run(async {
        let (book, _, http, _, epoch) = fixture(100).await;
        http.gated.store(true, Ordering::SeqCst);
        let pending_book = book.clone();
        let pending = tauri::async_runtime::spawn(async move {
            pending_book
                .summary(scope(), epoch, &|| async { Ok(()) })
                .await
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while http.active.load(Ordering::SeqCst) < 4 {
                http.entered.notified().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(http.active.load(Ordering::SeqCst), 4);
        assert_eq!(http.calls("/detail?"), 4);
        for gate in http.gates.iter().rev() {
            gate.add_permits(1);
        }
        let result = pending.await.unwrap().unwrap();
        assert_eq!(result.total, 100);
        assert_eq!(result.plans.len(), 100);
        for (i, plan) in result.plans.iter().enumerate() {
            assert_eq!(plan.info.iccid, format!("SYNTHETIC_ICCID_{i}"));
        }
        assert_eq!(http.peak.load(Ordering::SeqCst), 4);
        assert_eq!(http.calls("/detail?"), 100);
        assert_eq!(http.calls("/live-detail?"), 100);
        assert_eq!(http.calls("/cdr-more?"), 100);
        let (book, _, http, _, epoch) = fixture(101).await;
        assert!(book
            .summary(scope(), epoch, &|| async { Ok(()) })
            .await
            .is_err());
        assert_eq!(http.calls("/detail?"), 0);
        assert!(book.queries.lock().unwrap().is_empty());
    });
}
#[test]
fn first_failure_drains_started_guards_without_dropping_or_starting_more_http() {
    run(async {
        let (book, _, http, _, epoch) = fixture(8).await;
        let entered = Arc::new(AtomicUsize::new(0));
        let ready = Arc::new(tokio::sync::Notify::new());
        let failed = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let completed = Arc::new(AtomicUsize::new(0));
        let finished = Arc::new(AtomicBool::new(false));
        let pending_book = book.clone();
        let count = entered.clone();
        let notify = ready.clone();
        let released = release.clone();
        let done = completed.clone();
        let failure_notice = failed.clone();
        let finished_notice = finished.clone();
        let pending = tauri::async_runtime::spawn(async move {
            let valid = || {
                let count = count.clone();
                let ready = notify.clone();
                let released = released.clone();
                let done = done.clone();
                let failed = failure_notice.clone();
                async move {
                    let call = count.fetch_add(1, Ordering::SeqCst);
                    if (6..10).contains(&call) {
                        ready.notify_one();
                        released.acquire().await.unwrap().forget();
                        if call == 6 {
                            failed.notify_one();
                            return Err(invalid("synthetic scope failure"));
                        }
                        done.fetch_add(1, Ordering::SeqCst);
                    }
                    Ok(())
                }
            };
            let result = pending_book.summary(scope(), epoch, &valid).await;
            finished_notice.store(true, Ordering::SeqCst);
            result
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while entered.load(Ordering::SeqCst) < 10 {
                ready.notified().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(completed.load(Ordering::SeqCst), 0);
        release.add_permits(1);
        failed.notified().await;
        tokio::task::yield_now().await;
        assert!(
            !finished.load(Ordering::SeqCst),
            "other already-started guards must be drained before returning the first error"
        );
        assert_eq!(completed.load(Ordering::SeqCst), 0);
        release.add_permits(3);
        assert!(pending.await.unwrap().is_err());
        assert_eq!(completed.load(Ordering::SeqCst), 3);
        assert_eq!(http.calls("/detail?"), 0);
        assert_eq!(http.calls("/live-detail?"), 0);
        assert!(book.queries.lock().unwrap().is_empty());
    });
}
#[test]
fn http_budget_timeout_keeps_scope_guards_alive_and_never_caches_partial_summary() {
    run(async {
        let (book, service, http, _, epoch) = fixture(1).await;
        http.live_mode.store(10, Ordering::SeqCst);
        let (session, _) = service.ensure_fresh().await.unwrap();
        let ids = vec!["plan-0".to_owned()];
        let rows =
            vec![
                JsonValue::parse(r#"{"card_dataplan_id":"plan-0","iccid":"SYNTHETIC_ICCID_0"}"#)
                    .unwrap(),
            ];
        let read = SummaryRead::new(Duration::from_millis(100));
        let checks = AtomicUsize::new(0);
        let valid = || {
            checks.fetch_add(1, Ordering::SeqCst);
            async { Ok(()) }
        };
        assert!(book
            .enrich_plans(&session, epoch, &ids, &rows, &valid, &read)
            .await
            .err()
            .expect("read budget must expire")
            .is(contracts::codes::NET_TIMEOUT));
        assert_eq!(
            checks.load(Ordering::SeqCst),
            4,
            "both detail and timed-out live complete pre/post scope guards"
        );
        assert!(book.queries.lock().unwrap().is_empty());
    });
}

#[test]
fn scope_and_epoch_changes_during_each_detail_or_live_await_reject_every_result() {
    run(async {
        for live_stage in [false, true] {
            for epoch_change in [false, true] {
                let (book, service, http, _, epoch) = fixture(1).await;
                http.gated.store(!live_stage, Ordering::SeqCst);
                http.gated_live.store(live_stage, Ordering::SeqCst);
                let current = Arc::new(AtomicBool::new(true));
                let scope_valid = current.clone();
                let pending_book = book.clone();
                let pending = tauri::async_runtime::spawn(async move {
                    let validate = || {
                        let valid = scope_valid.clone();
                        async move {
                            if valid.load(Ordering::SeqCst) {
                                Ok(())
                            } else {
                                Err(invalid("synthetic replaced conversation"))
                            }
                        }
                    };
                    pending_book.summary(scope(), epoch, &validate).await
                });
                if live_stage {
                    http.live_entered.notified().await;
                } else {
                    while http.active.load(Ordering::SeqCst) == 0 {
                        http.entered.notified().await;
                    }
                }
                if epoch_change {
                    service.logout().await.unwrap();
                } else {
                    current.store(false, Ordering::SeqCst);
                }
                if live_stage {
                    http.live_release.add_permits(1);
                } else {
                    http.gates[0].add_permits(1);
                }
                assert!(pending.await.unwrap().is_err());
                assert!(book.queries.lock().unwrap().is_empty());
                assert_eq!(http.calls("/live-detail?"), usize::from(live_stage));
            }
        }
    });
}

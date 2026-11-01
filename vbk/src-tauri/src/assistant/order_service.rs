//! Bounded, read-only order-query capabilities. Child of service so tokens stay
//! inside the host; renderer receives only projections and opaque handles.
use super::*;
use crate::dto::AccountContextDto;
use core_assistant::{cdr_more_request, order};
use std::{
    collections::VecDeque,
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    task::Poll,
    time::Duration,
};

const QUERY_REUSE_MS: i64 = 60_000;
const HANDLE_TTL_MS: i64 = 5 * 60_000;
const MAX_QUERIES: usize = 16;

const SUMMARY_CONCURRENCY: usize = 4;
const SUMMARY_HTTP_BUDGET: Duration = Duration::from_secs(45);

struct SummaryRead {
    deadline: tokio::time::Instant,
    stopped: AtomicBool,
}
impl SummaryRead {
    fn new(duration: Duration) -> Self {
        Self {
            deadline: tokio::time::Instant::now() + duration,
            stopped: AtomicBool::new(false),
        }
    }
    fn check(&self) -> Result<(), AppError> {
        if self.stopped.load(Ordering::SeqCst) || tokio::time::Instant::now() >= self.deadline {
            Err(Self::timeout())
        } else {
            Ok(())
        }
    }
    fn timeout() -> AppError {
        AppError::new(
            contracts::codes::NET_TIMEOUT,
            "order summary read budget exhausted",
        )
        .retryable()
    }
    fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
    }
}
#[derive(Clone)]
struct SummaryPlan {
    info: OrderPackageInfo,
    reusable: bool,
}
type PendingSummary<'a> = (
    usize,
    Pin<Box<dyn Future<Output = Result<SummaryPlan, AppError>> + Send + 'a>>,
);

#[derive(Clone, PartialEq, Eq)]
pub struct OrderScope {
    pub account: AccountContext,
    pub gid: String,
    pub order_id: String,
    pub context_revision: String,
}
#[derive(Clone, Serialize)]
pub struct OrderPackageInfo {
    pub iccid: String,
    pub plan: String,
    pub status: String,
    pub remain_pct: Option<f64>,
    pub remain: String,
    pub total: String,
    pub supplier: String,
    pub apn: String,
    pub fetched_at_ms: i64,
    pub detail_fields: Vec<PackageField>,
    pub live_fields: Vec<PackageField>,
    pub cdrs: Vec<Vec<PackageField>>,
    pub usage_scope: &'static str,
    pub unlimited: bool,
}
impl OrderPackageInfo {
    fn project(detail: &JsonValue, live: Option<&JsonValue>, now: i64) -> Self {
        let sum = order::order_summary(detail, live);
        Self {
            iccid: sum.iccid,
            plan: sum.plan,
            status: sum.status,
            remain_pct: (!sum.remain.is_empty() && !sum.total.is_empty()).then_some(sum.remain_pct),
            remain: sum.remain,
            total: sum.total,
            supplier: sum.supplier,
            apn: sum.apn,
            fetched_at_ms: now,
            detail_fields: order::detail_fields(detail).into_iter()
                .filter(|field| field.label != "当日用量（MB）" || order::daily_usage_available(detail, live))
                .map(Into::into).collect(),
            live_fields: live.map(order::live_fields).unwrap_or_default().into_iter().map(Into::into).collect(),
            cdrs: order::cdr_fields(detail, None).into_iter().map(|row| row.into_iter().map(Into::into).collect()).collect(),
            usage_scope: order::usage_scope(detail, live),
            unlimited: order::unlimited(detail, live),
        }
    }
}
#[derive(Clone, Serialize)]
pub struct OrderPlan {
    pub detail_handle: String,
    #[serde(flatten)]
    pub info: OrderPackageInfo,
}
#[derive(Clone, Serialize)]
pub struct OrderSummary {
    pub account: AccountContextDto,
    pub gid: String,
    pub order_id: String,
    pub context_revision: String,
    pub session_epoch: u64,
    pub query_handle: String,
    pub plans: Vec<OrderPlan>,
    pub total: usize,
    pub fetched_at_ms: i64,
}
#[derive(Clone, Serialize)]
pub struct PackageField {
    pub label: String,
    pub value: String,
}
impl From<order::Field> for PackageField {
    fn from(value: order::Field) -> Self {
        Self {
            label: value.label,
            value: value.value,
        }
    }
}
#[derive(Clone, Serialize)]
pub struct PackageDetail {
    pub order_id: String,
    pub session_epoch: u64,
    pub plan: OrderPackageInfo,
    pub detail_fields: Vec<PackageField>,
    pub live_fields: Vec<PackageField>,
    pub cdrs: Vec<Vec<PackageField>>,
    pub fetched_at_ms: i64,
}
#[derive(Clone)]
pub struct BoundPlan {
    pub scope: OrderScope,
    pub session_epoch: u64,
    card_id: String,
}
struct Query {
    scope: OrderScope,
    epoch: u64,
    summary: OrderSummary,
    reusable: bool,
    cards: Vec<(String, String)>,
}
pub struct OrderBook<E: Executor, V: Vault> {
    service: Arc<Service<E, V>>,
    queries: Mutex<VecDeque<Arc<Query>>>,
}
impl<E: Executor, V: Vault> OrderBook<E, V> {
    pub fn new(service: Arc<Service<E, V>>) -> Self {
        Self {
            service,
            queries: Mutex::default(),
        }
    }
    async fn guard<F, Fut>(&self, epoch: u64, validate: &F) -> Result<(), AppError>
    where
        F: Fn() -> Fut + Sync,
        Fut: Future<Output = Result<(), AppError>> + Send,
    {
        validate().await?;
        let status = self.service.status();
        if !status.logged_in || status.session_epoch != epoch {
            return Err(not_logged_in("tsim identity changed during order query"));
        }
        self.service.check_epoch(epoch).await
    }
    async fn session<F, Fut>(&self, epoch: u64, validate: &F) -> Result<TsimSession, AppError>
    where
        F: Fn() -> Fut + Sync,
        Fut: Future<Output = Result<(), AppError>> + Send,
    {
        self.guard(epoch, validate).await?;
        let loaded = self.service.lock().profile_loaded;
        let (session, current) = if loaded {
            self.service.ensure_fresh().await?
        } else {
            self.service.load_profile().await?
        };
        self.guard(epoch, validate).await?;
        if current != epoch {
            return Err(not_logged_in("tsim identity changed before order query"));
        }
        PackagePermission::evaluate(&session).check()?;
        Ok(session)
    }
    async fn request<F, Fut>(
        &self,
        epoch: u64,
        req: Result<core_assistant::TsimRequest, AppError>,
        validate: &F,
    ) -> Result<HttpResponse, AppError>
    where
        F: Fn() -> Fut + Sync,
        Fut: Future<Output = Result<(), AppError>> + Send,
    {
        self.guard(epoch, validate).await?;
        let response = self.service.run(req).await;
        self.guard(epoch, validate).await?;
        response.map_err(|error| self.service.auth_error(epoch, error))
    }
    pub async fn summary<F, Fut>(
        &self,
        scope: OrderScope,
        epoch: u64,
        validate: &F,
    ) -> Result<OrderSummary, AppError>
    where
        F: Fn() -> Fut + Sync,
        Fut: Future<Output = Result<(), AppError>> + Send,
    {
        order::validate_order_id(&scope.order_id)?;
        if scope.gid.is_empty() || uuid::Uuid::parse_str(&scope.context_revision).is_err() {
            return Err(invalid("invalid order conversation binding"));
        }
        let session = self.session(epoch, validate).await?;
        let now = self.service.now_ms();
        let cached = {
            let mut queries = self.queries.lock().unwrap_or_else(|e| e.into_inner());
            queries.retain(|q| {
                q.epoch == epoch && now.saturating_sub(q.summary.fetched_at_ms) < HANDLE_TTL_MS
            });
            queries
                .iter()
                .find(|q| {
                    q.reusable
                        && q.scope == scope
                        && now.saturating_sub(q.summary.fetched_at_ms) < QUERY_REUSE_MS
                })
                .map(|q| q.summary.clone())
        };
        if let Some(summary) = cached {
            self.guard(epoch, validate).await?;
            return Ok(summary);
        }
        // Session/profile upkeep keeps its existing per-request boundary. The
        // 45 s read budget begins at perform and includes list + every plan.
        let read = SummaryRead::new(SUMMARY_HTTP_BUDGET);
        let response = self
            .summary_request(
                epoch,
                perform_request(&session, &scope.order_id),
                validate,
                &read,
            )
            .await?;
        let query_id = parse_perform(response.status, &response.body)
            .map_err(|e| self.service.auth_error(epoch, e))?;
        let response = self
            .summary_request(
                epoch,
                dataplan_list_request(&session, &query_id),
                validate,
                &read,
            )
            .await?;
        let rows = order::parse_plan_list(response.status, &response.body)
            .map_err(|e| self.service.auth_error(epoch, e))?;
        let ids = order::plan_ids(&rows)?;
        let hydrated = self
            .enrich_plans(&session, epoch, &ids, &rows, validate, &read)
            .await?;
        let reusable = hydrated.iter().all(|plan| plan.reusable);
        let fetched = self.service.now_ms();
        let mut cards = Vec::new();
        let mut plans = Vec::new();
        for (id, hydrated) in ids.into_iter().zip(hydrated) {
            let handle = uuid::Uuid::new_v4().to_string();
            cards.push((handle.clone(), id));
            plans.push(OrderPlan {
                detail_handle: handle,
                info: hydrated.info,
            });
        }
        let summary = OrderSummary {
            account: (&scope.account).into(),
            gid: scope.gid.clone(),
            order_id: scope.order_id.clone(),
            context_revision: scope.context_revision.clone(),
            session_epoch: epoch,
            query_handle: uuid::Uuid::new_v4().to_string(),
            total: plans.len(),
            plans,
            fetched_at_ms: fetched,
        };
        self.guard(epoch, validate).await?;
        let query = Arc::new(Query {
            scope,
            epoch,
            summary: summary.clone(),
            reusable,
            cards,
        });
        let mut queries = self.queries.lock().unwrap_or_else(|e| e.into_inner());
        while queries.len() >= MAX_QUERIES {
            queries.pop_front();
        }
        queries.push_back(query);
        Ok(summary)
    }
    /// Timeout only the TSim HTTP future, never an adapter scope guard. Guards
    /// finish their existing 15 s timeout so their pending request is removed.
    async fn summary_request<F, Fut>(
        &self,
        epoch: u64,
        req: Result<core_assistant::TsimRequest, AppError>,
        validate: &F,
        read: &SummaryRead,
    ) -> Result<HttpResponse, AppError>
    where
        F: Fn() -> Fut + Sync,
        Fut: Future<Output = Result<(), AppError>> + Send,
    {
        read.check()?;
        self.guard(epoch, validate).await?;
        read.check()?;
        let response = tokio::time::timeout_at(read.deadline, self.service.run(req))
            .await
            .unwrap_or_else(|_| Err(SummaryRead::timeout()));
        self.guard(epoch, validate).await?;
        read.check()?;
        response.map_err(|e| self.service.auth_error(epoch, e))
    }
    async fn summary_plan<F, Fut>(
        &self,
        session: &TsimSession,
        epoch: u64,
        card: &str,
        row: &JsonValue,
        validate: &F,
        read: &SummaryRead,
    ) -> Result<SummaryPlan, AppError>
    where
        F: Fn() -> Fut + Sync,
        Fut: Future<Output = Result<(), AppError>> + Send,
    {
        let response = self
            .summary_request(epoch, detail_request(session, card), validate, read)
            .await?;
        let detail = parse_detail(response.status, &response.body)
            .map_err(|e| self.service.auth_error(epoch, e))?;
        if let Some(actual) = detail.get("card_dataplan_id") {
            if core_assistant::id_from_json(actual).as_deref() != Some(card) {
                return Err(AppError::new(
                    codes::MALFORMED_RESPONSE,
                    "detail belongs to a different package",
                ));
            }
        }
        let live = self
            .summary_request(epoch, live_detail_request(session, card), validate, read)
            .await;
        let (live, reusable) = match live {
            Ok(response) => {
                if matches!(response.status, 401 | 423) {
                    let error = core_assistant::map_http_status(response.status)
                        .expect("auth status")
                        .error;
                    return Err(self.service.auth_error(epoch, error));
                }
                if response.status == 403 {
                    return Err(AppError::new(
                        codes::FORBIDDEN,
                        "live package detail is not permitted",
                    ));
                }
                let value = parse_supplement(response.status, &response.body)
                    .map_err(|e| self.service.auth_error(epoch, e))?;
                match value {
                    Some(value @ JsonValue::Object(_)) => (Some(value), true),
                    _ => {
                        let empty = (200..300).contains(&response.status)
                            && JsonValue::parse(&response.body).ok().is_some_and(|v| {
                                v.get("code").and_then(JsonValue::as_i64) == Some(1)
                                    && matches!(v.get("result"), Some(JsonValue::Null))
                            });
                        (None, empty)
                    }
                }
            }
            Err(error)
                if read.check().is_ok()
                    && [
                        contracts::codes::NET_OFFLINE,
                        contracts::codes::NET_TIMEOUT,
                        contracts::codes::NET_PAYLOAD_TOO_LARGE,
                    ]
                    .contains(&error.code.as_str()) =>
            {
                (None, false)
            }
            Err(error) => return Err(error),
        };
        let mut info = OrderPackageInfo::project(&detail, live.as_ref(), self.service.now_ms());
        // Match the original companion: supplemental CDR rows take precedence
        // over detail.cdr_list, under the same scope and total read budget.
        let cdr = self.summary_request(epoch, cdr_more_request(session, card), validate, read).await;
        let (cdr, cdr_reusable) = match cdr {
            Ok(response) => {
                if response.status == 403 {
                    return Err(AppError::new(codes::FORBIDDEN, "package CDR is not permitted"));
                }
                let value = parse_supplement(response.status, &response.body)
                    .map_err(|e| self.service.auth_error(epoch, e))?;
                let reusable = value.is_some();
                (value, reusable)
            }
            Err(error) if read.check().is_ok() && [contracts::codes::NET_OFFLINE, contracts::codes::NET_TIMEOUT, contracts::codes::NET_PAYLOAD_TOO_LARGE].contains(&error.code.as_str()) => (None, false),
            Err(error) => return Err(error),
        };
        info.cdrs = order::cdr_fields(&detail, cdr.as_ref()).into_iter().map(|row| row.into_iter().map(Into::into).collect()).collect();
        if info.iccid.is_empty() {
            info.iccid = OrderPackageInfo::project(row, None, info.fetched_at_ms).iccid;
        }
        Ok(SummaryPlan { info, reusable: reusable && cdr_reusable })
    }
    async fn enrich_plans<F, Fut>(
        &self,
        session: &TsimSession,
        epoch: u64,
        ids: &[String],
        rows: &[JsonValue],
        validate: &F,
        read: &SummaryRead,
    ) -> Result<Vec<SummaryPlan>, AppError>
    where
        F: Fn() -> Fut + Sync,
        Fut: Future<Output = Result<(), AppError>> + Send,
    {
        let mut pending: Vec<PendingSummary<'_>> = Vec::new();
        let mut result = vec![None; ids.len()];
        let mut next = 0;
        let mut failure = None;
        std::future::poll_fn(|cx| loop {
            if failure.is_none() {
                if let Err(error) = read.check() {
                    read.stop();
                    failure = Some(error);
                }
            }
            if failure.is_none() {
                while pending.len() < SUMMARY_CONCURRENCY && next < ids.len() {
                    let index = next;
                    next += 1;
                    pending.push((
                        index,
                        Box::pin(self.summary_plan(
                            session,
                            epoch,
                            &ids[index],
                            &rows[index],
                            validate,
                            read,
                        )),
                    ));
                }
            }
            let mut progressed = false;
            for index in (0..pending.len()).rev() {
                let ready = match pending[index].1.as_mut().poll(cx) {
                    Poll::Pending => continue,
                    Poll::Ready(value) => value,
                };
                let (slot, _) = pending.swap_remove(index);
                progressed = true;
                match ready {
                    Ok(value) => result[slot] = Some(value),
                    Err(error) => {
                        if failure.is_none() {
                            read.stop();
                            failure = Some(error);
                        }
                    }
                }
            }
            if pending.is_empty() && (failure.is_some() || next == ids.len()) {
                return Poll::Ready(match failure.take() {
                    Some(error) => Err(error),
                    None => result
                        .iter_mut()
                        .map(Option::take)
                        .collect::<Option<Vec<_>>>()
                        .ok_or_else(|| {
                            AppError::new(codes::MALFORMED_RESPONSE, "incomplete package summary")
                        }),
                });
            }
            // Do not drop started futures on the first failure: drain their
            // guards/HTTP budget before returning, and never schedule a new card.
            if !progressed {
                return Poll::Pending;
            }
        })
        .await
    }
    pub fn resolve(
        &self,
        account: &AccountContext,
        gid: &str,
        query_handle: &str,
        detail_handle: &str,
    ) -> Result<BoundPlan, AppError> {
        let status = self.service.status();
        let now = self.service.now_ms();
        let queries = self.queries.lock().unwrap_or_else(|e| e.into_inner());
        let q = queries
            .iter()
            .find(|q| {
                q.summary.query_handle == query_handle
                    && q.scope.account == *account
                    && q.scope.gid == gid
                    && q.epoch == status.session_epoch
                    && status.logged_in
                    && now.saturating_sub(q.summary.fetched_at_ms) < HANDLE_TTL_MS
            })
            .ok_or_else(|| invalid("order query handle is invalid or expired"))?;
        let card = q
            .cards
            .iter()
            .find(|(handle, _)| handle == detail_handle)
            .ok_or_else(|| invalid("package handle does not belong to this order query"))?;
        Ok(BoundPlan {
            scope: q.scope.clone(),
            session_epoch: q.epoch,
            card_id: card.1.clone(),
        })
    }
    pub async fn detail<F, Fut>(
        &self,
        plan: &BoundPlan,
        validate: &F,
    ) -> Result<PackageDetail, AppError>
    where
        F: Fn() -> Fut + Sync,
        Fut: Future<Output = Result<(), AppError>> + Send,
    {
        let epoch = plan.session_epoch;
        let session = self.session(epoch, validate).await?;
        let response = self
            .request(epoch, detail_request(&session, &plan.card_id), validate)
            .await?;
        let detail = parse_detail(response.status, &response.body)
            .map_err(|e| self.service.auth_error(epoch, e))?;
        let live = self
            .supplement(
                epoch,
                live_detail_request(&session, &plan.card_id),
                validate,
            )
            .await?;
        let cdr = self
            .supplement(epoch, cdr_more_request(&session, &plan.card_id), validate)
            .await?;
        self.guard(epoch, validate).await?;
        Ok(PackageDetail {
            order_id: plan.scope.order_id.clone(),
            session_epoch: epoch,
            plan: OrderPackageInfo::project(&detail, live.as_ref(), self.service.now_ms()),
            detail_fields: order::detail_fields(&detail)
                .into_iter()
                .map(Into::into)
                .collect(),
            live_fields: live
                .as_ref()
                .map(order::live_fields)
                .unwrap_or_default()
                .into_iter()
                .map(Into::into)
                .collect(),
            cdrs: order::cdr_fields(&detail, cdr.as_ref())
                .into_iter()
                .map(|r| r.into_iter().map(Into::into).collect())
                .collect(),
            fetched_at_ms: self.service.now_ms(),
        })
    }
    async fn supplement<F, Fut>(
        &self,
        epoch: u64,
        req: Result<core_assistant::TsimRequest, AppError>,
        validate: &F,
    ) -> Result<Option<JsonValue>, AppError>
    where
        F: Fn() -> Fut + Sync,
        Fut: Future<Output = Result<(), AppError>> + Send,
    {
        match self.request(epoch, req, validate).await {
            Ok(r) => {
                parse_supplement(r.status, &r.body).map_err(|e| self.service.auth_error(epoch, e))
            }
            Err(e)
                if e.is(codes::NOT_LOGGED_IN)
                    || e.is(codes::FORBIDDEN)
                    || e.is(contracts::codes::ACCOUNT_STALE_GENERATION) =>
            {
                Err(e)
            }
            Err(_) => {
                self.guard(epoch, validate).await?;
                Ok(None)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use core_assistant::TsimRequest;
    use std::sync::atomic::{AtomicBool, Ordering};
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
    #[derive(Clone, Default)]
    struct Http {
        paths: Arc<Mutex<Vec<String>>>,
        urls: Arc<Mutex<Vec<String>>>,
        known_quota: Arc<AtomicBool>,
    }
    fn path(req: &TsimRequest) -> &str {
        req.url
            .strip_prefix("https://csapi.tsim.tech")
            .unwrap()
            .split('?')
            .next()
            .unwrap()
    }
    fn reply(value: &str) -> Result<HttpResponse, AppError> {
        Ok(HttpResponse {
            status: 200,
            body: value.into(),
        })
    }
    fn respond(req: &TsimRequest) -> Result<HttpResponse, AppError> {
        match path(req) {
            "/agent/login" => reply(
                r#"{"success":true,"data":{"access_token":"synthetic-token","token_type":"bearer","session_ref":"synthetic-ref"}}"#,
            ),
            "/agent/profile" => reply(
                r#"{"success":true,"data":{"id":1,"is_active":true,"permissions":["complaint_records"]}}"#,
            ),
            "/agent/logout" => reply(r#"{"success":true,"data":null}"#),
            "/agent/package-query/perform" => {
                reply(r#"{"code":1,"result":{"query_id":"synthetic-query"}}"#)
            }
            "/agent/package-query/dataplan-list" => reply(
                r#"{"code":1,"result":[{"card_dataplan_id":"synthetic-card-1","iccid":"synthetic-iccid-1","channel_dataplan_name":"synthetic-plan-1","package_status":"using"},{"card_dataplan_id":"synthetic-card-2","iccid":"synthetic-iccid-2","channel_dataplan_name":"synthetic-plan-2","package_status":"inactive"}]}"#,
            ),
            "/agent/package-query/detail" => {
                let id = req.url.split("card_dataplan_id=").nth(1).unwrap();
                assert!(["synthetic-card-1", "synthetic-card-2"].contains(&id));
                let suffix = id.strip_prefix("synthetic-card-").unwrap();
                reply(&serde_json::json!({"code":1,"result":{"iccid":format!("synthetic-iccid-{suffix}"),"channel_dataplan_name":format!("synthetic-plan-{suffix}"),"package_status":"using","cdr_list":[],"activation_code":"FORBIDDEN_SECRET"}}).to_string())
            }
            "/agent/package-query/live-detail" => {
                reply(r#"{"code":1,"result":{"volume":2048,"data_usage":512}}"#)
            }
            "/agent/package-query/cdr-more" => reply(
                r#"{"code":1,"result":[{"start_time":"2026-10-31 12:00:00","total_mb":512,"country":"JP","imsi":"FORBIDDEN_SECRET"}]}"#,
            ),
            _ => panic!("unexpected synthetic endpoint"),
        }
    }
    impl Executor for Http {
        async fn execute(&self, req: &TsimRequest) -> Result<HttpResponse, AppError> {
            self.paths.lock().unwrap().push(path(req).to_string());
            self.urls.lock().unwrap().push(req.url.clone());
            if path(req) == "/agent/package-query/live-detail"
                && !self.known_quota.load(Ordering::SeqCst)
            {
                return reply(r#"{"code":1,"result":{"data_usage":512}}"#);
            }
            respond(req)
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
    fn run<F: Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }
    #[test]
    fn order_book_keeps_all_plans_and_queries_only_the_exact_selected_card() {
        run(async {
            let http = Http::default();
            let svc = Arc::new(Service::new(
                http.clone(),
                MemoryVault::default(),
                Box::new(|| 1_793_000_000_000),
            ));
            let epoch = svc
                .login("synthetic-user", "synthetic-password".into())
                .await
                .unwrap()
                .session_epoch;
            http.paths.lock().unwrap().clear();
            let book = OrderBook::new(svc.clone());
            let scope = scope();
            let valid = || async { Ok(()) };
            let summary = book.summary(scope.clone(), epoch, &valid).await.unwrap();
            assert_eq!(summary.total, 2);
            assert_eq!(summary.plans.len(), 2);
            assert_eq!(summary.plans[1].info.iccid, "synthetic-iccid-2");
            assert!(summary.plans.iter().all(|p| p.info.remain_pct.is_none()));
            assert!(summary.plans[0].info.detail_fields.iter().any(|field| field.label == "渠道套餐" && field.value == "synthetic-plan-1"));
            let summary_wire = serde_json::to_string(&summary).unwrap();
            assert!(!summary_wire.contains("FORBIDDEN_SECRET") && !summary_wire.contains("activation_code"));
            assert_eq!(
                *http.paths.lock().unwrap(),
                [
                    "/agent/package-query/perform",
                    "/agent/package-query/dataplan-list",
                    "/agent/package-query/detail",
                    "/agent/package-query/live-detail",
                    "/agent/package-query/cdr-more",
                    "/agent/package-query/detail",
                    "/agent/package-query/live-detail",
                    "/agent/package-query/cdr-more"
                ]
            );
            book.summary(scope.clone(), epoch, &valid).await.unwrap();
            assert_eq!(http.paths.lock().unwrap().len(), 8);
            assert_eq!(summary.plans[0].info.cdrs.len(), 1);
            let plan = book
                .resolve(
                    &scope.account,
                    &scope.gid,
                    &summary.query_handle,
                    &summary.plans[1].detail_handle,
                )
                .unwrap();
            http.known_quota.store(true, Ordering::SeqCst);
            let before_detail = http.urls.lock().unwrap().len();
            let detail = book.detail(&plan, &valid).await.unwrap();
            assert!(
                http.urls.lock().unwrap()[before_detail..]
                    .iter()
                    .all(|url| url.ends_with("card_dataplan_id=synthetic-card-2")),
                "explicit detail reads only the selected card"
            );
            assert_eq!(detail.plan.iccid, "synthetic-iccid-2");
            assert_eq!(detail.plan.remain_pct, Some(75.0));
            assert_eq!(detail.cdrs.len(), 1);
            let wire = serde_json::to_string(&detail).unwrap();
            assert!(
                !wire.contains("FORBIDDEN_SECRET")
                    && !wire.contains("synthetic-token")
                    && !wire.contains("synthetic-ref")
                    && !wire.contains("synthetic-card")
            );
            assert!(book
                .resolve(
                    &scope.account,
                    "wrong-gid",
                    &summary.query_handle,
                    &summary.plans[1].detail_handle
                )
                .is_err());
            let mut wrong = scope.account.clone();
            wrong.session_generation += 1;
            assert!(book
                .resolve(
                    &wrong,
                    &scope.gid,
                    &summary.query_handle,
                    &summary.plans[1].detail_handle
                )
                .is_err());
            let mut other_scope = scope.clone();
            other_scope.context_revision = uuid::Uuid::new_v4().to_string();
            let other = book.summary(other_scope, epoch, &valid).await.unwrap();
            assert!(book
                .resolve(
                    &scope.account,
                    &scope.gid,
                    &other.query_handle,
                    &summary.plans[1].detail_handle
                )
                .is_err());
            svc.logout().await.unwrap();
            svc.login("synthetic-user", "synthetic-password".into())
                .await
                .unwrap();
            assert!(book
                .resolve(
                    &scope.account,
                    &scope.gid,
                    &summary.query_handle,
                    &summary.plans[1].detail_handle
                )
                .is_err());
            let count = http.paths.lock().unwrap().len();
            assert!(book.detail(&plan, &valid).await.is_err());
            assert_eq!(http.paths.lock().unwrap().len(), count);
        });
    }
    #[derive(Clone)]
    struct Gate {
        http: Http,
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    }
    impl Executor for Gate {
        async fn execute(&self, req: &TsimRequest) -> Result<HttpResponse, AppError> {
            if path(req) == "/agent/package-query/perform" {
                self.entered.notify_one();
                self.release.notified().await;
            }
            self.http.execute(req).await
        }
    }
    #[test]
    fn order_book_stops_before_the_next_http_when_conversation_binding_changes() {
        run(async {
            let exec = Gate {
                http: Http::default(),
                entered: Arc::default(),
                release: Arc::default(),
            };
            let svc = Arc::new(Service::new(
                exec.clone(),
                MemoryVault::default(),
                Box::new(|| 1_793_000_000_000),
            ));
            let epoch = svc
                .login("synthetic-user", "synthetic-password".into())
                .await
                .unwrap()
                .session_epoch;
            exec.http.paths.lock().unwrap().clear();
            let book = Arc::new(OrderBook::new(svc));
            let current = Arc::new(AtomicBool::new(true));
            let changed = current.clone();
            let pending_book = book.clone();
            let pending = tauri::async_runtime::spawn(async move {
                let valid = || {
                    let current = current.clone();
                    async move {
                        if current.load(Ordering::SeqCst) {
                            Ok(())
                        } else {
                            Err(invalid("conversation changed"))
                        }
                    }
                };
                pending_book.summary(scope(), epoch, &valid).await
            });
            exec.entered.notified().await;
            changed.store(false, Ordering::SeqCst);
            exec.release.notify_one();
            assert!(pending.await.unwrap().is_err());
            assert_eq!(
                *exec.http.paths.lock().unwrap(),
                ["/agent/package-query/perform"]
            );
        });
    }
}

#[cfg(test)]
#[path = "order_summary_hydration_tests.rs"]
mod hydration_tests;

//! TSim assistant service: session lifecycle (login / restore / refresh /
//! logout), outbound translation and package quick view, on top of the
//! pure request builders and parsers of `core-assistant`.
//!
//! Generic over the HTTP [`Executor`] and the secret [`Vault`] so it can be
//! tested without network or keychain. Invariants:
//! * the password only lives in the `LoginForm` for the duration of the
//!   login request; it is never stored or logged;
//! * the access token is persisted only through the vault (system
//!   credential store), never logged (`SecretString` redacts `Debug`);
//! * 401/423 drop the local session, 403 does not;
//! * results that come back after the TSim identity changed (login /
//!   logout / cleared session; `epoch`) are discarded;
//! * translations are re-validated against the Ctrip account context after
//!   the request, so an old `session_generation` is rejected;
//! * nothing is retried automatically (a timeout surfaces as `net.timeout`).

use std::sync::{Mutex, MutexGuard};

use contracts::json::JsonValue;
use contracts::{AccountContext, AccountId, AppError, Environment};
use core_assistant::session::codes;
use core_assistant::{
    dataplan_list_request, detail_request, live_detail_request, login, logout, parse_dataplan_list,
    parse_detail, parse_login_response, parse_logout_response, parse_perform,
    parse_profile_response, parse_refresh_response, parse_supplement, parse_translate_response,
    perform_request, pick_dataplan, profile, refresh, summarize, translate_request,
    validate_order_nums, CacheClaim, LoginForm, PackageCache, PackagePermission, SecretString,
    TokenData, TranslationCache, TsimSession,
};
use serde::{Deserialize, Serialize};

use super::http::{Executor, HttpResponse};

/// After a failed refresh (not 401/423), wait this long before trying again.
pub const REFRESH_RETRY_MS: i64 = 60 * 1000;

/// Secret storage for the persisted TSim session (one opaque string).
pub trait Vault: Send + Sync + 'static {
    fn load(&self) -> Result<Option<String>, AppError>;
    fn save(&self, value: &str) -> Result<(), AppError>;
    fn clear(&self) -> Result<(), AppError>;
}

/// `UiTsimStatus`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TsimStatus {
    pub logged_in: bool,
    pub user: Option<String>,
}

/// `UiPackageInfo`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PackageInfo {
    pub iccid: String,
    pub plan: String,
    pub status: String,
    pub remain_pct: f64,
    pub remain: String,
    pub total: String,
    pub supplier: String,
    pub apn: String,
    pub fetched_at_ms: i64,
}

/// What the vault holds. No password; `Debug` is not derived.
#[derive(Serialize, Deserialize)]
struct StoredSession {
    user: String,
    access_token: String,
    session_ref: String,
    expires_at_ms: Option<i64>,
    issued_at_ms: i64,
}

#[derive(Default)]
struct Inner {
    session: Option<TsimSession>,
    user: Option<String>,
    profile_loaded: bool,
    /// Bumps on login, logout and session clear (not on refresh).
    epoch: u64,
    refresh_not_before_ms: i64,
    translations: TranslationCache,
    packages: PackageCache<PackageInfo>,
}

pub type Clock = Box<dyn Fn() -> i64 + Send + Sync>;

pub struct Service<E: Executor, V: Vault> {
    exec: E,
    vault: V,
    now: Clock,
    inner: Mutex<Inner>,
    refresh_lock: tokio::sync::Mutex<()>,
    login_lock: tokio::sync::Mutex<()>,
}

fn not_logged_in(msg: &str) -> AppError {
    AppError::new(codes::NOT_LOGGED_IN, msg)
}

fn invalid(msg: &str) -> AppError {
    AppError::new(codes::INVALID_INPUT, msg)
}

impl<E: Executor, V: Vault> Service<E, V> {
    pub fn new(exec: E, vault: V, now: Clock) -> Self {
        Self {
            exec,
            vault,
            now,
            inner: Mutex::new(Inner::default()),
            refresh_lock: tokio::sync::Mutex::new(()),
            login_lock: tokio::sync::Mutex::new(()),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn now_ms(&self) -> i64 {
        (self.now)()
    }

    pub fn status(&self) -> TsimStatus {
        let g = self.lock();
        TsimStatus {
            logged_in: g.session.is_some(),
            user: g.session.as_ref().and(g.user.clone()),
        }
    }

    fn persist(&self, user: &str, s: &TsimSession) {
        let stored = StoredSession {
            user: user.to_string(),
            access_token: s.access_token.expose().to_string(),
            session_ref: s.session_ref.clone(),
            expires_at_ms: s.expires_at_ms,
            issued_at_ms: s.issued_at_ms,
        };
        let saved = serde_json::to_string(&stored)
            .map_err(|_| AppError::new(codes::MALFORMED_RESPONSE, "encode session"))
            .and_then(|json| self.vault.save(&json));
        if let Err(e) = saved {
            // The session stays usable for this run; only the code is logged.
            log::warn!("assistant: persisting tsim session failed: {}", e.code);
        }
    }

    /// Drops the session if it still belongs to `epoch`.
    fn clear_if(&self, epoch: u64) {
        let mut g = self.lock();
        if g.epoch != epoch || g.session.is_none() {
            return;
        }
        Self::reset(&mut g);
        drop(g);
        if let Err(e) = self.vault.clear() {
            log::warn!("assistant: clearing tsim session failed: {}", e.code);
        }
    }

    fn reset(g: &mut Inner) {
        g.session = None;
        g.user = None;
        g.profile_loaded = false;
        g.epoch += 1;
        g.refresh_not_before_ms = 0;
        g.translations.clear();
        g.packages.clear();
    }

    /// 401/423 → clear the session and report "log in to TSim".
    fn auth_error(&self, epoch: u64, e: AppError) -> AppError {
        if e.is(codes::SESSION_CLEARED) {
            self.clear_if(epoch);
            let mut out = not_logged_in("tsim session expired; log in again");
            out.detail = e.detail;
            out
        } else {
            e
        }
    }

    fn snapshot(&self) -> Option<(TsimSession, u64)> {
        let g = self.lock();
        g.session.clone().map(|s| (s, g.epoch))
    }

    fn epoch(&self) -> u64 {
        self.lock().epoch
    }

    /// Loads the persisted session (startup). Malformed entries are dropped.
    pub fn restore(&self) {
        let raw = match self.vault.load() {
            Ok(Some(raw)) => raw,
            Ok(None) => return,
            Err(e) => {
                log::warn!("assistant: reading tsim session failed: {}", e.code);
                return;
            }
        };
        let Ok(stored) = serde_json::from_str::<StoredSession>(&raw) else {
            log::warn!("assistant: stored tsim session is malformed; dropped");
            let _ = self.vault.clear();
            return;
        };
        if stored.access_token.is_empty() {
            let _ = self.vault.clear();
            return;
        }
        let token = TokenData {
            access_token: SecretString::new(stored.access_token),
            token_type: "bearer".into(),
            session_ref: stored.session_ref,
            expires_at_ms: stored.expires_at_ms,
        };
        let mut g = self.lock();
        g.epoch += 1;
        g.session = Some(TsimSession::from_token(token, stored.issued_at_ms, g.epoch));
        g.user = Some(stored.user);
        g.profile_loaded = false;
    }

    /// Returns a session whose token is not due for refresh, refreshing it
    /// first when needed (single flight). A failed refresh other than
    /// 401/423 keeps the old token while it has not expired.
    pub async fn ensure_fresh(&self) -> Result<(TsimSession, u64), AppError> {
        let now = self.now_ms();
        let (s, epoch) = self
            .snapshot()
            .ok_or_else(|| not_logged_in("tsim login required"))?;
        if !s.refresh_due(now) || now < self.lock().refresh_not_before_ms {
            return Self::usable(s, epoch, now);
        }
        let _flight = self.refresh_lock.lock().await;
        let (s, epoch) = self
            .snapshot()
            .ok_or_else(|| not_logged_in("tsim login required"))?;
        let now = self.now_ms();
        if !s.refresh_due(now) || now < self.lock().refresh_not_before_ms {
            return Self::usable(s, epoch, now);
        }
        let result = match self.exec.execute(&refresh(s.access_token.expose())).await {
            Ok(HttpResponse { status, body }) => parse_refresh_response(status, &body),
            Err(e) => Err(e),
        };
        let now = self.now_ms();
        match result {
            Ok(token) => {
                let mut g = self.lock();
                if g.epoch != epoch {
                    drop(g);
                    return self
                        .snapshot()
                        .ok_or_else(|| not_logged_in("tsim login required"));
                }
                let Some(cur) = g.session.as_mut() else {
                    return Err(not_logged_in("tsim login required"));
                };
                cur.apply_refresh(token, now);
                let fresh = cur.clone();
                let user = g.user.clone().unwrap_or_default();
                g.refresh_not_before_ms = 0;
                drop(g);
                self.persist(&user, &fresh);
                Ok((fresh, epoch))
            }
            Err(e) if e.is(codes::SESSION_CLEARED) => Err(self.auth_error(epoch, e)),
            Err(e) => {
                log::warn!("assistant: tsim refresh failed: {}", e.code);
                {
                    let mut g = self.lock();
                    if g.epoch == epoch {
                        g.refresh_not_before_ms = now + REFRESH_RETRY_MS;
                    }
                }
                if s.is_expired(now) {
                    Err(e)
                } else {
                    Ok((s, epoch))
                }
            }
        }
    }

    fn usable(s: TsimSession, epoch: u64, now: i64) -> Result<(TsimSession, u64), AppError> {
        if s.is_expired(now) {
            Err(AppError::new(
                codes::SERVICE_UNAVAILABLE,
                "tsim token expired and refresh failed",
            )
            .retryable())
        } else {
            Ok((s, epoch))
        }
    }

    /// Reads `/agent/profile` into the session (permissions, is_active).
    pub async fn load_profile(&self) -> Result<TsimSession, AppError> {
        let (s, epoch) = self.ensure_fresh().await?;
        let parsed = match self.exec.execute(&profile(s.access_token.expose())).await {
            Ok(HttpResponse { status, body }) => parse_profile_response(status, &body),
            Err(e) => Err(e),
        };
        let p = parsed.map_err(|e| self.auth_error(epoch, e))?;
        let mut g = self.lock();
        if g.epoch != epoch {
            return Err(not_logged_in("tsim identity changed"));
        }
        let cur = g
            .session
            .as_mut()
            .ok_or_else(|| not_logged_in("tsim login required"))?;
        cur.apply_profile(&p);
        let out = cur.clone();
        g.profile_loaded = true;
        if !out.is_active {
            Self::reset(&mut g);
            drop(g);
            let _ = self.vault.clear();
            return Err(AppError::new(
                codes::FORBIDDEN,
                "tsim account is not active",
            ));
        }
        Ok(out)
    }

    /// Background upkeep: refresh when due and load the profile once.
    pub async fn maintain(&self) {
        if self.snapshot().is_none() {
            return;
        }
        if let Err(e) = self.ensure_fresh().await {
            log::info!("assistant: tsim upkeep: {}", e.code);
            return;
        }
        if !self.lock().profile_loaded {
            if let Err(e) = self.load_profile().await {
                log::info!("assistant: tsim profile: {}", e.code);
            }
        }
    }

    /// `POST /agent/login` then `/agent/profile`. The password is consumed.
    pub async fn login(&self, user: &str, password: String) -> Result<TsimStatus, AppError> {
        let user = user.trim();
        if user.is_empty() || password.is_empty() {
            return Err(invalid("username and password are required"));
        }
        let _serial = self.login_lock.lock().await;
        let form = LoginForm {
            username: user.to_string(),
            password: SecretString::new(password),
        };
        let boundary = format!("vbk-tsim-{}", uuid::Uuid::new_v4().simple());
        let req = login(&form, &boundary)?;
        drop(form);
        let resp = self.exec.execute(&req).await;
        drop(req);
        let token = match resp {
            Ok(HttpResponse { status, body }) => parse_login_response(status, &body)?,
            Err(e) => return Err(e),
        };
        let now = self.now_ms();
        let previous = {
            let mut g = self.lock();
            let prev = g.session.take().map(|s| s.access_token);
            Self::reset(&mut g);
            g.session = Some(TsimSession::from_token(token, now, g.epoch));
            g.user = Some(user.to_string());
            prev
        };
        if let Some(old) = previous {
            // Best effort: end the replaced server session.
            let _ = self.exec.execute(&logout(old.expose())).await;
        }
        match self.load_profile().await {
            Ok(s) => self.persist(user, &s),
            Err(e) if e.is(codes::NOT_LOGGED_IN) || e.is(codes::FORBIDDEN) => return Err(e),
            Err(e) => {
                // Keep the login; permissions load later.
                log::info!("assistant: tsim profile after login: {}", e.code);
                if let Some((s, _)) = self.snapshot() {
                    self.persist(user, &s);
                }
            }
        }
        Ok(self.status())
    }

    /// Clears the local session and the vault, then best-effort logs out
    /// on the server.
    pub async fn logout(&self) -> TsimStatus {
        let token = {
            let mut g = self.lock();
            let t = g.session.take().map(|s| s.access_token);
            Self::reset(&mut g);
            t
        };
        if let Err(e) = self.vault.clear() {
            log::warn!("assistant: clearing tsim session failed: {}", e.code);
        }
        if let Some(t) = token {
            let r = match self.exec.execute(&logout(t.expose())).await {
                Ok(HttpResponse { status, body }) => parse_logout_response(status, &body),
                Err(e) => Err(e),
            };
            if let Err(e) = r {
                log::info!("assistant: tsim server logout: {}", e.code);
            }
        }
        self.status()
    }

    /// Outbound translation for `(account, gid, draft_version)`. `validate`
    /// checks the Ctrip account context (generation) before and after the
    /// request; the caller echoes `draft_version` unchanged.
    pub async fn translate(
        &self,
        account: &AccountContext,
        draft_version: u64,
        text: &str,
        target: &str,
        validate: &(dyn Fn(&AccountContext) -> Result<(), AppError> + Sync),
    ) -> Result<String, AppError> {
        validate(account)?;
        let (session, epoch) = self.ensure_fresh().await?;
        let now = self.now_ms();
        let claim = self.lock().translations.claim(account, text, target, now);
        let owned = match claim {
            CacheClaim::Hit(t) => {
                validate(account)?;
                return Ok(t);
            }
            CacheClaim::InFlight => false,
            CacheClaim::Claimed => true,
        };
        let release = |svc: &Self| {
            if owned {
                svc.lock().translations.fail(account, text, target);
            }
        };
        let draft_request_id = uuid::Uuid::new_v4().hyphenated().to_string();
        let version = draft_version.to_string();
        let (req, sent) =
            match translate_request(&session, text, target, &draft_request_id, &version) {
                Ok(v) => v,
                Err(e) => {
                    release(self);
                    return Err(e);
                }
            };
        let parsed = match self.exec.execute(&req).await {
            Ok(HttpResponse { status, body }) => parse_translate_response(status, &body, &sent),
            Err(e) => Err(e),
        };
        let translated = match parsed {
            Ok(t) => t,
            Err(e) => {
                release(self);
                return Err(self.auth_error(epoch, e));
            }
        };
        {
            let mut g = self.lock();
            if g.epoch != epoch {
                return Err(not_logged_in("tsim identity changed during translation"));
            }
            if owned {
                g.translations
                    .complete(account, text, target, translated.clone(), self.now_ms());
            }
        }
        validate(account)?;
        Ok(translated)
    }

    /// Package quick view: `perform → dataplan-list → detail (+ live-detail)`,
    /// reused for 60 s per TSim identity.
    pub async fn package_quick_view(&self, iccid: &str) -> Result<PackageInfo, AppError> {
        let identifier = validate_order_nums(iccid)?;
        let profile_loaded = self.lock().profile_loaded;
        let session = if profile_loaded {
            self.ensure_fresh().await?.0
        } else {
            self.load_profile().await?
        };
        PackagePermission::evaluate(&session).check()?;
        let epoch = self.epoch();
        let key = AccountContext::new(AccountId::new("tsim"), Environment::named("tsim"), epoch);
        let now = self.now_ms();
        let hit = self.lock().packages.get(&key, &identifier, now).cloned();
        if let Some(hit) = hit {
            return Ok(hit);
        }
        let info = self
            .package_chain(&session, &identifier)
            .await
            .map_err(|e| self.auth_error(epoch, e))?;
        let mut g = self.lock();
        if g.epoch != epoch {
            return Err(not_logged_in("tsim identity changed during package lookup"));
        }
        g.packages
            .put(&key, &identifier, info.clone(), info.fetched_at_ms);
        Ok(info)
    }

    async fn run(
        &self,
        req: Result<core_assistant::TsimRequest, AppError>,
    ) -> Result<HttpResponse, AppError> {
        self.exec.execute(&req?).await
    }

    async fn package_chain(
        &self,
        s: &TsimSession,
        identifier: &str,
    ) -> Result<PackageInfo, AppError> {
        let r = self.run(perform_request(s, identifier)).await?;
        let query_id = parse_perform(r.status, &r.body)?;
        let r = self.run(dataplan_list_request(s, &query_id)).await?;
        let rows = parse_dataplan_list(r.status, &r.body)?;
        let card = pick_dataplan(&rows, identifier)?;
        let r = self.run(detail_request(s, &card)).await?;
        let detail = parse_detail(r.status, &r.body)?;
        // Supplementary: a transport failure is an empty block, 401/423 surface.
        let live: Option<JsonValue> = match self.run(live_detail_request(s, &card)).await {
            Ok(r) => parse_supplement(r.status, &r.body)?,
            Err(_) => None,
        };
        let sum = summarize(identifier, &detail, live.as_ref());
        Ok(PackageInfo {
            iccid: sum.iccid,
            plan: sum.plan,
            status: sum.status,
            remain_pct: sum.remain_pct,
            remain: sum.remain,
            total: sum.total,
            supplier: sum.supplier,
            apn: sum.apn,
            fetched_at_ms: self.now_ms(),
        })
    }
}

#[cfg(test)]
#[path = "service_tests.rs"]
mod tests;

//! Per-runtime WebView crash recovery. Never retries a business operation.
#[cfg(any(target_os = "windows", test))]
use std::sync::atomic::AtomicU8;
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, Webview};

#[cfg(any(target_os = "windows", test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProcessFailure {
    Renderer = 1,
    Browser = 2,
}
#[cfg(any(target_os = "windows", test))]
#[derive(Default)]
struct PendingProcessFailures(AtomicU8);
#[cfg(any(target_os = "windows", test))]
impl PendingProcessFailures {
    fn record(&self, failure: ProcessFailure) {
        self.0.fetch_or(failure as u8, Ordering::SeqCst);
    }
    fn take_ready(&self, ready: &AtomicBool) -> Option<ProcessFailure> {
        if !ready.load(Ordering::SeqCst) {
            return None;
        }
        let failures = self.0.swap(0, Ordering::SeqCst);
        if failures & ProcessFailure::Browser as u8 != 0 {
            Some(ProcessFailure::Browser)
        } else if failures & ProcessFailure::Renderer as u8 != 0 {
            Some(ProcessFailure::Renderer)
        } else {
            None
        }
    }
}

const WINDOW: Duration = Duration::from_secs(300);
const LIMIT: usize = 3;
static NEXT: AtomicU64 = AtomicU64::new(1);
static READY: AtomicBool = AtomicBool::new(false);
static VIEWS: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
fn views() -> std::sync::MutexGuard<'static, HashMap<String, Entry>> {
    VIEWS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}
#[derive(Default)]
struct Budget {
    crashes: VecDeque<Instant>,
}
impl Budget {
    fn failure(&mut self, now: Instant) -> Option<Duration> {
        while self
            .crashes
            .front()
            .is_some_and(|t| now.duration_since(*t) >= WINDOW)
        {
            self.crashes.pop_front();
        }
        self.crashes.push_back(now);
        // Bounded storage even under repeated native notifications.
        while self.crashes.len() > LIMIT + 1 {
            self.crashes.pop_front();
        }
        (self.crashes.len() <= LIMIT).then(|| Duration::from_secs(1 << (self.crashes.len() - 1)))
    }
}
#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
enum ListenerStage {
    Dispatch,
    Controller,
    Subscribe,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
struct ListenerError {
    stage: ListenerStage,
    hresult: Option<i32>,
}
#[cfg(any(target_os = "windows", test))]
#[derive(Default)]
struct ListenerMachine {
    ticket: u64,
    installing: bool,
    start_revision: u64,
    outcome: Option<Result<(), ListenerError>>,
    dirty: bool,
}
#[cfg(any(target_os = "windows", test))]
impl ListenerMachine {
    fn begin(&mut self, revision: u64) -> Option<u64> {
        if self.installing {
            return None;
        }
        self.ticket += 1;
        self.installing = true;
        self.start_revision = revision;
        self.outcome = None;
        self.dirty = false;
        Some(self.ticket)
    }
    fn complete(&mut self, ticket: u64, result: Result<(), ListenerError>) -> bool {
        if !self.installing || self.ticket != ticket {
            return false;
        }
        self.installing = false;
        self.outcome = Some(result);
        self.dirty = true;
        true
    }
}
#[derive(Clone, serde::Serialize)]
pub struct RecoveryStatus {
    label: String,
    incarnation: u64,
    revision: u64,
    phase: &'static str,
    attempt: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    listener_error: Option<ListenerError>,
}
struct Entry {
    status: RecoveryStatus,
    budget: Budget,
    serial: u64,
    account: Option<contracts::AccountContext>,
    #[cfg(any(target_os = "windows", test))]
    listener: ListenerMachine,
}
impl Entry {
    fn finish_recovery_phase(&mut self, phase: &'static str) {
        self.status.phase =
            if self.status.listener_error.is_some() && matches!(phase, "healthy" | "reloaded") {
                "listener_failed"
            } else {
                phase
            };
        self.status.revision += 1;
    }
    #[cfg(any(target_os = "windows", test))]
    fn begin_browser_failure(&mut self, incarnation: u64) -> Option<RecoveryStatus> {
        if self.status.incarnation != incarnation || self.status.phase == "restart_required" {
            return None;
        }
        self.serial += 1;
        self.status.revision += 1;
        self.status.phase = "restart_required";
        Some(self.status.clone())
    }
    #[cfg(any(target_os = "windows", test))]
    fn begin_listener(
        &mut self,
        incarnation: u64,
        revision: Option<u64>,
    ) -> Option<(u64, Option<RecoveryStatus>)> {
        if self.status.incarnation != incarnation || self.listener.installing {
            return None;
        }
        if let Some(revision) = revision {
            if !self.matches(incarnation, revision, "listener_failed") {
                return None;
            }
            self.status.revision += 1;
            self.status.phase = "listener_retrying";
        }
        let ticket = self.listener.begin(self.status.revision)?;
        Some((ticket, revision.map(|_| self.status.clone())))
    }
    #[cfg(any(target_os = "windows", test))]
    fn flush_listener(&mut self, ready: bool) -> Option<RecoveryStatus> {
        if !ready || !self.listener.dirty {
            return None;
        }
        self.listener.dirty = false;
        match self.listener.outcome? {
            Err(error) => {
                self.status.listener_error = Some(error);
                if matches!(
                    self.status.phase,
                    "healthy" | "reloaded" | "listener_retrying" | "listener_failed"
                ) {
                    self.status.phase = "listener_failed";
                }
            }
            Ok(()) => {
                self.status.listener_error = None;
                if matches!(self.status.phase, "listener_retrying" | "listener_failed") {
                    self.status.phase = "healthy";
                } else if self.status.phase == "healthy"
                    && self.status.revision == self.listener.start_revision
                {
                    return None; // initial healthy installation needs no recovery announcement
                }
            }
        }
        self.status.revision += 1;
        Some(self.status.clone())
    }
    fn matches(&self, incarnation: u64, revision: u64, phase: &str) -> bool {
        self.status.incarnation == incarnation
            && self.status.revision == revision
            && self.status.phase == phase
    }
}
struct Registration {
    #[cfg(target_os = "macos")]
    pending: AtomicBool,
    #[cfg(target_os = "windows")]
    process_failures: PendingProcessFailures,
    #[cfg(target_os = "windows")]
    app: tauri::AppHandle,
    label: String,
    incarnation: u64,
}
impl tauri::Resource for Registration {}
impl Drop for Registration {
    fn drop(&mut self) {
        let mut map = views();
        if map
            .get(&self.label)
            .is_some_and(|e| e.status.incarnation == self.incarnation)
        {
            map.remove(&self.label);
        }
        #[cfg(target_os = "windows")]
        {
            let id = self.incarnation;
            let _ = self.app.run_on_main_thread(move || win::remove(id));
        }
    }
}
fn publish(app: &tauri::AppHandle, status: &RecoveryStatus) {
    for label in [crate::views::MAIN, crate::views::SETTING] {
        let _ = app.emit_to(label, "webview://recovery", status);
    }
}
fn registration(view: &Webview) -> Option<std::sync::Arc<Registration>> {
    let table = view.resources_table();
    let entry = table
        .names()
        .find_map(|(rid, _)| table.get::<Registration>(rid).ok());
    entry
}
/// The public API can only prove that the label still resolves to a live
/// webview, not that it is the instance that raised a native callback.
fn is_current_instance(view: &Webview) -> bool {
    view.app_handle().get_webview(view.label()).is_some()
}
fn instance_id(view: &Webview) -> Option<u64> {
    registration(view).map(|entry| entry.incarnation)
}

fn register(view: Webview) {
    // A queued plugin-ready callback may outlive the native creation. It
    // must not replace its successor's registry entry under a reused label.
    if !is_current_instance(&view) {
        return;
    }
    if instance_id(&view).is_some() {
        return;
    }
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let label = view.label().to_string();
    views().insert(
        label.clone(),
        Entry {
            status: RecoveryStatus {
                label: label.clone(),
                incarnation: id,
                revision: 0,
                phase: "healthy",
                attempt: 0,
                listener_error: None,
            },
            budget: Budget::default(),
            serial: 0,
            account: None,
            #[cfg(any(target_os = "windows", test))]
            listener: ListenerMachine::default(),
        },
    );
    view.resources_table().add(Registration {
        #[cfg(target_os = "macos")]
        pending: AtomicBool::new(false),
        #[cfg(target_os = "windows")]
        process_failures: PendingProcessFailures::default(),
        #[cfg(target_os = "windows")]
        app: view.app_handle().clone(),
        label,
        incarnation: id,
    });
    #[cfg(target_os = "windows")]
    let _ = win::attach(&view, id, None);
}
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("webview-recovery")
        .on_webview_ready(register)
        .build()
}
/// Called once after login and adapter initialization, before setup returns.
/// Each concrete view retains at most one pending termination flag.
pub fn ready(app: &tauri::AppHandle) {
    READY.store(true, Ordering::SeqCst);
    #[cfg(target_os = "macos")]
    for view in app.webviews().into_values() {
        consume_pending(&view);
    }
    #[cfg(target_os = "windows")]
    for view in app.webviews().into_values() {
        win::consume_pending(&view);
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = app;
}
/// Upstream's termination hook resolves the view by label, so a late callback
/// from a retired instance can reach a successor that reused the label. This
/// cannot be distinguished with public API; see `docs/reviews` (WebView
/// recovery without a vendored Tauri) for the accepted bound.
#[cfg(target_os = "macos")]
pub fn on_terminated(view: &Webview) {
    if !is_current_instance(&view) {
        return;
    }
    // Plugin-ready can be queued behind this exact callback. Idempotency
    // keeps both paths on the same resource and crash budget.
    register(view.clone());
    if let Some(entry) = registration(view) {
        entry.pending.store(true, Ordering::SeqCst);
        consume_pending(view);
    }
}
#[cfg(target_os = "macos")]
fn consume_pending(view: &Webview) {
    if !is_current_instance(&view) {
        return;
    }
    if let Some(entry) = registration(view) {
        if take_when_ready(&READY, &entry.pending) {
            recover(view.clone(), entry.incarnation, None);
        }
    }
}

#[cfg(any(target_os = "macos", test))]
fn take_when_ready(ready: &AtomicBool, pending: &AtomicBool) -> bool {
    ready.load(Ordering::SeqCst) && pending.swap(false, Ordering::SeqCst)
}
fn recover(view: Webview, id: u64, manual_revision: Option<u64>) {
    let manual = manual_revision.is_some();
    if manual {
        let previous = views().get(view.label()).map(|e| e.account.clone());
        if !previous.is_some_and(|expected| {
            crate::login::recovery_binding_is_current(
                view.app_handle(),
                view.label(),
                expected.as_ref(),
            )
        }) {
            let status = {
                let mut map = views();
                map.get_mut(view.label())
                    .filter(|e| e.matches(id, manual_revision.unwrap(), "manual"))
                    .map(|e| {
                        e.finish_recovery_phase("healthy");
                        e.status.clone()
                    })
            };
            if let Some(status) = status {
                publish(view.app_handle(), &status);
            }
            return;
        }
    }
    let (serial, delay, status, prompt) = {
        let mut map = views();
        let Some(e) = map
            .get_mut(view.label())
            .filter(|e| e.status.incarnation == id)
        else {
            return;
        };
        if manual_revision.is_some_and(|r| r != e.status.revision || e.status.phase != "manual") {
            return;
        }
        if e.status.phase == "retrying" {
            return;
        }
        let was_manual = e.status.phase == "manual";
        e.serial += 1;
        e.status.revision += 1;
        let delay = if manual {
            e.budget.crashes.clear();
            Some(Duration::ZERO)
        } else {
            e.budget.failure(Instant::now())
        };
        e.status.phase = if delay.is_some() {
            "retrying"
        } else {
            "manual"
        };
        e.status.attempt = e.budget.crashes.len();
        (e.serial, delay, e.status.clone(), !was_manual)
    };
    // Revoke old page/RPC generation immediately, including during backoff.
    let account = crate::login::prepare_webview_recovery(view.app_handle(), view.label());
    if let Some(e) = views()
        .get_mut(view.label())
        .filter(|e| e.status.incarnation == id && e.serial == serial)
    {
        e.account = account.clone();
    }
    let view_context = if let Some(host) = view.app_handle().try_state::<crate::state::HostState>()
    {
        let mut cores = host.lock();
        cores
            .views
            .current(view.label())
            .map(|_| cores.views.register(view.label()))
    } else {
        None
    };
    crate::commands::contract_forget(view.label());
    publish(view.app_handle(), &status);
    let Some(delay) = delay else {
        if prompt {
            native_retry(&view, id, status.revision);
        }
        return;
    };
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(delay).await;
        let app = view.app_handle().clone();
        let dispatch = app.clone();
        let failure_app = app.clone();
        let failure_label = view.label().to_string();
        let dispatched = app.run_on_main_thread(move || {
            let current = views().get(view.label()).is_some_and(|e| {
                e.status.incarnation == id && e.serial == serial && e.status.phase == "retrying"
            });
            if !current {
                return;
            }
            if let Some(expected) = &view_context {
                let host = dispatch.state::<crate::state::HostState>();
                if host.lock().views.current(view.label()).as_ref() != Some(expected) {
                    update_phase(&dispatch, view.label(), id, serial, "healthy");
                    return;
                }
            }
            // A logout/switch/relogin during the delay cannot restore its predecessor.
            if !crate::login::recovery_binding_is_current(&dispatch, view.label(), account.as_ref())
            {
                update_phase(&dispatch, view.label(), id, serial, "healthy");
                return;
            }
            let result = view.reload();
            let status = {
                let mut map = views();
                let Some(e) = map
                    .get_mut(view.label())
                    .filter(|e| e.status.incarnation == id && e.serial == serial)
                else {
                    return;
                };
                e.finish_recovery_phase(if result.is_ok() { "reloaded" } else { "manual" });
                e.status.clone()
            };
            publish(&dispatch, &status);
            if result.is_err() {
                native_retry(&view, id, status.revision);
            }
        });
        if dispatched.is_err() {
            update_phase(&failure_app, &failure_label, id, serial, "manual");
        }
    });
}
fn update_phase(app: &tauri::AppHandle, label: &str, id: u64, serial: u64, phase: &'static str) {
    let status = {
        let mut map = views();
        map.get_mut(label)
            .filter(|e| e.status.incarnation == id && e.serial == serial)
            .map(|e| {
                e.finish_recovery_phase(phase);
                e.status.clone()
            })
    };
    if let Some(status) = status {
        publish(app, &status);
    }
}
fn native_retry(view: &Webview, id: u64, revision: u64) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    let app = view.app_handle().clone();
    let label = view.label().to_string();
    view.app_handle()
        .dialog()
        .message("页面多次异常，自动恢复已暂停。重新加载可能丢失尚未保存的输入。")
        .title("页面恢复")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "重新加载".into(),
            "稍后".into(),
        ))
        .show(move |yes| {
            if yes
                && views()
                    .get(&label)
                    .is_some_and(|e| e.matches(id, revision, "manual"))
            {
                if let Some(target) = app.get_webview(&label) {
                    recover(target, id, Some(revision));
                }
            }
        });
}
fn local(view: &Webview, command: &str) -> Result<(), crate::dto::AppErrorDto> {
    let state = view.app_handle().state::<crate::state::HostState>();
    state.authorize(view.label(), command).map_err(Into::into)
}
fn error(code: &str) -> crate::dto::AppErrorDto {
    contracts::AppError::new(code, code).into()
}
#[tauri::command]
pub fn webview_recovery_status(
    webview: Webview,
) -> Result<Vec<RecoveryStatus>, crate::dto::AppErrorDto> {
    local(&webview, "webview_recovery_status")?;
    Ok(views()
        .values()
        .filter(|e| e.status.phase != "healthy")
        .map(|e| e.status.clone())
        .collect())
}
#[tauri::command]
pub fn webview_recovery_retry(
    webview: Webview,
    label: String,
    incarnation: u64,
    revision: u64,
) -> Result<(), crate::dto::AppErrorDto> {
    local(&webview, "webview_recovery_retry")?;
    let phase = views()
        .get(&label)
        .filter(|e| e.status.incarnation == incarnation && e.status.revision == revision)
        .map(|e| e.status.phase);
    if !matches!(phase, Some("manual" | "listener_failed")) {
        return Err(error("recovery.stale_or_not_retryable"));
    }
    let target = webview
        .app_handle()
        .get_webview(&label)
        .ok_or_else(|| error("recovery.closed"))?;
    if !is_current_instance(&target) || instance_id(&target) != Some(incarnation) {
        return Err(error("recovery.closed"));
    }
    if phase == Some("listener_failed") {
        #[cfg(target_os = "windows")]
        return win::attach(&target, incarnation, Some(revision));
        #[cfg(not(target_os = "windows"))]
        return Err(error("recovery.unsupported"));
    }
    recover(target, incarnation, Some(revision));
    Ok(())
}
#[cfg(target_os = "windows")]
mod win {
    use super::*;
    use std::cell::RefCell;
    use webview2_com::{Microsoft::Web::WebView2::Win32::*, ProcessFailedEventHandler};
    struct Subscription {
        core: ICoreWebView2,
        token: i64,
    }
    impl Drop for Subscription {
        fn drop(&mut self) {
            unsafe {
                let _ = self.core.remove_ProcessFailed(self.token);
            }
        }
    }
    thread_local! { static TOKENS: RefCell<HashMap<u64, Subscription>> = RefCell::new(HashMap::new()); }
    pub fn remove(id: u64) {
        TOKENS.with(|t| {
            t.borrow_mut().remove(&id);
        });
    }
    fn record_failure(view: &Webview, id: u64, failure: ProcessFailure) {
        if !is_current_instance(&view) {
            return;
        }
        let Some(entry) = registration(view).filter(|e| e.incarnation == id) else {
            return;
        };
        // Native events can precede user setup. Record before testing READY;
        // neither this path nor subscription registration requires host state.
        entry.process_failures.record(failure);
        consume_pending(view);
    }
    pub fn consume_pending(view: &Webview) {
        if !is_current_instance(&view) {
            return;
        }
        let Some(entry) = registration(view) else {
            return;
        };
        flush_listener(view.app_handle(), view.label(), entry.incarnation);
        match entry.process_failures.take_ready(&READY) {
            Some(ProcessFailure::Renderer) => {
                if views().get(view.label()).is_some_and(|e| {
                    e.status.incarnation == entry.incarnation
                        && e.status.phase != "restart_required"
                }) {
                    recover(view.clone(), entry.incarnation, None);
                }
            }
            Some(ProcessFailure::Browser) => {
                // Mark once before revoking the account, so duplicate native
                // notifications cannot advance the same incarnation again.
                let status = views()
                    .get_mut(view.label())
                    .and_then(|e| e.begin_browser_failure(entry.incarnation));
                if let Some(status) = status {
                    crate::login::prepare_webview_recovery(view.app_handle(), view.label());
                    publish(view.app_handle(), &status);
                }
            }
            None => {}
        }
    }
    fn flush_listener(app: &tauri::AppHandle, label: &str, id: u64) {
        let status = views()
            .get_mut(label)
            .filter(|e| e.status.incarnation == id)
            .and_then(|e| e.flush_listener(READY.load(Ordering::SeqCst)));
        if let Some(status) = status {
            if let Some(failure) = status.listener_error {
                log::error!(
                    "webview recovery listener unavailable stage={:?} hresult={:?}",
                    failure.stage,
                    failure.hresult
                );
            }
            publish(app, &status);
        }
    }
    fn complete_listener(
        app: &tauri::AppHandle,
        label: &str,
        id: u64,
        ticket: u64,
        result: Result<(), ListenerError>,
    ) -> bool {
        let accepted = views()
            .get_mut(label)
            .filter(|e| e.status.incarnation == id)
            .is_some_and(|e| e.listener.complete(ticket, result));
        if accepted {
            flush_listener(app, label, id);
        }
        accepted
    }
    pub fn attach(
        view: &Webview,
        id: u64,
        revision: Option<u64>,
    ) -> Result<(), crate::dto::AppErrorDto> {
        if !is_current_instance(&view) || instance_id(view) != Some(id) {
            return Err(error("recovery.closed"));
        }
        let (ticket, status) = views()
            .get_mut(view.label())
            .and_then(|e| e.begin_listener(id, revision))
            .ok_or_else(|| error("recovery.stale_or_busy"))?;
        if let Some(status) = status {
            publish(view.app_handle(), &status);
        }
        let app = view.app_handle().clone();
        let failure_app = app.clone();
        let label = view.label().to_string();
        let failure_label = label.clone();
        let dispatched = view.with_webview(move |native| unsafe {
            if !app.get_webview(&label).is_some_and(|current| {
                is_current_instance(&current) && instance_id(&current) == Some(id)
            }) {
                return;
            }
            let core = match native.controller().CoreWebView2() {
                Ok(core) => core,
                Err(error) => {
                    complete_listener(
                        &app,
                        &label,
                        id,
                        ticket,
                        Err(ListenerError {
                            stage: ListenerStage::Controller,
                            hresult: Some(error.code().0),
                        }),
                    );
                    return;
                }
            };
            let event_app = app.clone();
            let event_label = label.clone();
            let handler = ProcessFailedEventHandler::create(Box::new(move |_, args| {
                if !views()
                    .get(&event_label)
                    .is_some_and(|e| e.status.incarnation == id)
                {
                    return Ok(());
                }
                let Some(source) = event_app.get_webview(&event_label) else {
                    return Ok(());
                };
                let Some(args) = args else {
                    return Ok(());
                };
                let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND(0);
                args.ProcessFailedKind(&mut kind)?;
                if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED {
                    record_failure(&source, id, ProcessFailure::Renderer);
                } else if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED {
                    record_failure(&source, id, ProcessFailure::Browser);
                } else {
                    log::warn!("webview process event kind={}", kind.0);
                }
                Ok(())
            }));
            let mut token = 0;
            match core.add_ProcessFailed(&handler, &mut token) {
                Ok(()) => {
                    if complete_listener(&app, &label, id, ticket, Ok(())) {
                        TOKENS.with(|t| {
                            t.borrow_mut().insert(id, Subscription { core, token });
                        });
                    } else {
                        let _ = core.remove_ProcessFailed(token);
                    }
                }
                Err(error) => {
                    complete_listener(
                        &app,
                        &label,
                        id,
                        ticket,
                        Err(ListenerError {
                            stage: ListenerStage::Subscribe,
                            hresult: Some(error.code().0),
                        }),
                    );
                }
            }
        });
        if dispatched.is_err() {
            // Tauri dispatch errors are not necessarily HRESULTs. Preserve the
            // typed stage without fabricating a code or exposing raw text.
            complete_listener(
                &failure_app,
                &failure_label,
                id,
                ticket,
                Err(ListenerError {
                    stage: ListenerStage::Dispatch,
                    hresult: None,
                }),
            );
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn backoff_is_bounded_and_window_expires() {
        let now = Instant::now();
        let mut b = Budget::default();
        for seconds in [1, 2, 4] {
            assert_eq!(b.failure(now), Some(Duration::from_secs(seconds)));
        }
        for _ in 0..100 {
            assert_eq!(b.failure(now), None);
        }
        assert!(b.crashes.len() <= LIMIT + 1);
        assert_eq!(b.failure(now + WINDOW), Some(Duration::from_secs(1)));
    }
    #[test]
    fn fault_and_runtime_replacements_reject_stale_retries() {
        let mut e = Entry {
            status: RecoveryStatus {
                label: "setting".into(),
                incarnation: 7,
                revision: 3,
                phase: "manual",
                attempt: 4,
                listener_error: None,
            },
            budget: Budget::default(),
            serial: 3,
            account: None,
            #[cfg(any(target_os = "windows", test))]
            listener: ListenerMachine::default(),
        };
        assert!(e.matches(7, 3, "manual"));
        assert!(!e.matches(6, 3, "manual"));
        assert!(!e.matches(7, 2, "manual"));
        e.serial = 4;
        e.status.revision = 4;
        assert!(!e.matches(7, 3, "manual"));
        e.status.phase = "retrying";
        assert!(!e.matches(7, 4, "manual"));
        assert!(e.matches(7, 4, "retrying"));
    }
    #[test]
    fn explicit_retry_resets_budget_without_disabling_future_supervision() {
        let now = Instant::now();
        let mut b = Budget::default();
        for _ in 0..4 {
            b.failure(now);
        }
        assert_eq!(b.failure(now), None);
        b.crashes.clear();
        assert_eq!(b.failure(now), Some(Duration::from_secs(1)));
        assert_eq!(b.failure(now), Some(Duration::from_secs(2)));
    }
    #[test]
    fn startup_pending_is_preserved_until_explicit_ready() {
        let ready = AtomicBool::new(false);
        let pending = AtomicBool::new(true);
        assert!(!take_when_ready(&ready, &pending));
        assert!(pending.load(Ordering::SeqCst));
        ready.store(true, Ordering::SeqCst);
        assert!(take_when_ready(&ready, &pending));
        assert!(!take_when_ready(&ready, &pending));
    }
    #[test]
    fn ready_and_termination_race_delivers_exactly_once() {
        use std::sync::atomic::AtomicUsize;
        for _ in 0..64 {
            let ready = AtomicBool::new(false);
            let pending = AtomicBool::new(false);
            let deliveries = AtomicUsize::new(0);
            std::thread::scope(|scope| {
                scope.spawn(|| {
                    ready.store(true, Ordering::SeqCst);
                    if take_when_ready(&ready, &pending) {
                        deliveries.fetch_add(1, Ordering::SeqCst);
                    }
                });
                scope.spawn(|| {
                    pending.store(true, Ordering::SeqCst);
                    if take_when_ready(&ready, &pending) {
                        deliveries.fetch_add(1, Ordering::SeqCst);
                    }
                });
            });
            assert_eq!(deliveries.load(Ordering::SeqCst), 1);
        }
    }
    #[test]
    fn windows_failures_before_setup_are_bounded_and_browser_has_priority() {
        let ready = AtomicBool::new(false);
        let failures = PendingProcessFailures::default();
        for _ in 0..100 {
            failures.record(ProcessFailure::Renderer);
            failures.record(ProcessFailure::Browser);
        }
        assert_eq!(failures.take_ready(&ready), None);
        assert_eq!(failures.0.load(Ordering::SeqCst), 3);
        ready.store(true, Ordering::SeqCst);
        assert_eq!(failures.take_ready(&ready), Some(ProcessFailure::Browser));
        assert_eq!(failures.take_ready(&ready), None);
        failures.record(ProcessFailure::Renderer);
        assert_eq!(failures.take_ready(&ready), Some(ProcessFailure::Renderer));
    }
    #[test]
    fn windows_ready_notification_race_preserves_renderer_and_browser() {
        use std::sync::atomic::AtomicUsize;
        for kind in [ProcessFailure::Renderer, ProcessFailure::Browser] {
            for _ in 0..32 {
                let ready = AtomicBool::new(false);
                let failures = PendingProcessFailures::default();
                let deliveries = AtomicUsize::new(0);
                std::thread::scope(|scope| {
                    scope.spawn(|| {
                        ready.store(true, Ordering::SeqCst);
                        if failures.take_ready(&ready).is_some() {
                            deliveries.fetch_add(1, Ordering::SeqCst);
                        }
                    });
                    scope.spawn(|| {
                        failures.record(kind);
                        if failures.take_ready(&ready).is_some() {
                            deliveries.fetch_add(1, Ordering::SeqCst);
                        }
                    });
                });
                assert_eq!(deliveries.load(Ordering::SeqCst), 1);
            }
        }
    }
    #[test]
    fn windows_repeated_browser_failure_and_old_incarnation_are_idempotent() {
        let mut entry = Entry {
            status: RecoveryStatus {
                label: "main".into(),
                incarnation: 9,
                revision: 2,
                phase: "retrying",
                attempt: 1,
                listener_error: None,
            },
            budget: Budget::default(),
            serial: 2,
            account: None,
            #[cfg(any(target_os = "windows", test))]
            listener: ListenerMachine::default(),
        };
        assert!(entry.begin_browser_failure(8).is_none());
        assert_eq!(entry.serial, 2);
        assert!(entry.begin_browser_failure(9).is_some());
        assert_eq!(entry.status.phase, "restart_required");
        assert_eq!(entry.serial, 3);
        for _ in 0..100 {
            assert!(entry.begin_browser_failure(9).is_none());
        }
        assert_eq!(entry.serial, 3);
    }
    fn listener_entry() -> Entry {
        Entry {
            status: RecoveryStatus {
                label: "main".into(),
                incarnation: 30,
                revision: 0,
                phase: "healthy",
                attempt: 0,
                listener_error: None,
            },
            budget: Budget::default(),
            serial: 0,
            account: None,
            listener: ListenerMachine::default(),
        }
    }
    #[test]
    fn each_registration_failure_is_retained_before_ready_and_can_be_reenabled() {
        for (stage, hresult) in [
            (ListenerStage::Dispatch, None),
            (ListenerStage::Controller, Some(-2147467259)),
            (ListenerStage::Subscribe, Some(-2147024891)),
        ] {
            let mut e = listener_entry();
            let (ticket, event) = e.begin_listener(30, None).unwrap();
            assert!(event.is_none());
            let failure = ListenerError { stage, hresult };
            assert!(e.listener.complete(ticket, Err(failure)));
            assert!(e.flush_listener(false).is_none());
            assert_eq!(e.status.phase, "healthy");
            let failed = e.flush_listener(true).unwrap();
            assert_eq!(failed.phase, "listener_failed");
            assert_eq!(failed.listener_error, Some(failure));
            assert!(e.flush_listener(true).is_none());
            let (retry, event) = e.begin_listener(30, Some(failed.revision)).unwrap();
            assert_eq!(event.unwrap().phase, "listener_retrying");
            assert!(e.listener.complete(retry, Ok(())));
            let enabled = e.flush_listener(true).unwrap();
            assert_eq!(enabled.phase, "healthy");
            assert!(enabled.listener_error.is_none());
            assert_eq!(
                e.serial, 0,
                "listener retry must never create a reload task"
            );
            assert!(e.account.is_none());
        }
    }
    #[test]
    fn listener_retries_are_exclusive_and_old_completion_cannot_clear_new_fault() {
        let mut e = listener_entry();
        let (ticket, _) = e.begin_listener(30, None).unwrap();
        assert!(e.begin_listener(30, None).is_none());
        assert!(e.listener.complete(
            ticket,
            Err(ListenerError {
                stage: ListenerStage::Subscribe,
                hresult: Some(-1)
            })
        ));
        let failed = e.flush_listener(true).unwrap();
        assert!(e.begin_listener(29, Some(failed.revision)).is_none());
        assert!(e.begin_listener(30, Some(failed.revision - 1)).is_none());
        let (retry, _) = e.begin_listener(30, Some(failed.revision)).unwrap();
        assert!(!e.listener.complete(ticket, Ok(())));
        assert!(e.begin_listener(30, Some(failed.revision)).is_none());
        e.serial += 1;
        e.status.revision += 1;
        e.status.phase = "retrying";
        let running_task = e.serial;
        assert!(e.listener.complete(retry, Ok(())));
        let current = e.flush_listener(true).unwrap();
        assert_eq!(current.phase, "retrying");
        assert_eq!(
            e.serial, running_task,
            "monitor completion must not cancel the active reload"
        );
        assert!(e.status.revision > e.serial);
        assert!(!e.listener.complete(
            retry,
            Err(ListenerError {
                stage: ListenerStage::Dispatch,
                hresult: None
            })
        ));
    }
    #[test]
    fn listener_completion_preserves_new_browser_failure_and_diagnostic_roundtrips() {
        let mut e = listener_entry();
        let (ticket, _) = e.begin_listener(30, None).unwrap();
        assert!(e.begin_browser_failure(30).is_some());
        let serial = e.serial;
        let failure = ListenerError {
            stage: ListenerStage::Controller,
            hresult: Some(i32::MIN),
        };
        assert!(e.listener.complete(ticket, Err(failure)));
        let current = e.flush_listener(true).unwrap();
        assert_eq!(current.phase, "restart_required");
        assert_eq!(e.serial, serial);
        let json = serde_json::to_value(current).unwrap();
        assert_eq!(
            json["listener_error"],
            serde_json::json!({"stage":"controller","hresult":i32::MIN})
        );
        assert!(!json.to_string().contains("token"));
    }
    #[test]
    fn page_reload_does_not_hide_a_failed_monitor_or_cancel_its_reenable() {
        let mut e = listener_entry();
        let (ticket, _) = e.begin_listener(30, None).unwrap();
        assert!(e.listener.complete(
            ticket,
            Err(ListenerError {
                stage: ListenerStage::Controller,
                hresult: Some(-1)
            })
        ));
        let failed = e.flush_listener(true).unwrap();
        let (retry, _) = e.begin_listener(30, Some(failed.revision)).unwrap();
        e.serial += 1;
        e.status.revision += 1;
        e.status.phase = "retrying";
        e.finish_recovery_phase("reloaded");
        assert_eq!(e.status.phase, "listener_failed");
        assert!(e.status.listener_error.is_some());
        assert!(e.listener.complete(retry, Ok(())));
        let enabled = e.flush_listener(true).unwrap();
        assert_eq!(enabled.phase, "healthy");
        assert!(enabled.listener_error.is_none());
        assert_eq!(e.serial, 1);
    }
}

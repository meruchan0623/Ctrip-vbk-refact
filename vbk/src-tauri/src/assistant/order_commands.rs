//! Local order/package windows. No renderer-supplied card id, URL or bearer.
use super::service::orders::{BoundPlan, OrderBook, OrderScope, OrderSummary, PackageDetail};
use super::{require, CmdResult, HostService};
use crate::{
    adapter,
    dto::{AccountContextDto, AppErrorDto},
    state::HostState,
    views, windows,
};
use contracts::{codes, AccountContext, AppError, ViewContext};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Manager, State, Window};

pub const DETAIL_PREFIX: &str = views::PACKAGE_DETAIL_PREFIX;
const MAX_WINDOWS: usize = 8;
struct Binding {
    detail_handle: String,
    plan: BoundPlan,
    view: ViewContext,
}
struct Orders {
    book: Arc<OrderBook<super::http::ReqwestExecutor, super::KeyringVault>>,
    bindings: Mutex<HashMap<String, Arc<Binding>>>,
    opening: tokio::sync::Mutex<()>,
}
pub fn init(app: &AppHandle, service: Arc<HostService>) {
    app.manage(Orders {
        book: Arc::new(OrderBook::new(service)),
        bindings: Mutex::default(),
        opening: tokio::sync::Mutex::new(()),
    });
}
use super::public_error::to_dto as public_error;
fn instance_label(_detail_handle: &str, existing: Option<&str>) -> String {
    existing
        .map(str::to_string)
        .unwrap_or_else(|| format!("{DETAIL_PREFIX}{}", uuid::Uuid::new_v4()))
}
pub(super) fn invalid() -> AppError {
    AppError::new(
        codes::HOST_VIEW_UNAUTHORIZED,
        "package query or local view is no longer current",
    )
}
pub(super) fn capture(
    state: &HostState,
    window: &Window,
    command: &str,
) -> Result<ViewContext, AppError> {
    // Role ACL plus the contract handshake (I-03) first, exactly like every
    // other module's guard; then the generation-bound context for the reply.
    state.authorize(window.label(), command)?;
    state.lock().views.authorize(window.label(), command)
}
pub(super) fn current(app: &AppHandle, view: &ViewContext) -> Result<(), AppError> {
    if app.get_webview_window(&view.webview_label).is_none()
        || app
            .state::<HostState>()
            .lock()
            .views
            .current(&view.webview_label)
            .as_ref()
            != Some(view)
    {
        return Err(invalid());
    }
    Ok(())
}
pub(super) async fn validate(
    app: &AppHandle,
    view: &ViewContext,
    scope: &OrderScope,
) -> Result<(), AppError> {
    current(app, view)?;
    if !owner_is_current(&scope.account, crate::login::active_context(app).as_ref()) {
        return Err(invalid());
    }
    adapter::validate_assistant_scope(
        app,
        &scope.account,
        &scope.gid,
        &scope.order_id,
        &scope.context_revision,
    )
    .await?;
    current(app, view)?;
    if !owner_is_current(&scope.account, crate::login::active_context(app).as_ref()) {
        return Err(invalid());
    }
    Ok(())
}
#[tauri::command(rename_all = "snake_case")]
#[allow(clippy::too_many_arguments)] // Tauri-injected handles plus the existing IPC contract.
pub async fn assistant_order_summary(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
    account: AccountContextDto,
    gid: String,
    order_id: String,
    context_revision: String,
    session_epoch: u64,
) -> CmdResult<OrderSummary> {
    let view = capture(&state, &window, "assistant_order_summary").map_err(public_error)?;
    let scope = OrderScope {
        account: account.into(),
        gid,
        order_id,
        context_revision,
    };
    let book = app.state::<Orders>().book.clone();
    let guard = || validate(&app, &view, &scope);
    let result = book
        .summary(scope.clone(), session_epoch, &guard)
        .await
        .map_err(public_error)?;
    validate(&app, &view, &scope).await.map_err(public_error)?;
    let status = require(&app)?.status();
    if !status.logged_in || status.session_epoch != session_epoch {
        return Err(invalid().into());
    }
    Ok(result)
}
fn forget(app: &AppHandle, label: &str) {
    if let Some(orders) = app.try_state::<Orders>() {
        orders
            .bindings
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(label);
    }
    app.state::<HostState>().lock().views.unregister(label);
}
fn forget_if_current(app: &AppHandle, label: &str, view: &ViewContext) {
    if let Some(orders) = app.try_state::<Orders>() {
        let mut bindings = orders.bindings.lock().unwrap_or_else(|e| e.into_inner());
        if bindings.get(label).is_some_and(|b| b.view == *view) {
            bindings.remove(label);
        }
    }
    app.state::<HostState>()
        .lock()
        .views
        .unregister_if_current(view);
}
pub(super) fn owner_is_current(owner: &AccountContext, active: Option<&AccountContext>) -> bool {
    active == Some(owner)
}
fn invalidate_if(app: &AppHandle, stale: impl Fn(&BoundPlan) -> bool) {
    use tauri::Emitter;
    let Some(orders) = app.try_state::<Orders>() else {
        return;
    };
    let labels: Vec<_> = {
        let mut bindings = orders.bindings.lock().unwrap_or_else(|e| e.into_inner());
        let labels: Vec<_> = bindings
            .iter()
            .filter(|(_, b)| stale(&b.plan))
            .map(|(label, _)| label.clone())
            .collect();
        for label in &labels {
            bindings.remove(label);
        }
        labels
    };
    for label in labels {
        let _ = app.emit_to(label, "assistant://package-detail-invalidated", ());
    }
}
/// ACCOUNT_CHANGED also fires for unread/remark/profile refresh. Consult host
/// active-owner authority, not the event's volatile metadata or an old UI copy.
/// The only caller for this event is login::emit_changed after snapshot released
/// both its HostState and LoginState locks.
pub fn on_account_snapshot(app: &AppHandle) {
    let active = crate::login::active_context(app);
    invalidate_if(app, |plan| {
        !owner_is_current(&plan.scope.account, active.as_ref())
    });
}
pub fn on_tsim_status(app: &AppHandle, status: &super::service::TsimStatus) {
    // Called from the service observer while its inner lock is held. This path
    // never re-enters Service, LoginState or HostState.
    invalidate_if(app, |plan| {
        !status.logged_in || status.session_epoch != plan.session_epoch
    });
}
/// Invalidate only windows whose complete conversation binding changed.
/// Keep their minimal view role so a custom-chrome close still works.
pub fn on_conversation_change(
    app: &AppHandle,
    account: &AccountContext,
    gid: &str,
    revision: Option<&str>,
) {
    invalidate_if(app, |plan| {
        plan.scope.account == *account
            && plan.scope.gid == gid
            && revision != Some(plan.scope.context_revision.as_str())
    });
}
#[tauri::command(rename_all = "snake_case")]
pub async fn assistant_package_detail_open(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
    account: AccountContextDto,
    gid: String,
    query_handle: String,
    detail_handle: String,
) -> CmdResult<()> {
    let view = capture(&state, &window, "assistant_package_detail_open").map_err(public_error)?;
    let orders = app.state::<Orders>();
    let _serial = orders.opening.lock().await;
    let account: AccountContext = account.into();
    let plan = orders
        .book
        .resolve(&account, &gid, &query_handle, &detail_handle)
        .map_err(public_error)?;
    validate(&app, &view, &plan.scope)
        .await
        .map_err(public_error)?;
    let scope = plan.scope.clone();
    let expected_epoch = plan.session_epoch;
    let existing_label = orders
        .bindings
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .find(|(_, binding)| binding.detail_handle == detail_handle)
        .map(|(label, _)| label.clone());
    let label = instance_label(&detail_handle, existing_label.as_deref());
    let stale: Vec<_> = orders
        .bindings
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .keys()
        .filter(|l| app.get_webview_window(l).is_none())
        .cloned()
        .collect();
    for stale in stale {
        forget(&app, &stale);
    }
    let registered = orders
        .bindings
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains_key(&label);
    if !registered {
        if app
            .webview_windows()
            .keys()
            .filter(|l| l.starts_with(DETAIL_PREFIX))
            .count()
            >= MAX_WINDOWS
        {
            return Err(AppError::new(
                core_assistant::session::codes::INVALID_INPUT,
                "close an existing package detail window first",
            )
            .into());
        }
        let detail_view = state.lock().views.register(&label);
        orders
            .bindings
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                label.clone(),
                Arc::new(Binding {
                    detail_handle: detail_handle.clone(),
                    plan,
                    view: detail_view,
                }),
            );
    }
    if windows::open_singleton(
        &app,
        &label,
        "TSim 套餐详情",
        "apps/package-detail/index.html",
        1000.0,
        760.0,
    )
    .await
    .is_err()
    {
        forget(&app, &label);
        return Err(AppError::new(
            codes::ADAPTER_FAILED,
            "could not open local package detail window",
        )
        .into());
    }
    if !registered {
        if let Some(detail) = app.get_webview_window(&label) {
            let closed_app = app.clone();
            let closed_label = label.clone();
            let closed_view = state
                .lock()
                .views
                .current(&label)
                .ok_or_else(|| public_error(invalid()))?;
            detail.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    forget_if_current(&closed_app, &closed_label, &closed_view);
                }
            });
        } else {
            forget(&app, &label);
            return Err(invalid().into());
        }
    }
    let final_guard = validate(&app, &view, &scope).await;
    let status = require(&app)?.status();
    if final_guard.is_err() || !status.logged_in || status.session_epoch != expected_epoch {
        forget(&app, &label);
        if let Some(detail) = app.get_webview_window(&label) {
            let _ = detail.close();
        }
        return Err(public_error(final_guard.err().unwrap_or_else(invalid)));
    }
    Ok(())
}
#[tauri::command(rename_all = "snake_case")]
pub async fn assistant_package_detail(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
) -> CmdResult<PackageDetail> {
    let view = capture(&state, &window, "assistant_package_detail").map_err(public_error)?;
    let orders = app.state::<Orders>();
    let binding = orders
        .bindings
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(window.label())
        .cloned()
        .ok_or_else(|| AppErrorDto::from(invalid()))?;
    if binding.view != view {
        return Err(invalid().into());
    }
    let book = orders.book.clone();
    let guard = || async {
        let still_bound = app
            .state::<Orders>()
            .bindings
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&view.webview_label)
            .is_some_and(|b| Arc::ptr_eq(b, &binding));
        if !still_bound {
            return Err(invalid());
        }
        validate(&app, &view, &binding.plan.scope).await
    };
    let result = book
        .detail(&binding.plan, &guard)
        .await
        .map_err(public_error)?;
    guard().await.map_err(public_error)?;
    // Do not turn a stale window request into a lookup under a new identity.
    let status = require(&app)?.status();
    if !status.logged_in || status.session_epoch != binding.plan.session_epoch {
        return Err(invalid().into());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalidated_detail_is_reopened_as_a_new_instance_and_valid_binding_focuses_original() {
        let handle = uuid::Uuid::new_v4().to_string();
        let first = instance_label(&handle, None);
        assert_eq!(instance_label(&handle, Some(&first)), first);
        let replacement = instance_label(&handle, None);
        assert_ne!(
            replacement, first,
            "a retired binding cannot reuse its invalidated page instance"
        );
    }
    #[test]
    fn upstream_order_and_profile_failure_details_never_escape_the_ipc_boundary() {
        let raw = "Bearer SYNTHETIC_TOKEN activation_code=SYNTHETIC_SECRET";
        let perform = core_assistant::parse_perform(200, &format!(r#"{{"code":0,"msg":"{raw}"}}"#))
            .unwrap_err();
        let profile = core_assistant::parse_profile_response(
            200,
            &format!(r#"{{"success":false,"message":"{raw}"}}"#),
        )
        .unwrap_err();
        for error in [perform, profile, AppError::new(raw, raw).with_detail(raw)] {
            let wire = serde_json::to_string(&public_error(error)).unwrap();
            assert!(
                !wire.contains("SYNTHETIC_TOKEN")
                    && !wire.contains("SYNTHETIC_SECRET")
                    && !wire.contains("activation_code"),
                "only fixed public errors cross IPC"
            );
        }
    }

    #[test]
    fn active_owner_policy_ignores_metadata_and_revokes_real_account_environment_generation_changes(
    ) {
        let owner = AccountContext::new(
            contracts::AccountId::new("synthetic-account"),
            contracts::Environment::named("synthetic-env"),
            3,
        );
        // A normal unread/remark/profile broadcast only changes these payload
        // fields. The production hook reads active_context, never this payload.
        for metadata in [
            serde_json::json!({"unread": 0, "remark": "a"}),
            serde_json::json!({"unread": 99, "remark": "b", "self_profile": {"name": "new name"}}),
        ] {
            assert!(metadata.is_object());
            assert!(owner_is_current(&owner, Some(&owner)));
        }
        let mut generation = owner.clone();
        generation.session_generation += 1;
        let mut environment = owner.clone();
        environment.environment = contracts::Environment::named("other-env");
        let mut account = owner.clone();
        account.account_id = contracts::AccountId::new("other-account");
        for active in [None, Some(&generation), Some(&environment), Some(&account)] {
            assert!(!owner_is_current(&owner, active));
        }
    }
}

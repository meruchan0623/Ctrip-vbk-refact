//! TSim 订单查询窗：按当前会话订单号打开 TSim 客服系统的 `/embed/operator` 查询页。
//!
//! 安全边界（远程页面无通用本机权限）：
//! * URL 只由宿主拼出：固定 `https://csagent.tsim.tech/embed/operator`，订单号复用
//!   `core_assistant::order::validate_order_id`（10/16 位纯数字），查询串经 `Url`
//!   编码；渲染进程不能传任意 URL。
//! * 窗口标签 `tsim-order-*` 不在 `views.rs` 与任何 capability 里，远程页面没有 IPC；
//!   顶层导航只允许 `https://csagent.tsim.tech`，`window.open` 一律拒绝。
//! * 不把宿主持有的 TSim Bearer 交给远程页（不写初始化脚本、查询串或 localStorage，
//!   见 docs/archive/desktop-baseline/dev/09-assistant.md §5.3）。宿主登录态只作为前置条件：
//!   必须已登录且与请求的 `session_epoch` 一致；窗口的 Web 数据按 TSim 身份隔离，
//!   身份变化或退出时关闭窗口。远程页内的 TSim 网页登录保存在该身份自己的 Profile 中。
use super::order_commands::{capture, invalid, validate};
use super::service::orders::OrderScope;
use super::{public_error::to_dto as public_error, require, CmdResult};
use crate::{dto::AccountContextDto, login::profiles, state::HostState, windows};
use contracts::{codes, AppError};
use std::{collections::HashMap, sync::Mutex};
use tauri::{
    webview::NewWindowResponse, AppHandle, Manager, State, Url, WebviewUrl, WebviewWindowBuilder,
    Window,
};

/// 远程查询窗的标签前缀。故意不放进 `views.rs`：那里登记的前缀都必须有 capability。
pub const TSIM_ORDER_PREFIX: &str = "tsim-order-";
/// 唯一允许的远程主机（TSim 客服前端）。
pub const OPERATOR_HOST: &str = "csagent.tsim.tech";
const OPERATOR_PATH: &str = "/embed/operator";
const OPERATOR_SOURCE: &str = "travel-merchant-companion";

/// 窗口标签 → 打开时绑定的 TSim `session_epoch`。
#[derive(Default)]
pub struct TsimOrderWindows(Mutex<HashMap<String, u64>>);

fn reject(message: &str) -> AppError {
    AppError::new(core_assistant::session::codes::INVALID_INPUT, message)
}

/// 由宿主拼出查询页地址；订单号必须是完整的 10/16 位纯数字。
pub fn operator_url(order_id: &str, request_id: &uuid::Uuid) -> Result<Url, AppError> {
    let order_id = core_assistant::order::validate_order_id(order_id)?;
    let mut url = Url::parse(&format!("https://{OPERATOR_HOST}{OPERATOR_PATH}"))
        .map_err(|_| reject("operator url"))?;
    url.query_pairs_mut()
        .append_pair("source", OPERATOR_SOURCE)
        .append_pair("identifier", order_id)
        .append_pair("identifierType", "order_number")
        .append_pair("requestId", &request_id.to_string());
    Ok(url)
}

/// 查询窗的顶层导航白名单：仅 TSim 客服前端的 https 默认端口，不带凭据；
/// `about:blank` 供页面初始化。`tauri:`、`ipc:`、`file:` 与其他域名一律拒绝。
pub fn allowed_navigation(url: &Url) -> bool {
    if url.scheme() == "about" {
        return url.path() == "blank";
    }
    url.scheme() == "https"
        && url.host_str() == Some(OPERATOR_HOST)
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
}

/// 按 TSim 身份隔离 Web 数据：同一身份复用其 TSim 网页登录，换身份不串数据。
/// 只含十六进制字符，可直接作为数据目录名。
pub fn profile_id(user: &str) -> String {
    let id = profiles::data_store_id(&format!("tsim-operator:{user}"));
    let hex: String = id.iter().map(|b| format!("{b:02x}")).collect();
    format!("tsim-{hex}")
}

pub fn window_label(profile: &str) -> String {
    format!("{TSIM_ORDER_PREFIX}{}", profile.trim_start_matches("tsim-"))
}

/// 身份退出或代次变化时关闭旧查询窗。由服务观察者在其内部锁下调用：
/// 这里只读本模块的表，销毁窗口放到异步任务里，不回调 Service。
pub fn on_tsim_status(app: &AppHandle, status: &super::service::TsimStatus) {
    let Some(windows) = app.try_state::<TsimOrderWindows>() else {
        return;
    };
    let stale: Vec<String> = {
        let mut map = windows.0.lock().unwrap_or_else(|e| e.into_inner());
        let stale: Vec<String> = map
            .iter()
            .filter(|(_, epoch)| !status.logged_in || **epoch != status.session_epoch)
            .map(|(label, _)| label.clone())
            .collect();
        for label in &stale {
            map.remove(label);
        }
        stale
    };
    if stale.is_empty() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        for label in stale {
            profiles::destroy_window(&app, &label);
        }
    });
}

#[tauri::command(rename_all = "snake_case")]
#[allow(clippy::too_many_arguments)]
pub async fn assistant_tsim_order_open(
    app: AppHandle,
    window: Window,
    state: State<'_, HostState>,
    account: AccountContextDto,
    gid: String,
    order_id: String,
    context_revision: String,
    session_epoch: u64,
) -> CmdResult<()> {
    let view = capture(&state, &window, "assistant_tsim_order_open").map_err(public_error)?;
    // 先在本地拒绝非数字订单号，再去核对会话绑定。
    let request_id = uuid::Uuid::new_v4();
    let url = operator_url(&order_id, &request_id).map_err(public_error)?;
    let scope = OrderScope {
        account: account.into(),
        gid,
        order_id,
        context_revision,
    };
    validate(&app, &view, &scope).await.map_err(public_error)?;
    let status = require(&app)?.status();
    let user = match (&status.user, status.logged_in) {
        (Some(user), true) if status.session_epoch == session_epoch => user.clone(),
        (_, true) => return Err(public_error(invalid())),
        _ => {
            return Err(public_error(AppError::new(
                core_assistant::session::codes::NOT_LOGGED_IN,
                "tsim login required",
            )))
        }
    };
    let profile = profile_id(&user);
    let label = window_label(&profile);
    let registry = app.state::<TsimOrderWindows>();
    registry
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(label.clone(), session_epoch);
    let open_app = app.clone();
    let open_label = label.clone();
    let opened = windows::dispatch_secondary_window(move || {
        if let Some(existing) = open_app.get_webview_window(&open_label) {
            existing.navigate(url)?;
            existing.show()?;
            let _ = existing.unminimize();
            existing.set_focus()?;
            return Ok(());
        }
        let builder = WebviewWindowBuilder::new(&open_app, &open_label, WebviewUrl::External(url))
            .title("TSim 订单查询")
            .inner_size(1180.0, 820.0)
            .min_inner_size(640.0, 480.0)
            .on_navigation(allowed_navigation)
            .on_new_window(|_, _| NewWindowResponse::Deny);
        let builder = profiles::isolate!(builder, &open_app, &profile);
        let built = builder.build()?;
        let closed_app = open_app.clone();
        let closed_label = open_label.clone();
        built.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(registry) = closed_app.try_state::<TsimOrderWindows>() {
                    registry
                        .0
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .remove(&closed_label);
                }
            }
        });
        Ok(())
    })
    .await;
    if opened.is_err() {
        registry
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&label);
        return Err(public_error(AppError::new(
            codes::ADAPTER_FAILED,
            "could not open tsim order window",
        )));
    }
    // 打开期间身份若已变化，立即收回窗口，不留旧身份的查询页。
    let latest = require(&app)?.status();
    if !latest.logged_in
        || latest.session_epoch != session_epoch
        || latest.user.as_deref() != Some(user.as_str())
    {
        registry
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&label);
        profiles::destroy_window(&app, &label);
        return Err(public_error(invalid()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::views::Role;

    fn rid() -> uuid::Uuid {
        uuid::Uuid::parse_str("00000000-0000-4000-8000-000000000001").unwrap()
    }

    #[test]
    fn operator_url_is_fixed_origin_with_encoded_numeric_order() {
        let url = operator_url("1359049237105048", &rid()).unwrap();
        assert_eq!(
            url.as_str(),
            "https://csagent.tsim.tech/embed/operator?source=travel-merchant-companion&identifier=1359049237105048&identifierType=order_number&requestId=00000000-0000-4000-8000-000000000001"
        );
        assert!(allowed_navigation(&url));
        assert!(operator_url("3051228766", &rid()).is_ok());
    }

    #[test]
    fn operator_url_rejects_non_numeric_or_partial_order_ids() {
        for bad in [
            "",
            "12345",
            "135904923710504",
            "13590492371050481",
            "135904923710504a",
            "1359049237&x=1",
            "1359049237105048#",
            " 1359049237105048",
            "１３５９０４９２３７",
            "../../login?x=1",
        ] {
            let err = operator_url(bad, &rid()).unwrap_err();
            assert_eq!(
                err.code,
                core_assistant::session::codes::INVALID_INPUT,
                "{bad:?}"
            );
        }
    }

    #[test]
    fn navigation_is_limited_to_the_tsim_operator_origin() {
        for ok in [
            "https://csagent.tsim.tech/login",
            "https://csagent.tsim.tech/embed/operator?identifier=1",
            "about:blank",
        ] {
            assert!(allowed_navigation(&Url::parse(ok).unwrap()), "{ok}");
        }
        for bad in [
            "http://csagent.tsim.tech/login",
            "https://csagent.tsim.tech:8443/login",
            "https://user:pass@csagent.tsim.tech/",
            "https://csapi.tsim.tech/agent/profile",
            "https://csagent.tsim.tech.evil.example/",
            "https://evil.example/?csagent.tsim.tech",
            "tauri://localhost/apps/main/index.html",
            "ipc://localhost/assistant_tsim_status",
            "file:///etc/passwd",
            "about:srcdoc",
            "data:text/html,<script>1</script>",
        ] {
            assert!(!allowed_navigation(&Url::parse(bad).unwrap()), "{bad}");
        }
    }

    #[test]
    fn profile_and_label_are_per_identity_and_never_reach_a_local_role() {
        let a = profile_id("agent-a");
        assert_eq!(a, profile_id("agent-a"));
        assert_ne!(a, profile_id("agent-b"));
        assert!(a
            .strip_prefix("tsim-")
            .unwrap()
            .bytes()
            .all(|b| b.is_ascii_hexdigit()));
        let label = window_label(&a);
        assert!(label.starts_with(TSIM_ORDER_PREFIX));
        assert!(Role::for_label(&label).is_none());
        assert!(!label.starts_with(crate::views::ACCOUNT_WEBVIEW_PREFIX));
        assert!(!label.starts_with(crate::views::PACKAGE_DETAIL_PREFIX));
    }
}

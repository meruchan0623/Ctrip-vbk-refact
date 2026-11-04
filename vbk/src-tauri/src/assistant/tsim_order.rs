//! Scope-checked TSIM operator iframe grant. The local shell keeps the bearer
//! only in its overlay closure and posts it to this request's fixed TSIM origin.
//! The remote iframe receives no Tauri capability.
use super::order_commands::{capture, validate};
use super::service::orders::OrderScope;
use super::{public_error::to_dto as public_error, require, CmdResult};
use crate::{dto::AccountContextDto, state::HostState};
use contracts::AppError;
use serde::Serialize;
use tauri::{AppHandle, State, Url, Window};

pub const OPERATOR_HOST: &str = "csagent.tsim.tech";
const OPERATOR_PATH: &str = "/embed/operator";
const OPERATOR_SOURCE: &str = "travel-merchant-companion";

// Deliberately no Debug: this reply contains an ephemeral credential.
#[derive(Serialize)]
pub struct OperatorGrant {
    url: String,
    identifier: String,
    request_id: String,
    session_epoch: u64,
    access_token: String,
    session_ref: Option<String>,
}

fn reject(message: &str) -> AppError {
    AppError::new(core_assistant::session::codes::INVALID_INPUT, message)
}

pub fn operator_url(order_id: &str, request_id: &uuid::Uuid) -> Result<Url, AppError> {
    let order_id = core_assistant::order::validate_order_id(order_id)?;
    let mut url = Url::parse(&format!("https://{OPERATOR_HOST}{OPERATOR_PATH}"))
        .map_err(|_| reject("operator url"))?;
    url.query_pairs_mut()
        .append_pair("source", OPERATOR_SOURCE)
        .append_pair("session", "handoff")
        .append_pair("identifier", order_id)
        .append_pair("identifierType", "order_number")
        .append_pair("requestId", &request_id.to_string());
    Ok(url)
}

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
) -> CmdResult<OperatorGrant> {
    let view = capture(&state, &window, "assistant_tsim_order_open").map_err(public_error)?;
    let request_id = uuid::Uuid::new_v4();
    let url = operator_url(&order_id, &request_id).map_err(public_error)?;
    let scope = OrderScope {
        account: account.into(),
        gid,
        order_id,
        context_revision,
    };
    validate(&app, &view, &scope).await.map_err(public_error)?;
    let service = require(&app)?;
    // Recheck the live browser binding and server profile, not just the UI status.
    let session = service
        .operator_session(session_epoch)
        .await
        .map_err(public_error)?;
    validate(&app, &view, &scope).await.map_err(public_error)?;
    // Scope validation awaits adapter work. Check the session again afterwards.
    let session = service
        .operator_session_current(session_epoch, &session.access_token)
        .map_err(public_error)?;
    Ok(OperatorGrant {
        url: url.into(),
        identifier: scope.order_id,
        request_id: request_id.to_string(),
        session_epoch,
        access_token: session.access_token.expose().to_string(),
        session_ref: (!session.session_ref.is_empty()).then_some(session.session_ref),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rid() -> uuid::Uuid {
        uuid::Uuid::parse_str("00000000-0000-4000-8000-000000000001").unwrap()
    }

    #[test]
    fn operator_url_is_fixed_origin_with_encoded_numeric_order() {
        let url = operator_url("1359049237105048", &rid()).unwrap();
        assert_eq!(
            url.as_str(),
            "https://csagent.tsim.tech/embed/operator?source=travel-merchant-companion&session=handoff&identifier=1359049237105048&identifierType=order_number&requestId=00000000-0000-4000-8000-000000000001"
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
}

//! The assistant IPC boundary never exports upstream text, tokens or diagnostics.
use crate::dto::AppErrorDto;
use contracts::AppError;

pub fn to_dto(error: AppError) -> AppErrorDto {
    const PUBLIC_CODES: &[&str] = &[
        "assistant.tsim_unauthenticated",
        "assistant.tsim_bad_credentials",
        "assistant.session_cleared",
        "assistant.forbidden",
        "assistant.invalid_input",
        "assistant.service_unavailable",
        "assistant.http_error",
        "assistant.malformed_response",
        "assistant.upstream_failure",
        "assistant.translation_mismatch",
        "assistant.stale_binding",
        "assistant.package_not_found",
        "assistant.permission_denied",
        "net.offline",
        "net.timeout",
        "net.payload_too_large",
        "account.stale_generation",
        "account.unknown",
        "account.ticket_expired",
        "host.view_unauthorized",
        "adapter.not_ready",
        "adapter.failed",
        "store.io",
        "store.corrupt",
    ];
    let code = if PUBLIC_CODES.contains(&error.code.as_str()) {
        error.code
    } else {
        "assistant.service_unavailable".into()
    };
    AppErrorDto {
        code,
        message: "助手请求未完成。".into(),
        retryable: error.retryable,
        detail: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_parser_errors_from_every_external_assistant_route_export_only_fixed_public_fields() {
        let raw = "Bearer SYNTHETIC_TOKEN activation_code=SYNTHETIC_SECRET";
        let body = format!(r#"{{"success":false,"message":"{raw}"}}"#);
        let sent = core_assistant::TranslateParams {
            text: "synthetic draft".into(),
            target_lang: "en".into(),
            draft_request_id: "synthetic-id".into(),
            composer_content_version: "1".into(),
        };
        let errors = [
            core_assistant::parse_login_response(200, &body).unwrap_err(),
            core_assistant::parse_profile_response(200, &body).unwrap_err(),
            core_assistant::parse_refresh_response(200, &body).unwrap_err(),
            core_assistant::parse_logout_response(200, &body).unwrap_err(),
            core_assistant::parse_translate_response(200, &body, &sent).unwrap_err(),
            core_assistant::parse_perform(200, &format!(r#"{{"code":0,"msg":"{raw}"}}"#))
                .unwrap_err(),
        ];
        for error in errors {
            assert!(
                error
                    .detail
                    .as_deref()
                    .is_some_and(|d| d.contains("SYNTHETIC_SECRET")),
                "the fixture must exercise a real upstream-detail parser path"
            );
            let expected_code = error.code.clone();
            let retryable = error.retryable;
            let public = to_dto(error);
            assert_eq!(public.code, expected_code);
            assert_eq!(public.retryable, retryable);
            let wire = serde_json::to_string(&public).unwrap();
            assert!(
                !wire.contains("SYNTHETIC")
                    && !wire.contains("activation_code")
                    && !wire.contains("Bearer")
                    && !wire.contains("detail")
            );
        }
    }
    #[test]
    fn unknown_codes_messages_and_details_are_not_a_covert_export_channel() {
        let error = AppError::new("SYNTHETIC_TOKEN", "SYNTHETIC_PASSWORD")
            .with_detail("SYNTHETIC_SECRET")
            .retryable();
        let public = to_dto(error);
        assert_eq!(public.code, "assistant.service_unavailable");
        assert!(public.retryable);
        assert!(public.detail.is_none());
        assert!(!serde_json::to_string(&public)
            .unwrap()
            .contains("SYNTHETIC"));
        let timeout = to_dto(AppError::new("net.timeout", "SYNTHETIC_RAW").retryable());
        assert_eq!(timeout.code, "net.timeout");
        assert!(timeout.retryable);
    }
}

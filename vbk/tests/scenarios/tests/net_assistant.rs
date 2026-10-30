//! Q12 — net / assistant: `validate_official_im_url` rejects look-alike
//! origins, userinfo, http, non-default ports and traversal; the translate
//! request has exactly six keys; a stale translation binding is rejected;
//! 403 is not a logout; offline never maps to `ticket_expired`
//! (06-net, 09-assistant, F12, F14).
#![allow(clippy::unwrap_used)]

mod common;

use common::*;
use contracts::codes;
use contracts::json::JsonValue;
use core_assistant::{
    accept_result, map_http_status, parse_envelope, parse_translate_response, translate_request,
    SecretString, TokenData, TranslationBinding, TsimSession,
};
use core_net::{
    classify_soa, net_codes, report_outcome, validate_official_im_url, NetEvent, NetStatus,
    NetStatusMachine, SoaOutcome, UrlPolicy,
};

#[test]
fn official_im_url_policy_rejects_every_look_alike() {
    let policy = UrlPolicy::default();
    let bad = [
        "https://imvendor.ctrip.com.evil.com/main",
        "https://evil.com/?x=imvendor.ctrip.com",
        "https://evil.com/imvendor.ctrip.com/main",
        "https://user@imvendor.ctrip.com/main",
        "https://imvendor.ctrip.com@evil.com/main",
        "https://user:pw@imvendor.ctrip.com/main",
        "http://imvendor.ctrip.com/main",
        "HTTP://imvendor.ctrip.com/main",
        "https://imvendor.ctrip.com:8443/main",
        "https://imvendor.ctrip.com:443x/main",
        "https://imvendor.ctrip.com/main/../admin",
        "https://imvendor.ctrip.com/./main",
        "https://imvendor.ctrip.com//main",
        "https://imvendor.ctrip.com/main%2F..%2Fx",
        "https://imvendor.ctrip.com/%6Dain",
        "https://imvendor.ctrip.com/MAIN",
        "https://imvendor.ctrip.com/main/",
        "https://imvendor.ctrip.com\\@evil.com/main",
        "https://imvendor.ctrip.com/main?x=1\n",
        "https://imvendor.ctrip.com /main",
        "https://imvendor.ctrip.com\u{200b}/main",
        "https://xn--imvendor-ctrip.com/main",
        "https://imvendor.ctrip.com./main",
        "https://[::1]/main",
        "https://127.0.0.1/main",
        "https://imvendor.ctrip.com",
        "javascript:alert(1)",
        "//imvendor.ctrip.com/main",
        "https:///main",
        "",
    ];
    for url in bad {
        let r = validate_official_im_url(url, &policy);
        assert!(r.is_err(), "must reject {url:?}");
        assert!(r.unwrap_err().is(net_codes::NET_URL_REJECTED));
    }
    let good = validate_official_im_url(
        "https://imvendor.ctrip.com:443/main?initChat=2&targetGid=g1",
        &policy,
    )
    .unwrap();
    assert_eq!(good.host, "imvendor.ctrip.com");
    assert_eq!(good.target_gid.as_deref(), Some("g1"));
    // The raw URL is kept verbatim: the client never rebuilds a lookalike.
    assert_eq!(
        good.raw,
        "https://imvendor.ctrip.com:443/main?initChat=2&targetGid=g1"
    );
    // A narrower policy wins over the default.
    let only_vbk = UrlPolicy {
        allowed_hosts: vec!["vbooking.ctrip.com".into()],
        allowed_paths: vec!["/vbk/im/main".into()],
    };
    assert!(validate_official_im_url("https://imvendor.ctrip.com/main", &only_vbk).is_err());
    assert!(validate_official_im_url("https://vbooking.ctrip.com/vbk/im/main", &only_vbk).is_ok());
}

fn session() -> TsimSession {
    TsimSession::from_token(
        TokenData {
            access_token: SecretString::new("PLACEHOLDER-TOKEN"),
            token_type: "bearer".into(),
            session_ref: "s".into(),
            expires_at_ms: None,
        },
        0,
        1,
    )
}

#[test]
fn translate_request_has_exactly_six_keys_and_echo_is_verified() {
    let s = session();
    let (req, params) = translate_request(&s, "你好", "en", "draft-1", "v7").unwrap();
    let core_assistant::Body::Json(json) = &req.body else {
        panic!("json body")
    };
    let doc = JsonValue::parse(json).unwrap();
    let obj = doc.as_object().unwrap();
    assert_eq!(obj.len(), 6);
    let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
    keys.sort_unstable();
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
        doc.get("source_lang").and_then(JsonValue::as_str),
        Some("zh")
    );
    assert_eq!(
        doc.get("purpose").and_then(JsonValue::as_str),
        Some("outbound")
    );
    // No account / cookie / gid leaks into the body or the debug output.
    assert!(!json.contains("acc-"));
    assert!(!json.contains("PLACEHOLDER-TOKEN"));
    assert!(!format!("{req:?}").contains("PLACEHOLDER-TOKEN"));
    // Echo mismatch is rejected even with a plausible translation.
    let wrong = r#"{"success":true,"data":{"translated_text":"Hello","draft_request_id":"draft-2","composer_content_version":"v7"}}"#;
    assert!(parse_translate_response(200, wrong, &params)
        .unwrap_err()
        .is(core_assistant::codes::TRANSLATION_MISMATCH));
    let ok = r#"{"success":true,"data":{"translated_text":"Hello","draft_request_id":"draft-1","composer_content_version":"v7"}}"#;
    assert_eq!(parse_translate_response(200, ok, &params).unwrap(), "Hello");
}

#[test]
fn stale_translation_binding_is_rejected_after_draft_edit_or_relogin() {
    let requested = TranslationBinding {
        account: acc(3),
        gid: GID.into(),
        draft_version: 5,
    };
    // Draft edited while the request was in flight.
    let now = TranslationBinding {
        draft_version: 6,
        ..requested.clone()
    };
    assert!(accept_result(&requested, &now)
        .unwrap_err()
        .is(core_assistant::codes::STALE_BINDING));
    // Switched conversation.
    let now = TranslationBinding {
        gid: GID2.into(),
        ..requested.clone()
    };
    assert!(accept_result(&requested, &now)
        .unwrap_err()
        .is(core_assistant::codes::STALE_BINDING));
    // Re-login (new generation).
    let now = TranslationBinding {
        account: acc(4),
        ..requested.clone()
    };
    assert!(accept_result(&requested, &now)
        .unwrap_err()
        .is(codes::ACCOUNT_STALE_GENERATION));
    assert!(accept_result(&requested, &requested).is_ok());
}

#[test]
fn http_403_is_forbidden_not_logout_and_429_5xx_are_not_send_failures() {
    let e = map_http_status(403).unwrap();
    assert!(!e.clears_session);
    assert!(e.error.is(core_assistant::codes::FORBIDDEN));
    for s in [401, 423] {
        assert!(map_http_status(s).unwrap().clears_session);
    }
    for s in [429, 500, 502, 503] {
        let e = map_http_status(s).unwrap();
        assert!(e.error.is(core_assistant::codes::SERVICE_UNAVAILABLE));
        assert!(!e.clears_session);
        assert!(!e.error.is(codes::IM_SEND_UNKNOWN));
    }
    // A 403 body that *claims* success still is forbidden.
    let e = parse_envelope(403, r#"{"success":true,"data":{}}"#).unwrap_err();
    assert!(e.is(core_assistant::codes::FORBIDDEN));
    // Session stays usable after a 403.
    let s = session();
    assert!(s.is_active);
    assert!(translate_request(&s, "x", "en", "d", "v").is_ok());
}

#[test]
fn offline_never_maps_an_auth_looking_response_to_ticket_expired() {
    let auth_fail = r#"{"ResponseStatus":{"Ack":"Failure","Errors":[{"ErrorCode":"AccountsMobileRequestFilterException"}]}}"#;
    let outcome = classify_soa(200, auth_fail);
    assert_eq!(outcome, SoaOutcome::AuthInvalid);
    let mut m = NetStatusMachine::default();
    m.apply(NetEvent::SystemOffline);
    assert_eq!(m.status(), NetStatus::Offline);
    let e = report_outcome(m.status(), &outcome).unwrap();
    assert!(e.is(codes::NET_OFFLINE));
    assert!(!e.is(codes::ACCOUNT_TICKET_EXPIRED));
    // Captive-portal style HTML while offline: also net.offline.
    let e = report_outcome(NetStatus::Offline, &classify_soa(200, "<html>login</html>")).unwrap();
    assert!(e.is(codes::NET_OFFLINE));
    // Online hint alone is Degraded; the auth diagnosis then counts.
    m.apply(NetEvent::SystemOnline);
    assert_eq!(m.status(), NetStatus::Degraded);
    assert!(report_outcome(m.status(), &outcome)
        .unwrap()
        .is(codes::ACCOUNT_TICKET_EXPIRED));
    m.apply(NetEvent::ProbeOk);
    assert!(report_outcome(m.status(), &outcome)
        .unwrap()
        .is(codes::ACCOUNT_TICKET_EXPIRED));
    // Other business failures never become ticket_expired either.
    let biz = classify_soa(
        200,
        r#"{"ResponseStatus":{"Ack":"Failure","Errors":[{"ErrorCode":"Other"}]}}"#,
    );
    assert!(report_outcome(NetStatus::Online, &biz)
        .unwrap()
        .is(net_codes::NET_BUSINESS_FAILURE));
    // A write timeout is unknown, never a resend authorisation.
    let e = core_net::classify_write_timeout(core_net::SideEffect::Write);
    assert!(e.is(codes::IM_SEND_UNKNOWN));
    assert!(!e.retryable);
}

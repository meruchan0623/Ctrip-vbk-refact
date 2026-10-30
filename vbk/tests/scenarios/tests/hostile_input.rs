//! Q13 — panic paths reachable from untrusted input: JSON parser, DTO-like
//! strings, time arithmetic at the i64/u64 limits, sequence numbers at
//! u64::MAX, hostile persisted documents. Every function here must return
//! an error or a degraded value, never panic (debug assertions are on in
//! `cargo test`, so arithmetic overflow is a panic too).
#![allow(clippy::unwrap_used)]

mod common;

use common::*;
use contracts::json::JsonValue;
use contracts::{
    ClockQuality, ClockReading, ConversationStatus, MessageSource, RoundEvent, SendDisposition,
    SenderRole, SnoozeMinutes, WaitingRoundRef,
};
use core_account::AccountRegistry;
use core_assistant::{
    base64url_decode, jwt_exp_ms, parse_iso8601_ms, parse_login_response, parse_perform,
    parse_profile_response, parse_refresh_response, recognize_identifiers, suggest_language,
    SecretString, TokenData, TsimSession,
};
use core_im::{first_t1_deadline, Fact, FactEnvelope, ImCore, Round, StreamId};
use core_net::{
    classify_biz_status, classify_nephele, classify_response_error_code, classify_soa,
    parse_https_url, parse_soa_timestamp, validate_official_im_url, ClockService, UrlPolicy,
};
use core_notify::{NotifyCore, Now};
use core_store::{FileStore, Namespace, ReminderStateRepo, SendIntentRepo, Store};

/// Random JSON-ish text over a token alphabet plus random unicode.
fn hostile_text(rng: &mut Lcg, max_len: usize) -> String {
    const TOKENS: [&str; 30] = [
        "{",
        "}",
        "[",
        "]",
        ":",
        ",",
        "\"",
        "\\",
        "\\u",
        "\\ud800",
        "\\udc00",
        "\\ud83d\\ude00",
        "null",
        "true",
        "false",
        "-",
        "0",
        "1",
        "9",
        ".",
        "e",
        "E",
        "+",
        "1e999",
        " ",
        "\n",
        "\t",
        "\u{0}",
        "\u{1f600}",
        "中",
    ];
    let len = rng.below(max_len as u64) as usize;
    let mut s = String::new();
    for _ in 0..len {
        if rng.below(10) == 0 {
            if let Some(c) = char::from_u32(rng.below(0x11_0000) as u32) {
                s.push(c);
            }
        } else {
            s.push_str(TOKENS[rng.below(TOKENS.len() as u64) as usize]);
        }
    }
    s
}

#[test]
fn json_parser_survives_random_and_crafted_input() {
    let mut rng = Lcg::new(0x5eed);
    for _ in 0..4_000 {
        let s = hostile_text(&mut rng, 64);
        if let Ok(v) = JsonValue::parse(&s) {
            let again = JsonValue::parse(&v.to_json()).unwrap();
            assert_eq!(again, v, "round trip of {s:?}");
            let _ = v.as_i64();
            let _ = v.as_f64();
            let _ = v.path("a.b.c");
        }
    }
    let crafted = [
        "[".repeat(100_000),
        "{\"a\":".repeat(100_000),
        "[".repeat(127) + &"]".repeat(127),
        "[".repeat(128) + &"]".repeat(128),
        "[".repeat(129) + &"]".repeat(129),
        "\"\\ud800\"".into(),
        "\"\\udc00\"".into(),
        "\"\\ud83d\\u0041\"".into(),
        "\"\\ud83d\"".into(),
        "\"\\u\"".into(),
        "\"\\u12\"".into(),
        "\"\\u+123\"".into(),
        "\"\\u-123\"".into(),
        "\"\\uzzzz\"".into(),
        "\"\\u中文中文\"".into(),
        "\"\\".into(),
        "\"".into(),
        "\"\u{0}\"".into(),
        "\"\u{7f}\"".into(),
        "-".into(),
        "-0".into(),
        "1.".into(),
        ".1".into(),
        "1e".into(),
        "1e+".into(),
        "1E-".into(),
        "1e999".into(),
        "-1e999".into(),
        "1e-999".into(),
        "0".repeat(10_000),
        "9".repeat(10_000),
        "1".to_string() + &"0".repeat(400),
        "99999999999999999999".into(),
        "18446744073709551616".into(),
        "-9223372036854775809".into(),
        "9223372036854775807".into(),
        "nul".into(),
        "nulll".into(),
        "truefalse".into(),
        "{\"a\":1,}".into(),
        "{\"a\" 1}".into(),
        "{1:2}".into(),
        "[1 2]".into(),
        "{}{}".into(),
        "\u{feff}{}".into(),
        String::new(),
        " ".into(),
        "\u{1f600}".into(),
    ];
    for s in crafted.iter() {
        let r = JsonValue::parse(s);
        if let Ok(v) = r {
            let _ = v.as_i64();
            let _ = JsonValue::parse(&v.to_json()).unwrap();
        }
    }
    // Depth limit: 128 nested arrays is the maximum accepted.
    assert!(JsonValue::parse(&("[".repeat(128) + &"]".repeat(128))).is_ok());
    assert!(JsonValue::parse(&("[".repeat(129) + &"]".repeat(129))).is_err());
    // Big integers keep their text and saturate rather than wrap.
    let v = JsonValue::parse("99999999999999999999").unwrap();
    assert_eq!(v.to_json(), "99999999999999999999");
    let huge = JsonValue::parse("1e999").unwrap();
    assert_eq!(huge.as_i64(), None, "non-finite is not an integer");
    // Lone surrogates never reach a String.
    for s in ["\"\\ud800\"", "\"\\udc00\"", "\"\\ud83d\\u0041\""] {
        assert!(JsonValue::parse(s).is_err(), "{s}");
    }
}

#[test]
fn soa_and_nephele_classifiers_never_panic_on_hostile_bodies() {
    let mut rng = Lcg::new(7);
    let mut bodies: Vec<String> = (0..1_500).map(|_| hostile_text(&mut rng, 80)).collect();
    bodies.extend([
        r#"{"ResponseStatus":null}"#.into(),
        r#"{"ResponseStatus":[]}"#.into(),
        r#"{"ResponseStatus":{"Ack":null,"Errors":null}}"#.into(),
        r#"{"ResponseStatus":{"Ack":"Success","Errors":[null,1,"x",{"ErrorFields":[null,{"Message":1}]}]}}"#.into(),
        r#"{"ResponseStatus":{"Ack":"Success","Extension":[{"Value":null},1]}}"#.into(),
        r#"{"ResponseStatus":{"Ack":"Success"},"bizResponseStatus":{"resultCode":null}}"#.into(),
        r#"{"ResponseStatus":{"Ack":"Success"},"response":{"errorCode":1e300}}"#.into(),
        r#"{"ResponseStatus":{"Ack":"Success"},"response":{"errorCode":"0"}}"#.into(),
        r#"{"Code":1e999}"#.into(),
        r#"{"Code":2000,"Content":{"url":1,"file_name":null}}"#.into(),
        r#"{"Code":"2000","Content":{"url":"u","file_name":"f"}}"#.into(),
        "[".repeat(200),
    ]);
    for b in &bodies {
        for status in [0u16, 200, 206, 299, 302, 403, 500, u16::MAX] {
            let o = classify_soa(status, b);
            let _ = o.to_app_error();
            let _ = classify_biz_status(status, b).to_app_error();
            let _ = classify_response_error_code(status, b).to_app_error();
            let _ = classify_nephele(status, b).to_app_error();
        }
    }
    // `errorCode` beyond i64 is not "zero".
    assert!(!classify_response_error_code(
        200,
        r#"{"ResponseStatus":{"Ack":"Success"},"response":{"errorCode":1e300}}"#
    )
    .is_success());
    assert!(!classify_response_error_code(
        200,
        r#"{"ResponseStatus":{"Ack":"Success"},"response":{"errorCode":"0"}}"#
    )
    .is_success());
}

#[test]
fn soa_timestamp_and_url_parsers_never_panic() {
    let mut rng = Lcg::new(11);
    let mut inputs: Vec<String> = (0..2_000).map(|_| hostile_text(&mut rng, 40)).collect();
    inputs.extend([
        "/Date(中)/".into(),
        "/Date(1中)/".into(),
        "/Date(-)/".into(),
        "/Date(--1)/".into(),
        "/Date(1+中800)/".into(),
        "/Date(99999999999999999999+0800)/".into(),
        "/Date(1+08000)/".into(),
        "/Date(".into(),
        ")/".into(),
        "https://imvendor.ctrip.com/main?中=%E4%B8%AD&%zz=%4".into(),
        "https://imvendor.ctrip.com:/main".into(),
        "https://:443/main".into(),
        "https://imvendor.ctrip.com/main#中".into(),
        "https://中.ctrip.com/main".into(),
        "https://imvendor.ctrip.com/%".into(),
        "https://imvendor.ctrip.com/main?%".into(),
        "https://imvendor.ctrip.com/main?a=%E4%B8".into(),
        "https://".into(),
        "://".into(),
        "https://a".repeat(500),
    ]);
    for s in &inputs {
        let _ = parse_soa_timestamp(s);
        let _ = parse_https_url(s);
        let _ = validate_official_im_url(s, &UrlPolicy::default());
        let _ = core_net::validate_navigation_origin(s, &[core_net::VBOOKING_ORIGIN]);
        let _ = core_net::validate_order_id(s);
        let _ = core_net::order_detail_url(s);
    }
    assert_eq!(
        parse_soa_timestamp("/Date(99999999999999999999+0800)/"),
        None
    );
}

#[test]
fn iso8601_parser_never_panics_on_multibyte_input() {
    // Server `expires_at` is untrusted text; byte-offset slicing must not
    // land inside a multi-byte character.
    let crafted = [
        "2026-10-30T12:0é",
        "2026-10-30T12:00:0é",
        "2026-10-30T12:00:00+aéb",
        "2026-10-30T12:00:00+é:00",
        "2026-10-30T12:00:00.5é",
        "2026-10-30T12:00:00+0é",
        "éééé-10-30T12:00",
        "2026-é0-30T12:00",
        "2026-10-30T12:00:00Z中",
        "2026-10-30T12:00:00+00:0中",
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}",
    ];
    for s in crafted {
        let _ = parse_iso8601_ms(s);
    }
    let mut rng = Lcg::new(13);
    for _ in 0..3_000 {
        let s = hostile_text(&mut rng, 32);
        let _ = parse_iso8601_ms(&s);
    }
    assert_eq!(parse_iso8601_ms("2026-10-30T12:0é"), None);
    assert_eq!(
        parse_iso8601_ms("2026-10-30T12:00:00Z"),
        Some(1_793_361_600_000)
    );
}

#[test]
fn hostile_jwt_exp_does_not_overflow_session_arithmetic() {
    fn b64url(s: &str) -> String {
        const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let b = s.as_bytes();
        let mut out = String::new();
        for chunk in b.chunks(3) {
            let n = (chunk[0] as u32) << 16
                | (chunk.get(1).copied().unwrap_or(0) as u32) << 8
                | chunk.get(2).copied().unwrap_or(0) as u32;
            out.push(A[((n >> 18) & 63) as usize] as char);
            out.push(A[((n >> 12) & 63) as usize] as char);
            if chunk.len() > 1 {
                out.push(A[((n >> 6) & 63) as usize] as char);
            }
            if chunk.len() > 2 {
                out.push(A[(n & 63) as usize] as char);
            }
        }
        out
    }
    for exp in [
        "-9223372036854775",
        "9223372036854775",
        "-9223372036854775808",
        "9223372036854775807",
        "1e300",
        "-1e300",
        "0",
        "\"x\"",
        "null",
    ] {
        let token = format!(
            "{}.{}.sig",
            b64url("{}"),
            b64url(&format!("{{\"exp\":{exp}}}"))
        );
        let _ = jwt_exp_ms(&token);
        let s = TsimSession::from_token(
            TokenData {
                access_token: SecretString::new(token),
                token_type: "bearer".into(),
                session_ref: "s".into(),
                expires_at_ms: None,
            },
            i64::MAX,
            1,
        );
        for now in [i64::MIN, -1, 0, i64::MAX] {
            let _ = s.refresh_deadline_ms();
            let _ = s.refresh_due(now);
            let _ = s.is_expired(now);
        }
    }
    for exp_ms in [Some(i64::MIN), Some(i64::MIN + 1), Some(i64::MAX), None] {
        let s = TsimSession::from_token(
            TokenData {
                access_token: SecretString::new("opaque"),
                token_type: "bearer".into(),
                session_ref: "s".into(),
                expires_at_ms: exp_ms,
            },
            i64::MAX,
            1,
        );
        let _ = s.refresh_deadline_ms();
        let _ = s.refresh_due(i64::MIN);
    }
    for b in [
        "",
        "a",
        "a.",
        "a.b",
        "a..b",
        "a.%%.b",
        "a.中.b",
        "a.-_.b",
        "a.A.b",
        "a.AAAAA.b",
    ] {
        let _ = jwt_exp_ms(b);
        let _ = base64url_decode(b);
    }
}

#[test]
fn assistant_response_parsers_never_panic() {
    let mut rng = Lcg::new(17);
    let mut bodies: Vec<String> = (0..1_500).map(|_| hostile_text(&mut rng, 80)).collect();
    bodies.extend([
        r#"{"success":true,"data":{"access_token":"","session_ref":1}}"#.into(),
        r#"{"success":true,"data":{"access_token":"t","token_type":null,"session_ref":"s","expires_at":1}}"#.into(),
        r#"{"success":true,"data":{"id":1e300,"permissions":[1,null,"x"],"outbound_wait":"3"}}"#.into(),
        r#"{"success":true,"data":{"id":null}}"#.into(),
        r#"{"success":1}"#.into(),
        r#"{"success":false,"message":1}"#.into(),
        r#"{"code":1e300,"result":{"query_id":1e300}}"#.into(),
        r#"{"code":1,"result":{"query_id":-0}}"#.into(),
        r#"{"code":1,"result":{"query_id":"a&b"}}"#.into(),
    ]);
    for b in &bodies {
        for status in [200u16, 401, 403, 500] {
            let _ = parse_login_response(status, b);
            let _ = parse_refresh_response(status, b);
            let _ = parse_profile_response(status, b);
            let _ = parse_perform(status, b);
            let _ = core_assistant::parse_dataplan_list(status, b);
            let _ = core_assistant::parse_detail(status, b);
            let _ = core_assistant::parse_supplement(status, b);
        }
        let _ = recognize_identifiers(b);
        let _ = suggest_language(b);
        let _ = core_im::mask_label(b);
        let _ = core_notify::mask_label(b);
        let _ = core_assistant::validate_order_nums(b);
        let _ = core_assistant::validate_query_id(b);
        let _ = core_assistant::percent_encode(b);
        let _ = core_net::url::percent_decode_query(b);
    }
    let digits = "8".repeat(100_000);
    assert!(recognize_identifiers(&digits).is_empty());
    assert!(core_assistant::translate::validate_draft_request_id(&"-".repeat(100)).is_ok());
}

#[test]
fn im_time_and_sequence_extremes_do_not_panic() {
    // Deadline arithmetic at the limits.
    let round = Round {
        round_id: "g:m".into(),
        version: u64::MAX,
        start_message_id: Some("m".into()),
        start_time_ms: Some(i64::MAX),
        start_confirmed: true,
    };
    let extremes = [i64::MIN, -1, 0, i64::MAX];
    for &server_now in &extremes {
        for &mono in &[0u64, u64::MAX] {
            for q in [
                ClockQuality::Anchored {
                    offset_ms: i64::MIN,
                    error_ms: u64::MAX,
                },
                ClockQuality::Stale,
                ClockQuality::Unanchored,
            ] {
                let c = ClockReading {
                    server_now_ms: server_now,
                    monotonic_ms: mono,
                    quality: q,
                };
                for t1 in [0u32, 30, u32::MAX] {
                    let _ = first_t1_deadline(&round, t1, &c);
                    let r2 = Round {
                        start_time_ms: Some(i64::MIN),
                        ..round.clone()
                    };
                    let _ = first_t1_deadline(&r2, t1, &c);
                }
            }
        }
    }
    // Facts with extreme times, empty ids and control characters.
    let mut h = ImHarness::new();
    for (i, t) in extremes.iter().enumerate() {
        h.message(customer(&format!("c{i}"), *t));
        h.message(msg_in(
            GID,
            &format!("s{i}"),
            *t,
            SenderRole::MerchantOther,
            MessageSource::Realtime,
        ));
    }
    h.message(customer("", 1));
    h.message(customer("\u{0}\n\"", 2));
    h.message(customer_in("", "x", 3));
    h.message(customer_in("\u{0}", "y", 4));
    let mut unresolved = msg_in(
        GID,
        "u",
        i64::MAX,
        SenderRole::Unknown,
        MessageSource::Realtime,
    );
    unresolved.sender_id = String::new();
    h.message(unresolved);
    h.conversation(conv_for("", ConversationStatus::Active, true, true));
    h.push(
        StreamId::Conversation,
        Fact::ConversationListSync {
            full: true,
            last_update_time_ms: Some(i64::MIN),
        },
    );
    h.push(
        StreamId::Message,
        Fact::CompensationSync {
            last_message_timestamp_ms: Some(i64::MAX),
        },
    );
    h.core.note_history_page(GID, i64::MIN, Some(i64::MAX));
    h.core.prove_history_complete(GID, true, i64::MIN);
    h.core.note_history_page("", i64::MAX, None);
    let i = h.core.create_send_intent("", i64::MAX).unwrap();
    h.core.mark_submitted(&i.local_id).unwrap();
    h.core
        .apply_send_result(
            &i.local_id,
            SendDisposition::Confirmed {
                server_message_id: String::new(),
                server_time_ms: i64::MIN,
            },
        )
        .unwrap();
    let i2 = h.core.create_send_intent(GID, i64::MIN).unwrap();
    h.core.mark_submitted(&i2.local_id).unwrap();
    h.core
        .reconcile_unknown(&i2.local_id, &[customer("c0", 0)])
        .unwrap();
    let _ = h.events();
    let _ = h.core.persisted_state();
    let restored = ImCore::restore(h.core.persisted_state());
    assert!(restored.is_reconciling());

    // Sequence numbers at u64::MAX: the next envelope must be a gap / resync,
    // not an overflow panic.
    let mut h = ImHarness::new();
    let env = FactEnvelope {
        account: acc(1),
        stream: StreamId::Message,
        epoch: u64::MAX,
        seq: u64::MAX,
        fact: Fact::Message(customer("c1", 1)),
    };
    assert!(h.core.ingest(env.clone()).unwrap().applied);
    let mut next = env;
    next.fact = Fact::Message(customer("c2", 2));
    let rep = h.core.ingest(next).unwrap();
    assert!(!rep.applied);
    assert!(rep.dropped.is_some());
    let mut wrapped = FactEnvelope {
        account: acc(1),
        stream: StreamId::Message,
        epoch: u64::MAX,
        seq: 0,
        fact: Fact::Message(customer("c3", 3)),
    };
    let rep = h.core.ingest(wrapped.clone()).unwrap();
    assert!(
        !rep.applied,
        "seq reset under the same epoch is never a fresh start"
    );
    wrapped.epoch = 0;
    let rep = h.core.ingest(wrapped).unwrap();
    assert!(!rep.applied);
    assert_eq!(h.core.index().len(), 1);
}

#[test]
fn notify_time_extremes_do_not_panic() {
    let mut n = NotifyCore::new();
    let times = [i64::MIN, i64::MIN + 1, -1, 0, i64::MAX - 1, i64::MAX];
    let monos = [0u64, 1, u64::MAX - 1, u64::MAX];
    let mut rng = Lcg::new(19);
    for &start in &times {
        for &sn in &times {
            for &mono in &monos {
                let now = Now::new(mono, sn, rng.below(2) == 0);
                let round = WaitingRoundRef {
                    account: acc(1),
                    gid: GID.into(),
                    round_id: format!("{GID}:{start}"),
                    version: rng.next_u64(),
                };
                n.apply_round_event(
                    RoundEvent::Started {
                        round: round.clone(),
                        start_message_id: Some("m".into()),
                        start_time_ms: Some(start),
                        start_confirmed: true,
                        label: String::new(),
                    },
                    &now,
                );
                n.apply_clock(ClockReading {
                    server_now_ms: sn,
                    monotonic_ms: mono,
                    quality: ClockQuality::Anchored {
                        offset_ms: i64::MAX,
                        error_ms: u64::MAX,
                    },
                });
                let _ = n.tick(&now);
                let _ = n.tick(&now.plus_ms(u64::MAX));
                let snap = n.snapshot(&now);
                for e in &snap.entries {
                    let _ = core_notify::is_red(e);
                }
                let v = round.version;
                let _ = n.handle_command(
                    contracts::AlarmCommand::Snooze {
                        account: acc(1),
                        gid: GID.into(),
                        round_id: round.round_id.clone(),
                        version: v,
                        minutes: SnoozeMinutes::Thirty,
                    },
                    core_notify::CommandSource::Alarm,
                    &now,
                );
                let _ = n.tick(&now.plus_ms(1_800_000));
                n.apply_round_event(
                    RoundEvent::StartConfirmed {
                        round: round.clone(),
                        start_message_id: "m".into(),
                        start_time_ms: sn,
                    },
                    &now,
                );
                n.apply_round_event(
                    RoundEvent::Ended {
                        round,
                        reason: contracts::RoundEndReason::NotEligible,
                    },
                    &now,
                );
            }
        }
    }
    // Threshold change and restore with extreme values.
    let s = contracts::ReminderSettings {
        t1_seconds: 180,
        continuous_l4: true,
        ..Default::default()
    };
    n.set_settings(s, &Now::new(u64::MAX, i64::MAX, true))
        .unwrap();
    n.restore(
        vec![core_notify::RestoredRound {
            round: WaitingRoundRef {
                account: acc(1),
                gid: GID.into(),
                round_id: "r".into(),
                version: u64::MAX,
            },
            label: String::new(),
            start_time_ms: Some(i64::MIN),
            start_confirmed: true,
            hidden_version: Some(u64::MAX),
            snoozed_until_ms: Some(i64::MAX),
        }],
        &Now::new(0, i64::MIN, false),
    );
    let _ = n.tick(&Now::new(u64::MAX, i64::MAX, true));
    let _ = n.on_unread_changed(&acc(1), GID, u32::MAX);
    let _ = n.handle_command(
        contracts::AlarmCommand::HideAll {
            seen: (0..10_000)
                .map(|i| (GID.to_string(), i.to_string(), u64::MAX))
                .collect(),
        },
        core_notify::CommandSource::Alarm,
        &Now::new(0, 0, true),
    );
}

#[test]
fn notify_invalidated_at_max_generation_does_not_overflow() {
    let mut n = NotifyCore::new();
    let now = Now::new(0, 0, true);
    let round = WaitingRoundRef {
        account: acc(u64::MAX),
        gid: GID.into(),
        round_id: "r".into(),
        version: 1,
    };
    n.apply_round_event(
        RoundEvent::Started {
            round: round.clone(),
            start_message_id: Some("m".into()),
            start_time_ms: Some(0),
            start_confirmed: true,
            label: "x".into(),
        },
        &now,
    );
    let fx = n.apply_round_event(
        RoundEvent::Invalidated {
            round: round.clone(),
        },
        &now,
    );
    assert!(n.rounds().is_empty());
    assert_eq!(raises(&fx), 0);
    // u64::MAX has no successor generation; a later event of the same
    // generation is at worst a fresh round, never a panic.
    let _ = n.apply_round_event(
        RoundEvent::Started {
            round,
            start_message_id: Some("m".into()),
            start_time_ms: Some(0),
            start_confirmed: true,
            label: "x".into(),
        },
        &now,
    );
    assert!(n.rounds().len() <= 1);
}

#[test]
fn clock_service_extremes_do_not_panic() {
    // Wall clock jumping from i64::MAX to i64::MIN while monotonic moved 1 ms.
    let mut c = ClockService::default();
    c.anchor_from_server(i64::MAX, i64::MAX, 0, u64::MAX);
    assert_eq!(c.reading(i64::MIN, 1).quality, ClockQuality::Stale);
    let mut c = ClockService::new(u64::MAX);
    c.anchor_from_server(0, 0, 0, 0);
    assert_eq!(
        c.reading(0, u64::MAX).server_now_ms,
        i64::MAX,
        "elapsed saturates, never negative"
    );
    let walls = [i64::MIN, i64::MIN + 1, -1, 0, 1, i64::MAX - 1, i64::MAX];
    let monos = [0u64, 1, u64::MAX - 1, u64::MAX];
    for &w0 in &walls {
        for &m0 in &monos {
            for &rtt in &[0u64, 1, u64::MAX] {
                let mut c = ClockService::default();
                let _ = c.reading(w0, m0);
                let _ = c.anchor_from_server(w0, w0, m0, rtt);
                for &w in &walls {
                    for &m in &monos {
                        let r = c.reading(w, m);
                        let _ = r.trusted();
                        let now = Now::from_reading(&r);
                        let _ = now.plus_ms(u64::MAX);
                    }
                }
                c.mark_stale();
                let _ = c.reading(w0, m0);
                let _ = ClockService::new(u64::MAX)
                    .with_jump_threshold(u64::MAX)
                    .reading(w0, m0);
            }
        }
    }
    let mut coord = core_net::ReconcileCoordinator::new();
    for _ in 0..1_000 {
        let g = coord.begin_reconcile(core_net::ReconcileReason::ClockStale);
        assert!(!coord.complete(g.wrapping_add(1)));
        assert!(coord.complete(g));
    }
}

#[test]
fn hostile_persisted_documents_are_errors_or_quarantine_never_panics() {
    let mut rng = Lcg::new(23);
    // Account registry restore.
    let mut docs: Vec<String> = (0..1_000).map(|_| hostile_text(&mut rng, 100)).collect();
    docs.extend([
        r#"{"version":1,"index":{"entries":[]},"ledger":{},"accounts":[]}"#.into(),
        r#"{"version":1,"index":{"entries":[{"environment":"t","buid":"b","account_id":"a","last_generation":1e300}]},"ledger":{},"accounts":[{"account_id":"a","environment":"t","order":4294967295,"state":"suspended"}]}"#.into(),
        r#"{"version":1,"index":{"entries":[{"environment":"t","buid":"b","account_id":"a","last_generation":-5}]},"ledger":{"index":{"a":{"key":"k","revision":-1}},"journal":[{"operation_id":"o","account_id":"a","profile_id":"p","new_ref":{"key":"k","revision":1e300},"stage":"secret_staged","staged":{"target":{"key":"k","revision":2},"handle":"h"}}],"high_water":{"a":1e300}},"accounts":[{"account_id":"a","environment":"t","order":-1,"state":"invalid"}]}"#.into(),
        r#"{"version":1,"index":{"entries":[{"environment":"t","buid":"b","account_id":"a"},{"environment":"t","buid":"c","account_id":"a"}]},"ledger":{},"accounts":[]}"#.into(),
        r#"{"version":1,"index":{"entries":[{"environment":"t","buid":"b","account_id":"a"}]},"ledger":{},"accounts":[{"account_id":"a","environment":"u"}]}"#.into(),
    ]);
    for (i, d) in docs.iter().enumerate() {
        if let Ok(v) = JsonValue::parse(d) {
            if let Ok(mut reg) = AccountRegistry::restore(&v, u64::MAX) {
                let mut store = core_account::MemorySecretStore::new();
                let _ = reg.recover_credentials(&mut store);
                let _ = reg.account_snapshot();
                // Adding an account next to a restored row with order u32::MAX.
                let h = reg.start_login(contracts::Environment::named("t"));
                let _ = reg.publish_identity(
                    &h.attempt_id,
                    core_account::UpstreamIdentity {
                        buid: core_account::Buid::new(format!("new-{i}")),
                        uid: "u".into(),
                        agent_id: None,
                        environment: contracts::Environment::named("t"),
                    },
                );
                let _ = reg.to_json().to_json();
            }
        }
    }
    // Store documents on disk.
    let dir = std::env::temp_dir().join(format!("vbk-qa-hostile-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let store = FileStore::open(&dir).unwrap();
    let ns = Namespace::from_context(&acc(1));
    let mut docs: Vec<String> = (0..300).map(|_| hostile_text(&mut rng, 120)).collect();
    docs.extend([
        r#"{"meta":{"environment":"test","account_id":"acc-test","revision":1e300,"committed_at_ms":-1e300},"collections":{"rounds":{"g#r":{"gid":"g","round_id":"r","version":1e300,"start_time_ms":"x","reminded_version":-1e300}},"send_intents":{"l":{"local_id":"l","gid":"g","account":{"account_id":"acc-test","environment":"test","session_generation":1e300},"created_at_ms":1e300,"disposition":{"kind":"confirmed","server_message_id":1,"server_time_ms":"t"}}},"sync":{"history:g":{"page_breakpoint_ms":[],"complete_watermark_ms":{}}},"drafts":{"g":{"gid":"g","text":1,"version":1}}}}"#.into(),
        r#"{"meta":{"environment":"test","account_id":"acc-test","revision":-1},"collections":{}}"#.into(),
        r#"{"meta":{"environment":"test","account_id":"acc-test","revision":9223372036854775807},"collections":{"rounds":[]}}"#.into(),
        r#"{"meta":{"environment":"test","account_id":"acc-test","revision":1},"collections":{"rounds":{"x":{"gid":"g","round_id":"r","version":1}}}}"#.into(),
    ]);
    for d in &docs {
        let p = store.namespace_dir(&ns).join("state.json");
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, d).unwrap();
        let _ = store.get(&ns, "rounds", "x");
        let _ = ReminderStateRepo::load_all(&store, &ns);
        let _ = SendIntentRepo::load_all(&store, &ns);
        let _ = core_store::SyncWatermarkRepo::history(&store, &ns, "g");
        let _ = core_store::DraftRepo::load(&store, &ns, "g");
        if let Ok(mut txn) = store.begin(&ns) {
            txn.put("c", "k", JsonValue::Null);
            let _ = store.commit(txn);
        }
        let _ = store.acknowledge_corruption(&ns);
    }
    let _ = std::fs::remove_dir_all(&dir);
}

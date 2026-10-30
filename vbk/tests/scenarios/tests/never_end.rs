//! Q5 — read / open / send-click / submitted / unknown / rejected never end
//! a round in core-im, and core-notify has no input that could do so: the
//! only removals are `Ended` / `Invalidated` (README 不变量 4, strong-alert
//! §2 / §4.5 / §7 "回复及失败").
#![allow(clippy::unwrap_used)]

mod common;

use common::*;
use contracts::{AlarmLevel, MessageSource, MsgKind, RoundEvent, SendDisposition, SenderRole};
use core_notify::{NotifyCore, Sound, SystemState};

#[test]
fn consumption_facts_never_end_the_round_end_to_end() {
    let mut h = ImHarness::new();
    let mut n = NotifyCore::new();
    h.message(customer("c1", T0_SERVER + 10_000));
    let fx = feed(&mut n, h.events(), &clock(10_000));
    assert_eq!(shows(&fx), 0);
    let fx = drive(&mut n, &clock(10_000), 0, 31);
    assert_eq!(raises(&fx), 1);
    assert_eq!(sounds(&fx, Sound::Timeout), 1);
    let before = h.waiting().clone();

    // Every "consumption" input in turn; none may produce a round event.
    h.core.on_read(GID, Some("c1"));
    h.core.on_open_conversation(GID);
    h.core.on_send_clicked(GID);
    let i1 = h.core.create_send_intent(GID, T0_SERVER + 41_000).unwrap();
    h.core.on_send_submitted(&i1.local_id).unwrap();
    h.core
        .apply_send_result(&i1.local_id, SendDisposition::Unknown)
        .unwrap();
    let i2 = h.core.create_send_intent(GID, T0_SERVER + 42_000).unwrap();
    h.core.mark_submitted(&i2.local_id).unwrap();
    h.core
        .apply_send_result(
            &i2.local_id,
            SendDisposition::Rejected {
                code: "E".into(),
                reason: "denied".into(),
            },
        )
        .unwrap();
    // Control frames and non-merchant business messages.
    for kind in [
        MsgKind::ReadReceipt,
        MsgKind::Typing,
        MsgKind::Control,
        MsgKind::Recall,
    ] {
        let mut f = msg_in(
            GID,
            &format!("ctl-{kind:?}"),
            T0_SERVER + 43_000,
            SenderRole::MerchantSelf,
            MessageSource::Realtime,
        );
        f.kind = kind;
        h.message(f);
    }
    for role in [
        SenderRole::Robot,
        SenderRole::System,
        SenderRole::CtripAgent,
    ] {
        h.message(msg_in(
            GID,
            &format!("b-{role:?}"),
            T0_SERVER + 44_000,
            role,
            MessageSource::Realtime,
        ));
    }
    // Transport "connected" and a conversation increment are not replies.
    h.push(
        core_im::StreamId::Transport,
        core_im::Fact::Transport(core_im::TransportState::Connected),
    );
    h.conversation(conv(contracts::ConversationStatus::Active, true, false));
    h.push(
        core_im::StreamId::Conversation,
        core_im::Fact::ConversationListSync {
            full: false,
            last_update_time_ms: Some(T0_SERVER + 45_000),
        },
    );
    h.push(
        core_im::StreamId::Message,
        core_im::Fact::CompensationSync {
            last_message_timestamp_ms: Some(T0_SERVER + 45_000),
        },
    );

    let ev = h.events();
    assert_eq!(
        count_ended(&ev),
        0,
        "no Ended for consumption facts: {ev:?}"
    );
    assert!(!ev
        .iter()
        .any(|e| matches!(e, RoundEvent::Invalidated { .. })));
    let after = h.waiting();
    assert_eq!(after.round_id, before.round_id);
    assert_eq!(after.start_message_id, before.start_message_id);
    assert_eq!(after.start_time_ms, before.start_time_ms);
    assert!(after.start_confirmed);
    assert_eq!(
        h.core.unread(GID),
        1,
        "the conversation fact restored the server unread after a local clear"
    );

    // notify side: the host-visible consumption signals exist only as
    // L0/L1/L2 inputs and never remove a round.
    let now = clock(46_000);
    let mut fx = Vec::new();
    fx.extend(n.on_unread_changed(&h.account, GID, 0));
    fx.extend(n.on_new_message(&h.account, GID, false, &now));
    fx.extend(n.set_system_state(
        SystemState {
            main_window_focused: true,
            viewing_gid: Some(GID.into()),
            ..SystemState::default()
        },
        &now,
    ));
    fx.extend(feed(&mut n, ev, &now));
    assert!(!has(&fx, &core_notify::Effect::HideAlarm));
    assert_eq!(n.rounds().len(), 1);
    let snap = n.snapshot(&now);
    assert_eq!(snap.entries.len(), 1);
    assert_eq!(snap.entries[0].level, AlarmLevel::L3);
    assert_eq!(snap.entries[0].round_id, format!("{GID}:c1"));
    assert!(n.alarm_visible());
}

#[test]
fn only_a_confirmed_valid_merchant_reply_ends_it() {
    let mut h = ImHarness::new();
    let mut n = NotifyCore::new();
    h.message(customer("c1", T0_SERVER + 10_000));
    feed(&mut n, h.events(), &clock(10_000));
    drive(&mut n, &clock(10_000), 0, 31);
    let i = h.core.create_send_intent(GID, T0_SERVER + 41_000).unwrap();
    h.core.mark_submitted(&i.local_id).unwrap();
    h.core
        .apply_send_result(&i.local_id, SendDisposition::Unknown)
        .unwrap();
    assert!(h.events().is_empty());
    h.core
        .apply_send_result(
            &i.local_id,
            SendDisposition::Confirmed {
                server_message_id: "t1".into(),
                server_time_ms: T0_SERVER + 42_000,
            },
        )
        .unwrap();
    let ev = h.events();
    assert_eq!(count_ended(&ev), 1);
    let fx = feed(&mut n, ev, &clock(42_000));
    assert!(has(&fx, &core_notify::Effect::HideAlarm));
    assert!(n.rounds().is_empty());
    assert!(!n.alarm_visible());
}

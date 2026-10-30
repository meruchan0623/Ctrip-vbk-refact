//! Acceptance tests mapping docs/dev/03-strong-alert.md §4/§5/§7 rows and
//! plan §7 "迟到回复证据" onto `ImCore`. Synthetic fixtures only: no
//! credentials, no customer text.
#![allow(clippy::unwrap_used)]

use contracts::{
    AccountContext, AccountId, ClockQuality, ClockReading, ConversationFact, ConversationStatus,
    Environment, MessageFact, MessageSource, MsgKind, ReconcileState, RoundEndReason, RoundEvent,
    SendDisposition, SenderRole, StreamCursor,
};
use core_im::{
    codes, first_t1_deadline, BusinessLineRule, DropReason, Fact, FactEnvelope, ImCore, ImCores,
    MergeOutcome, ReconcileOutcome, RoundState, SendState, StreamId,
};

const GID: &str = "group-0001";

fn ctx(generation: u64) -> AccountContext {
    AccountContext::new(
        AccountId::new("acc-test"),
        Environment::named("test"),
        generation,
    )
}

fn msg(mid: &str, t: i64, role: SenderRole, src: MessageSource) -> MessageFact {
    MessageFact {
        gid: GID.into(),
        message_id: Some(mid.into()),
        local_id: None,
        create_time_ms: t,
        sender_role: role,
        sender_id: format!("uid-{role:?}"),
        kind: MsgKind::Business,
        source: src,
        disposition: None,
    }
}

fn customer(mid: &str, t: i64) -> MessageFact {
    msg(mid, t, SenderRole::Customer, MessageSource::Realtime)
}

fn conv(status: ConversationStatus, in_group: bool, full: bool) -> ConversationFact {
    ConversationFact {
        gid: GID.into(),
        status,
        agent_in_group: in_group,
        is_owner: true,
        service_type: "1513".into(),
        last_message_time_ms: None,
        last_update_time_ms: Some(1_000),
        unread_count: 3,
        is_full_snapshot: full,
    }
}

/// Drives one core with per-stream sequence numbers.
struct Harness {
    core: ImCore,
    account: AccountContext,
    epoch: u64,
    seq: [u64; 3],
}

impl Harness {
    fn new() -> Self {
        let account = ctx(1);
        let mut h = Self {
            core: ImCore::new(account.clone()),
            account,
            epoch: 1,
            seq: [0; 3],
        };
        h.push(
            StreamId::Conversation,
            Fact::Conversation(conv(ConversationStatus::Active, true, false)),
        );
        h
    }

    fn envelope(&mut self, stream: StreamId, fact: Fact) -> FactEnvelope {
        let idx = match stream {
            StreamId::Message => 0,
            StreamId::Conversation => 1,
            StreamId::Transport => 2,
        };
        self.seq[idx] += 1;
        FactEnvelope {
            account: self.account.clone(),
            stream,
            epoch: self.epoch,
            seq: self.seq[idx],
            fact,
        }
    }

    fn push(&mut self, stream: StreamId, fact: Fact) -> core_im::IngestReport {
        let env = self.envelope(stream, fact);
        self.core.ingest(env).unwrap()
    }

    fn message(&mut self, fact: MessageFact) -> core_im::IngestReport {
        self.push(StreamId::Message, Fact::Message(fact))
    }

    fn conversation(&mut self, fact: ConversationFact) -> core_im::IngestReport {
        self.push(StreamId::Conversation, Fact::Conversation(fact))
    }

    fn events(&mut self) -> Vec<RoundEvent> {
        self.core.drain_round_events()
    }

    fn waiting(&self) -> &core_im::Round {
        match self.core.round_state(GID) {
            RoundState::Waiting(r) => r,
            other => panic!("expected Waiting, got {other:?}"),
        }
    }

    fn pending(&self) -> &core_im::Round {
        match self.core.round_state(GID) {
            RoundState::PendingVerification(r) => r,
            other => panic!("expected PendingVerification, got {other:?}"),
        }
    }
}

fn ended_reason(events: &[RoundEvent]) -> Option<RoundEndReason> {
    events.iter().find_map(|e| match e {
        RoundEvent::Ended { reason, .. } => Some(*reason),
        _ => None,
    })
}

// ------------------------------------------------------------ §7 "30 秒等待"

#[test]
fn round_starts_from_first_customer_message_and_owns_first_t1() {
    let mut h = Harness::new();
    let report = h.message(customer("c1", 10_000));
    assert!(report.applied);
    assert_eq!(report.message, Some(MergeOutcome::Inserted));
    assert_eq!(report.round_events, 1);

    let round = h.waiting().clone();
    assert_eq!(round.round_id, format!("{GID}:c1"));
    assert_eq!(round.version, 1);
    assert_eq!(round.start_message_id.as_deref(), Some("c1"));
    assert_eq!(round.start_time_ms, Some(10_000));
    assert!(round.start_confirmed);

    let ev = h.events();
    assert_eq!(ev.len(), 1);
    match &ev[0] {
        RoundEvent::Started {
            round: r,
            start_message_id,
            start_time_ms,
            start_confirmed,
            label,
        } => {
            assert_eq!(r.account, ctx(1));
            assert_eq!(r.gid, GID);
            assert_eq!(r.version, 1);
            assert_eq!(start_message_id.as_deref(), Some("c1"));
            assert_eq!(*start_time_ms, Some(10_000));
            assert!(start_confirmed);
            assert!(!label.contains(GID), "label must be masked: {label}");
        }
        other => panic!("unexpected {other:?}"),
    }

    let clock = ClockReading {
        server_now_ms: 12_000,
        monotonic_ms: 500,
        quality: ClockQuality::Anchored {
            offset_ms: 0,
            error_ms: 10,
        },
    };
    let d = first_t1_deadline(&round, 30, &clock);
    assert_eq!(d.due_at_monotonic_ms, Some(500 + 28_000));
    assert!(d.trusted);
    let untrusted = ClockReading {
        quality: ClockQuality::Unanchored,
        ..clock
    };
    assert!(!first_t1_deadline(&round, 30, &untrusted).trusted);
}

#[test]
fn no_round_without_eligible_conversation_until_fact_arrives() {
    let account = ctx(1);
    let mut core = ImCore::new(account.clone());
    let env = FactEnvelope {
        account: account.clone(),
        stream: StreamId::Message,
        epoch: 1,
        seq: 1,
        fact: Fact::Message(customer("c1", 10_000)),
    };
    core.ingest(env).unwrap();
    assert!(
        core.round_state(GID).is_idle(),
        "unknown conversation: no round"
    );
    core.ingest(FactEnvelope {
        account,
        stream: StreamId::Conversation,
        epoch: 1,
        seq: 1,
        fact: Fact::Conversation(conv(ConversationStatus::Active, true, false)),
    })
    .unwrap();
    // Eligibility arrived: the round starts from the real message time.
    match core.round_state(GID) {
        RoundState::Waiting(r) => assert_eq!(r.start_time_ms, Some(10_000)),
        other => panic!("{other:?}"),
    }
}

// ------------------------------------------------- §7 "连续与重复消息"

#[test]
fn consecutive_customer_messages_do_not_move_start() {
    let mut h = Harness::new();
    h.message(customer("c1", 10_000));
    h.events();
    h.message(customer("c2", 20_000));
    h.message(customer("c3", 30_000));
    let r = h.waiting();
    assert_eq!(r.start_message_id.as_deref(), Some("c1"));
    assert_eq!(r.start_time_ms, Some(10_000));
    assert_eq!(r.version, 1);
    assert!(h.events().is_empty());
}

#[test]
fn duplicate_from_two_connections_and_compensation_counted_once() {
    let mut h = Harness::new();
    h.message(customer("c1", 10_000));
    h.events();
    let dup = h.message(customer("c1", 10_000));
    assert_eq!(dup.message, Some(MergeOutcome::Duplicate));
    let comp = h.message(msg(
        "c1",
        10_000,
        SenderRole::Customer,
        MessageSource::Compensation,
    ));
    assert_eq!(comp.message, Some(MergeOutcome::Duplicate));
    let init = h.message(msg("c1", 10_000, SenderRole::Customer, MessageSource::Init));
    assert_eq!(init.message, Some(MergeOutcome::Duplicate));
    assert_eq!(h.core.index().len(), 1);
    assert_eq!(
        h.core
            .index()
            .find_by_message_id(GID, "c1")
            .unwrap()
            .seen_count,
        4
    );
    assert_eq!(h.waiting().version, 1);
    assert!(h.events().is_empty());
}

#[test]
fn out_of_order_earlier_customer_message_moves_start_earlier() {
    let mut h = Harness::new();
    h.message(customer("c2", 20_000));
    h.events();
    // Arrives later through compensation but is older.
    h.message(msg(
        "c1",
        10_000,
        SenderRole::Customer,
        MessageSource::Compensation,
    ));
    let r = h.waiting();
    assert_eq!(r.start_message_id.as_deref(), Some("c1"));
    assert_eq!(r.start_time_ms, Some(10_000));
    assert_eq!(r.version, 2);
    assert_eq!(r.round_id, format!("{GID}:c2"), "round identity is stable");
    let ev = h.events();
    assert!(matches!(
        &ev[..],
        [RoundEvent::StartConfirmed { round, start_message_id, start_time_ms }]
            if round.version == 2 && start_message_id == "c1" && *start_time_ms == 10_000
    ));
    // Even older, via history replay: replay may recompute an existing round.
    h.message(msg(
        "c0",
        5_000,
        SenderRole::Customer,
        MessageSource::History,
    ));
    assert_eq!(h.waiting().start_message_id.as_deref(), Some("c0"));
    assert_eq!(h.waiting().version, 3);
}

// ---------------------------------------------------- §7 "回复及失败"

#[test]
fn read_open_send_click_submit_and_unknown_never_clear() {
    let mut h = Harness::new();
    h.message(customer("c1", 10_000));
    h.events();

    h.core.on_read(GID, Some("c1"));
    assert!(h.core.on_open_conversation(GID));
    assert_eq!(h.core.unread(GID), 0, "open clears unread");
    h.core.on_send_clicked(GID);
    let intent = h.core.create_send_intent(GID, 11_000).unwrap();
    assert_eq!(
        intent.frozen_round_id.as_deref(),
        Some(format!("{GID}:c1").as_str())
    );
    assert_eq!(intent.frozen_round_version, Some(1));
    assert_eq!(intent.customer_boundary_message_id.as_deref(), Some("c1"));
    h.core.on_send_submitted(&intent.local_id).unwrap();
    assert_eq!(
        h.core
            .apply_send_result(&intent.local_id, SendDisposition::Unknown)
            .unwrap(),
        SendState::Unknown
    );
    // Transport "connected" is not a confirmation either.
    h.push(
        StreamId::Transport,
        Fact::Transport(core_im::TransportState::Connected),
    );

    let r = h.waiting();
    assert_eq!(r.version, 1);
    assert!(h.events().is_empty());
    assert_eq!(h.core.outbox().unknown().count(), 1);
}

#[test]
fn confirmed_own_reply_clears_round() {
    let mut h = Harness::new();
    h.message(customer("c1", 10_000));
    h.events();
    let intent = h.core.create_send_intent(GID, 11_000).unwrap();
    h.core.mark_submitted(&intent.local_id).unwrap();
    let st = h
        .core
        .apply_send_result(
            &intent.local_id,
            SendDisposition::Confirmed {
                server_message_id: "t1".into(),
                server_time_ms: 12_000,
            },
        )
        .unwrap();
    assert!(matches!(st, SendState::Confirmed { .. }));
    assert!(h.core.round_state(GID).is_idle());
    let ev = h.events();
    assert_eq!(
        ended_reason(&ev),
        Some(RoundEndReason::MerchantReplyConfirmed)
    );
    assert!(matches!(&ev[0], RoundEvent::Ended { round, .. } if round.version == 2));
    // Local id is now addressable by the server id; echo is a duplicate.
    assert!(h.core.index().find_by_message_id(GID, "t1").is_some());
    let mut echo = msg(
        "t1",
        12_000,
        SenderRole::MerchantSelf,
        MessageSource::Realtime,
    );
    echo.local_id = Some(intent.local_id.clone());
    assert_eq!(h.message(echo).message, Some(MergeOutcome::Duplicate));
    assert!(h.core.round_state(GID).is_idle());
}

#[test]
fn other_agent_reply_with_server_id_clears_round() {
    let mut h = Harness::new();
    h.message(customer("c1", 10_000));
    h.events();
    h.message(msg(
        "s1",
        12_000,
        SenderRole::MerchantOther,
        MessageSource::Realtime,
    ));
    assert!(h.core.round_state(GID).is_idle());
    assert_eq!(
        ended_reason(&h.events()),
        Some(RoundEndReason::MerchantReplyConfirmed)
    );
}

#[test]
fn echo_before_ack_confirms_send_and_clears_round() {
    let mut h = Harness::new();
    h.message(customer("c1", 10_000));
    h.events();
    let intent = h.core.create_send_intent(GID, 11_000).unwrap();
    h.core.mark_submitted(&intent.local_id).unwrap();
    let mut echo = msg(
        "t1",
        12_000,
        SenderRole::MerchantSelf,
        MessageSource::Realtime,
    );
    echo.local_id = Some(intent.local_id.clone());
    assert!(matches!(
        h.message(echo).message,
        Some(MergeOutcome::Linked { .. })
    ));
    assert!(matches!(
        h.core.outbox().get(&intent.local_id).unwrap().state,
        SendState::Confirmed { .. }
    ));
    assert!(h.core.round_state(GID).is_idle());
    // The late ACK is a no-op duplicate.
    h.core
        .apply_send_result(
            &intent.local_id,
            SendDisposition::Confirmed {
                server_message_id: "t1".into(),
                server_time_ms: 12_000,
            },
        )
        .unwrap();
    assert!(h.core.round_state(GID).is_idle());
}

// ------------------------------------------- §7 "多角色与会话状态"

#[test]
fn robot_system_ctrip_and_control_frames_never_clear() {
    let mut h = Harness::new();
    h.message(customer("c1", 10_000));
    h.events();
    h.message(msg(
        "r1",
        11_000,
        SenderRole::Robot,
        MessageSource::Realtime,
    ));
    h.message(msg(
        "sys",
        12_000,
        SenderRole::System,
        MessageSource::Realtime,
    ));
    h.message(msg(
        "ct",
        13_000,
        SenderRole::CtripAgent,
        MessageSource::Realtime,
    ));
    let mut read = msg(
        "rr",
        14_000,
        SenderRole::MerchantSelf,
        MessageSource::Realtime,
    );
    read.kind = MsgKind::ReadReceipt;
    h.message(read);
    let mut typing = msg(
        "ty",
        15_000,
        SenderRole::MerchantOther,
        MessageSource::Realtime,
    );
    typing.kind = MsgKind::Typing;
    h.message(typing);
    let r = h.waiting();
    assert_eq!(r.start_message_id.as_deref(), Some("c1"));
    assert_eq!(r.version, 1);
    assert!(h.events().is_empty());
}

#[test]
fn unknown_role_marks_pending_verification_until_resolved() {
    let mut h = Harness::new();
    h.message(customer("c1", 10_000));
    h.events();
    h.message(msg(
        "u1",
        11_000,
        SenderRole::Unknown,
        MessageSource::Realtime,
    ));
    let r = h.pending();
    assert_eq!(r.start_message_id.as_deref(), Some("c1"));
    assert!(!r.start_confirmed);
    assert_eq!(r.version, 2);
    let ev = h.events();
    assert!(
        matches!(&ev[..], [RoundEvent::Started { start_confirmed: false, round, .. }] if round.version == 2)
    );

    // Resolved as robot: back to waiting, start re-confirmed.
    h.message(msg(
        "u1",
        11_000,
        SenderRole::Robot,
        MessageSource::Compensation,
    ));
    let r = h.waiting();
    assert!(r.start_confirmed);
    assert_eq!(r.version, 3);
    assert!(matches!(
        &h.events()[..],
        [RoundEvent::StartConfirmed { .. }]
    ));

    // Another unknown, then resolved as a merchant colleague: ends.
    h.message(msg(
        "u2",
        12_000,
        SenderRole::Unknown,
        MessageSource::Realtime,
    ));
    h.pending();
    h.events();
    h.message(msg(
        "u2",
        12_000,
        SenderRole::MerchantOther,
        MessageSource::Compensation,
    ));
    assert!(h.core.round_state(GID).is_idle());
    assert_eq!(
        ended_reason(&h.events()),
        Some(RoundEndReason::MerchantReplyConfirmed)
    );
}

#[test]
fn finished_transferred_and_left_group_end_with_matching_reason() {
    for (fact, reason) in [
        (
            conv(ConversationStatus::Finished, true, false),
            RoundEndReason::ConversationFinished,
        ),
        (
            conv(ConversationStatus::TransferredOut, true, false),
            RoundEndReason::TransferredOut,
        ),
        (
            conv(ConversationStatus::Active, false, false),
            RoundEndReason::NotEligible,
        ),
        (
            conv(ConversationStatus::Unknown, true, false),
            RoundEndReason::NotEligible,
        ),
    ] {
        let mut h = Harness::new();
        h.message(customer("c1", 10_000));
        h.events();
        h.conversation(fact);
        assert!(h.core.round_state(GID).is_idle());
        assert_eq!(ended_reason(&h.events()), Some(reason));
        assert!(!h.core.eligible_for_reminder(GID));
        // New customer messages do not start anything while not eligible.
        h.message(customer("c2", 20_000));
        assert!(h.core.round_state(GID).is_idle());
    }
}

#[test]
fn excluded_business_line_rule_is_explicit() {
    let mut h = Harness::new();
    h.message(customer("c1", 10_000));
    h.events();
    h.core
        .set_business_line_rule("1513", BusinessLineRule::Excluded);
    assert!(h.core.round_state(GID).is_idle());
    assert_eq!(ended_reason(&h.events()), Some(RoundEndReason::NotEligible));
    h.core
        .set_business_line_rule("1513", BusinessLineRule::Generic);
    // Back to generic: the still-unanswered live message re-opens a round.
    assert_eq!(h.waiting().start_message_id.as_deref(), Some("c1"));
}

// ------------------------------------------------ §4.6 replay and history

#[test]
fn history_replay_never_restarts_an_ended_round() {
    let mut h = Harness::new();
    h.message(customer("c1", 10_000));
    h.message(msg(
        "s1",
        12_000,
        SenderRole::MerchantOther,
        MessageSource::Realtime,
    ));
    assert!(h.core.round_state(GID).is_idle());
    h.events();
    // Replays of the answered message and of an older unanswered one.
    h.message(msg(
        "c1",
        10_000,
        SenderRole::Customer,
        MessageSource::History,
    ));
    h.message(msg("c0", 9_000, SenderRole::Customer, MessageSource::Init));
    assert!(h.core.round_state(GID).is_idle());
    // A newer customer message known only from replay cannot start a round.
    h.message(msg(
        "c5",
        20_000,
        SenderRole::Customer,
        MessageSource::History,
    ));
    assert!(h.core.round_state(GID).is_idle());
    assert!(h.events().is_empty());
    // The same message seen live does.
    h.message(msg(
        "c5",
        20_000,
        SenderRole::Customer,
        MessageSource::Compensation,
    ));
    assert_eq!(h.waiting().start_message_id.as_deref(), Some("c5"));
}

#[test]
fn insufficient_history_is_pending_without_fabricated_time() {
    let mut h = Harness::new();
    // A backward page landed whose oldest message is an unanswered customer
    // message; the server has not said `isDone`.
    h.core.note_history_page(GID, 5_000, Some(5_000));
    h.message(msg(
        "h1",
        5_000,
        SenderRole::Customer,
        MessageSource::History,
    ));
    h.message(msg(
        "h2",
        6_000,
        SenderRole::Customer,
        MessageSource::History,
    ));
    assert!(
        h.core.round_state(GID).is_idle(),
        "replay alone starts nothing"
    );
    h.message(customer("c1", 30_000));
    let r = h.pending().clone();
    assert_eq!(r.start_message_id, None);
    assert_eq!(r.start_time_ms, None);
    assert!(!r.start_confirmed);
    assert_eq!(r.round_id, format!("{GID}:#1"));
    assert!(matches!(
        &h.events()[..],
        [RoundEvent::Started {
            start_message_id: None,
            start_time_ms: None,
            start_confirmed: false,
            ..
        }]
    ));
    let clock = ClockReading {
        server_now_ms: 31_000,
        monotonic_ms: 0,
        quality: ClockQuality::Anchored {
            offset_ms: 0,
            error_ms: 1,
        },
    };
    assert_eq!(first_t1_deadline(&r, 30, &clock).due_at_monotonic_ms, None);

    // Not done yet: still pending.
    assert!(!h.core.prove_history_complete(GID, false, 5_000));
    h.pending();
    assert!(h.events().is_empty());

    // Server proves the window reaches the conversation start.
    assert!(h.core.prove_history_complete(GID, true, 5_000));
    let r = h.waiting();
    assert_eq!(r.start_message_id.as_deref(), Some("h1"));
    assert_eq!(r.start_time_ms, Some(5_000));
    assert!(r.start_confirmed);
    assert_eq!(
        r.round_id,
        format!("{GID}:#1"),
        "identity kept across confirmation"
    );
    assert!(
        matches!(&h.events()[..], [RoundEvent::StartConfirmed { start_message_id, .. }] if start_message_id == "h1")
    );
}

#[test]
fn history_with_an_older_reply_is_sufficient() {
    let mut h = Harness::new();
    h.core.note_history_page(GID, 4_000, Some(4_000));
    h.message(msg(
        "s0",
        4_000,
        SenderRole::MerchantSelf,
        MessageSource::History,
    ));
    h.message(msg(
        "h1",
        5_000,
        SenderRole::Customer,
        MessageSource::History,
    ));
    h.message(customer("c1", 30_000));
    let r = h.waiting();
    assert_eq!(r.start_message_id.as_deref(), Some("h1"));
    assert!(r.start_confirmed);
}

#[test]
fn complete_watermark_only_advances_via_proof() {
    let mut h = Harness::new();
    h.message(customer("c1", 10_000));
    h.message(customer("c9", 99_000));
    h.push(
        StreamId::Message,
        Fact::CompensationSync {
            last_message_timestamp_ms: Some(99_000),
        },
    );
    let w = *h.core.watermarks().history(GID).unwrap();
    assert_eq!(w.latest_seen_ms, Some(99_000));
    assert_eq!(w.complete_watermark_ms, None);
    assert_eq!(h.core.watermarks().compensation_cursor_ms(), Some(99_000));
    assert!(!h.core.prove_history_complete(GID, false, 10_000));
    assert_eq!(
        h.core
            .watermarks()
            .history(GID)
            .unwrap()
            .complete_watermark_ms,
        None
    );
    assert!(h.core.prove_history_complete(GID, true, 10_000));
    assert_eq!(
        h.core
            .watermarks()
            .history(GID)
            .unwrap()
            .complete_watermark_ms,
        Some(10_000)
    );
    let snap = h.core.sync_snapshot();
    assert_eq!(snap.history.len(), 1);
}

// --------------------------------------------- plan §7 "迟到回复证据"

#[test]
fn late_ack_does_not_clear_newer_customer_message() {
    // C1 → S1 (intent, boundary C1) → C2 → ACK(S1)
    let mut h = Harness::new();
    h.message(customer("c1", 10_000));
    let intent = h.core.create_send_intent(GID, 11_000).unwrap();
    h.core.mark_submitted(&intent.local_id).unwrap();
    h.message(customer("c2", 20_000));
    h.events();
    h.core
        .apply_send_result(
            &intent.local_id,
            SendDisposition::Confirmed {
                server_message_id: "t1".into(),
                server_time_ms: 15_000,
            },
        )
        .unwrap();
    let r = h.waiting();
    assert_eq!(r.round_id, format!("{GID}:c2"));
    assert_eq!(r.start_message_id.as_deref(), Some("c2"));
    assert_eq!(r.start_time_ms, Some(20_000));
    let ev = h.events();
    assert_eq!(ev.len(), 2);
    assert!(
        matches!(&ev[0], RoundEvent::Ended { round, reason: RoundEndReason::MerchantReplyConfirmed } if round.round_id == format!("{GID}:c1"))
    );
    assert!(
        matches!(&ev[1], RoundEvent::Started { round, start_confirmed: true, .. } if round.round_id == format!("{GID}:c2"))
    );
}

#[test]
fn ack_server_time_after_newer_message_still_does_not_cover_it() {
    // The agent never saw C2 when composing: the boundary wins over the
    // server timestamp, C2 keeps waiting.
    let mut h = Harness::new();
    h.message(customer("c1", 10_000));
    let intent = h.core.create_send_intent(GID, 11_000).unwrap();
    h.core.mark_submitted(&intent.local_id).unwrap();
    h.message(customer("c2", 20_000));
    h.events();
    h.core
        .apply_send_result(
            &intent.local_id,
            SendDisposition::Confirmed {
                server_message_id: "t1".into(),
                server_time_ms: 25_000,
            },
        )
        .unwrap();
    assert_eq!(h.waiting().start_message_id.as_deref(), Some("c2"));
}

#[test]
fn same_timestamp_order_ambiguity_is_pending_not_cleared() {
    let mut h = Harness::new();
    h.message(customer("c1", 10_000));
    h.message(customer("c2", 20_000));
    h.events();
    // Colleague's reply with the same server millisecond as C2.
    h.message(msg(
        "s1",
        20_000,
        SenderRole::MerchantOther,
        MessageSource::Realtime,
    ));
    let r = h.pending();
    assert_eq!(r.start_message_id.as_deref(), Some("c2"));
    assert!(!r.start_confirmed);
    let ev = h.events();
    assert!(
        matches!(&ev[0], RoundEvent::Ended { round, .. } if round.round_id == format!("{GID}:c1"))
    );
    assert!(matches!(
        &ev[1],
        RoundEvent::Started {
            start_confirmed: false,
            ..
        }
    ));
}

#[test]
fn unknown_send_has_no_resend_and_reconciles_only_on_evidence() {
    let mut h = Harness::new();
    h.message(customer("c1", 10_000));
    h.events();
    let intent = h.core.create_send_intent(GID, 11_000).unwrap();
    h.core.mark_submitted(&intent.local_id).unwrap();
    h.core
        .apply_send_result(&intent.local_id, SendDisposition::Unknown)
        .unwrap();
    // No path back to Pending/Submitted: that would be a resend.
    assert!(h
        .core
        .mark_submitted(&intent.local_id)
        .unwrap_err()
        .is(codes::IM_INTENT_STATE));
    // Read-back without the message: stays unknown, never rejected.
    assert_eq!(
        h.core.reconcile_unknown(&intent.local_id, &[]).unwrap(),
        ReconcileOutcome::StillUnknown
    );
    assert_eq!(h.core.outbox().unknown().count(), 1);
    h.waiting();
    // Read-back finds it: confirmed, round ends.
    let mut found = msg(
        "t1",
        12_000,
        SenderRole::MerchantSelf,
        MessageSource::History,
    );
    found.local_id = Some(intent.local_id.clone());
    assert!(matches!(
        h.core
            .reconcile_unknown(&intent.local_id, &[found])
            .unwrap(),
        ReconcileOutcome::Confirmed { .. }
    ));
    assert!(h.core.round_state(GID).is_idle());
    assert_eq!(
        ended_reason(&h.events()),
        Some(RoundEndReason::MerchantReplyConfirmed)
    );

    // Explicit rejection evidence.
    let intent2 = h.core.create_send_intent(GID, 13_000).unwrap();
    h.core.mark_submitted(&intent2.local_id).unwrap();
    h.core
        .apply_send_result(&intent2.local_id, SendDisposition::Unknown)
        .unwrap();
    let mut rejected = msg(
        "x",
        13_000,
        SenderRole::MerchantSelf,
        MessageSource::History,
    );
    rejected.message_id = None;
    rejected.local_id = Some(intent2.local_id.clone());
    rejected.disposition = Some(SendDisposition::Rejected {
        code: "E1".into(),
        reason: "denied".into(),
    });
    assert!(matches!(
        h.core
            .reconcile_unknown(&intent2.local_id, &[rejected])
            .unwrap(),
        ReconcileOutcome::Rejected { .. }
    ));
    assert_eq!(h.core.outbox().unknown().count(), 0);
}

// ------------------------------------------ §5 streams, generations, restart

#[test]
fn seq_gap_enters_reconciling_and_needs_resync() {
    let mut h = Harness::new();
    h.message(customer("c1", 10_000));
    h.events();
    assert_eq!(h.core.reconcile_state(), ReconcileState::Normal);

    h.seq[0] += 5; // skip
    let report = h.message(customer("c2", 20_000));
    assert!(!report.applied);
    assert!(matches!(report.dropped, Some(DropReason::Gap { .. })));
    assert_eq!(report.needs_resync, Some(StreamId::Message));
    assert_eq!(
        h.core.reconcile_state(),
        ReconcileState::Reconciling { generation: 1 }
    );
    assert!(h.core.index().find_by_message_id(GID, "c2").is_none());

    // Further envelopes on the broken stream are dropped.
    let report = h.message(customer("c3", 30_000));
    assert_eq!(report.dropped, Some(DropReason::AwaitingResync));
    // Other streams still apply, but rounds are frozen until the barrier
    // lifts: the round is kept, not cleared, during reconciliation.
    let report = h.conversation(conv(ConversationStatus::Finished, true, false));
    assert!(report.applied);
    h.waiting();
    assert!(h.events().is_empty());

    // Re-handshake: new epoch, numbering restarts at 1.
    h.epoch = 2;
    h.seq[0] = 0;
    h.core
        .resync_complete(StreamId::Message, StreamCursor::new(2, 0));
    assert_eq!(h.core.reconcile_state(), ReconcileState::Normal);
    assert_eq!(
        ended_reason(&h.events()),
        Some(RoundEndReason::ConversationFinished)
    );
    assert!(h.message(customer("c4", 40_000)).applied);
}

#[test]
fn epoch_change_needs_resync_and_duplicates_are_dropped() {
    let mut h = Harness::new();
    h.message(customer("c1", 10_000));
    let dup = h.core.ingest(FactEnvelope {
        account: ctx(1),
        stream: StreamId::Message,
        epoch: 1,
        seq: 1,
        fact: Fact::Message(customer("c1", 10_000)),
    });
    assert_eq!(dup.unwrap().dropped, Some(DropReason::DuplicateSeq));
    let changed = h.core.ingest(FactEnvelope {
        account: ctx(1),
        stream: StreamId::Message,
        epoch: 2,
        seq: 1,
        fact: Fact::Message(customer("c2", 20_000)),
    });
    let report = changed.unwrap();
    assert_eq!(report.dropped, Some(DropReason::EpochChanged));
    assert_eq!(report.needs_resync, Some(StreamId::Message));
    assert!(h.core.is_reconciling());
    assert_eq!(h.core.required_resyncs(), vec![StreamId::Message]);
}

#[test]
fn stale_generation_is_rejected_and_nothing_applied() {
    let mut h = Harness::new();
    h.core.invalidate_generation(ctx(2)).unwrap();
    h.core
        .resync_complete(StreamId::Message, StreamCursor::new(2, 0));
    h.core
        .resync_complete(StreamId::Conversation, StreamCursor::new(2, 0));
    let err = h
        .core
        .ingest(FactEnvelope {
            account: ctx(1),
            stream: StreamId::Message,
            epoch: 2,
            seq: 1,
            fact: Fact::Message(customer("c1", 10_000)),
        })
        .unwrap_err();
    assert!(err.is(contracts::codes::ACCOUNT_STALE_GENERATION));
    assert!(h.core.index().is_empty());
    assert_eq!(
        h.core.cursor(StreamId::Message),
        Some(StreamCursor::new(2, 0))
    );

    // A generation the core has not been told about is not accepted silently.
    let err = h
        .core
        .ingest(FactEnvelope {
            account: ctx(3),
            stream: StreamId::Message,
            epoch: 2,
            seq: 1,
            fact: Fact::Message(customer("c1", 10_000)),
        })
        .unwrap_err();
    assert!(err.is(codes::IM_GENERATION_MISMATCH));
}

#[test]
fn invalidate_generation_emits_invalidated_and_keeps_outbox_unknown() {
    let mut h = Harness::new();
    h.message(customer("c1", 10_000));
    let intent = h.core.create_send_intent(GID, 11_000).unwrap();
    h.core.mark_submitted(&intent.local_id).unwrap();
    h.events();

    assert!(h
        .core
        .invalidate_generation(ctx(1))
        .unwrap_err()
        .is(contracts::codes::ACCOUNT_STALE_GENERATION));
    h.core.invalidate_generation(ctx(2)).unwrap();
    let ev = h.events();
    assert_eq!(ev.len(), 1);
    assert!(
        matches!(&ev[0], RoundEvent::Invalidated { round } if round.account == ctx(1) && round.gid == GID)
    );
    assert!(h.core.round_state(GID).is_idle());
    assert!(h.core.active_rounds().next().is_none());
    assert_eq!(h.core.account(), &ctx(2));
    assert!(h.core.is_reconciling());
    assert!(h.core.index().is_empty());
    let entry = h.core.outbox().get(&intent.local_id).unwrap();
    assert_eq!(
        entry.state,
        SendState::Unknown,
        "in-flight send becomes unknown, not resent"
    );
    assert_eq!(entry.intent.account, ctx(2));
    // A late ACK for the old generation's send still reconciles the outbox.
    h.core
        .apply_send_result(
            &intent.local_id,
            SendDisposition::Confirmed {
                server_message_id: "t1".into(),
                server_time_ms: 12_000,
            },
        )
        .unwrap();
}

#[test]
fn missing_from_full_snapshot_is_pending_reread_not_deletion() {
    let mut h = Harness::new();
    h.message(customer("c1", 10_000));
    h.events();
    // Full snapshot that only lists another conversation.
    let mut other = conv(ConversationStatus::Active, true, true);
    other.gid = "group-0002".into();
    h.conversation(other);
    h.push(
        StreamId::Conversation,
        Fact::ConversationListSync {
            full: true,
            last_update_time_ms: Some(2_000),
        },
    );
    assert_eq!(h.core.pending_reread(), vec![GID.to_string()]);
    assert!(h
        .core
        .conversations()
        .get(GID)
        .unwrap()
        .is_missing_from_snapshot());
    assert!(
        h.core.eligible_for_reminder(GID),
        "absence is not proof of finished"
    );
    h.waiting();
    assert!(h.events().is_empty());
    assert_eq!(h.core.watermarks().list_cursor_ms(), Some(2_000));

    // Increments never mark anything missing.
    h.push(
        StreamId::Conversation,
        Fact::ConversationListSync {
            full: false,
            last_update_time_ms: Some(3_000),
        },
    );
    assert_eq!(h.core.pending_reread(), vec![GID.to_string()]);

    // Re-read says finished: ends with the server's reason.
    h.conversation(conv(ConversationStatus::Finished, true, false));
    assert!(h.core.pending_reread().is_empty());
    assert_eq!(
        ended_reason(&h.events()),
        Some(RoundEndReason::ConversationFinished)
    );
}

#[test]
fn restore_is_reconciling_with_pending_rounds_until_resync_and_fresh_facts() {
    let mut h = Harness::new();
    h.message(customer("c1", 10_000));
    let intent = h.core.create_send_intent(GID, 11_000).unwrap();
    h.core.mark_submitted(&intent.local_id).unwrap();
    h.core.prove_history_complete(GID, true, 10_000);
    h.events();
    let state = h.core.persisted_state();
    assert_eq!(state.rounds.len(), 1);
    assert_eq!(state.outbox.len(), 1);

    // Restart under a new session generation of the same identity.
    let mut core = ImCore::restore_as(state.clone(), ctx(2)).unwrap();
    assert!(core.is_reconciling());
    assert_eq!(
        core.required_resyncs(),
        vec![StreamId::Message, StreamId::Conversation]
    );
    let r = match core.round_state(GID) {
        RoundState::PendingVerification(r) => r.clone(),
        other => panic!("{other:?}"),
    };
    assert_eq!(r.round_id, format!("{GID}:c1"));
    assert!(!r.start_confirmed);
    assert_eq!(
        r.start_time_ms,
        Some(10_000),
        "persisted start is kept, not re-fabricated"
    );
    let ev = core.drain_round_events();
    assert!(
        matches!(&ev[..], [RoundEvent::Started { start_confirmed: false, round, .. }] if round.account == ctx(2))
    );
    assert_eq!(
        core.outbox().get(&intent.local_id).unwrap().state,
        SendState::Unknown
    );
    assert_eq!(core.sync_snapshot(), state.sync);

    // Fresh facts arrive but the barrier is still up: nothing promotes.
    let push = |core: &mut ImCore, stream: StreamId, seq: u64, fact: Fact| {
        core.ingest(FactEnvelope {
            account: ctx(2),
            stream,
            epoch: 1,
            seq,
            fact,
        })
        .unwrap()
    };
    push(
        &mut core,
        StreamId::Conversation,
        1,
        Fact::Conversation(conv(ConversationStatus::Active, true, true)),
    );
    push(
        &mut core,
        StreamId::Message,
        1,
        Fact::Message(msg("c1", 10_000, SenderRole::Customer, MessageSource::Init)),
    );
    assert!(core.round_state(GID).is_pending());
    assert!(core.drain_round_events().is_empty());

    core.resync_complete(StreamId::Message, StreamCursor::new(1, 1));
    assert!(core.is_reconciling(), "both streams must resync");
    core.resync_complete(StreamId::Conversation, StreamCursor::new(1, 1));
    assert_eq!(core.reconcile_state(), ReconcileState::Normal);
    match core.round_state(GID) {
        RoundState::Waiting(r) => {
            assert!(r.start_confirmed);
            assert_eq!(r.start_message_id.as_deref(), Some("c1"));
        }
        other => panic!("{other:?}"),
    }
    assert!(matches!(
        &core.drain_round_events()[..],
        [RoundEvent::StartConfirmed { .. }]
    ));

    // Identity mismatch is refused.
    let mut foreign = state;
    foreign.account = AccountContext::new(AccountId::new("other"), Environment::named("test"), 1);
    assert!(ImCore::restore_as(foreign, ctx(2))
        .unwrap_err()
        .is(codes::IM_ACCOUNT_MISMATCH));
}

#[test]
fn restore_then_readback_of_a_reply_ends_round_without_popping_first() {
    let mut h = Harness::new();
    h.message(customer("c1", 10_000));
    h.events();
    let state = h.core.persisted_state();
    let mut core = ImCore::restore(state);
    core.drain_round_events();
    let push = |core: &mut ImCore, stream: StreamId, seq: u64, fact: Fact| {
        core.ingest(FactEnvelope {
            account: ctx(1),
            stream,
            epoch: 7,
            seq,
            fact,
        })
        .unwrap()
    };
    push(
        &mut core,
        StreamId::Conversation,
        1,
        Fact::Conversation(conv(ConversationStatus::Active, true, true)),
    );
    // Answered by a colleague while we were down; the start message itself
    // is not read back.
    push(
        &mut core,
        StreamId::Message,
        1,
        Fact::Message(msg(
            "s1",
            12_000,
            SenderRole::MerchantOther,
            MessageSource::Init,
        )),
    );
    assert!(core.round_state(GID).is_pending());
    core.resync_complete(StreamId::Message, StreamCursor::new(7, 1));
    core.resync_complete(StreamId::Conversation, StreamCursor::new(7, 1));
    assert!(core.round_state(GID).is_idle());
    assert_eq!(
        ended_reason(&core.drain_round_events()),
        Some(RoundEndReason::MerchantReplyConfirmed)
    );
}

#[test]
fn restored_round_without_readback_stays_pending() {
    let mut h = Harness::new();
    h.message(customer("c1", 10_000));
    let state = h.core.persisted_state();
    let mut core = ImCore::restore(state);
    core.drain_round_events();
    core.ingest(FactEnvelope {
        account: ctx(1),
        stream: StreamId::Conversation,
        epoch: 1,
        seq: 1,
        fact: Fact::Conversation(conv(ConversationStatus::Active, true, true)),
    })
    .unwrap();
    core.resync_complete(StreamId::Message, StreamCursor::new(1, 0));
    core.resync_complete(StreamId::Conversation, StreamCursor::new(1, 1));
    // No message facts at all: neither confirmed nor silently cleared.
    assert!(core.round_state(GID).is_pending());
    assert!(core.drain_round_events().is_empty());
}

// --------------------------------------------------------- multi-account

#[test]
fn cores_route_by_identity_and_aggregate_unread() {
    let mut cores = ImCores::new();
    let a = ctx(1);
    let b = AccountContext::new(AccountId::new("acc-b"), Environment::named("test"), 4);
    cores.insert(ImCore::new(a.clone()));
    cores.insert(ImCore::new(b.clone()));
    assert_eq!(cores.len(), 2);

    let env = |account: &AccountContext, seq: u64, fact: Fact| FactEnvelope {
        account: account.clone(),
        stream: StreamId::Conversation,
        epoch: 1,
        seq,
        fact,
    };
    cores
        .ingest(env(
            &a,
            1,
            Fact::Conversation(conv(ConversationStatus::Active, true, false)),
        ))
        .unwrap();
    let mut other = conv(ConversationStatus::Active, true, false);
    other.unread_count = 7;
    cores.ingest(env(&b, 1, Fact::Conversation(other))).unwrap();
    assert_eq!(cores.total_unread(), 10);

    let unknown = AccountContext::new(AccountId::new("nobody"), Environment::named("test"), 1);
    assert!(cores
        .ingest(env(&unknown, 1, Fact::AuthInvalid))
        .unwrap_err()
        .is(contracts::codes::ACCOUNT_UNKNOWN));

    // Open clears unread for that account only; the round is untouched.
    cores
        .get_mut(&a)
        .unwrap()
        .ingest(FactEnvelope {
            account: a.clone(),
            stream: StreamId::Message,
            epoch: 1,
            seq: 1,
            fact: Fact::Message(customer("c1", 10_000)),
        })
        .unwrap();
    assert!(cores.get_mut(&a).unwrap().on_open_conversation(GID));
    assert_eq!(cores.total_unread(), 7);
    assert!(matches!(
        cores.get(&a).unwrap().round_state(GID),
        RoundState::Waiting(_)
    ));
    assert_eq!(cores.drain_round_events().len(), 1);

    // Generation advance through the map; the old context no longer routes
    // to a current core.
    cores.invalidate_generation(a.next_generation()).unwrap();
    assert!(cores
        .ingest(env(&a, 2, Fact::AuthInvalid))
        .unwrap_err()
        .is(contracts::codes::ACCOUNT_STALE_GENERATION));
    assert_eq!(cores.drain_round_events().len(), 1);
    assert_eq!(cores.get(&a).unwrap().account().session_generation, 2);
}

#[test]
fn auth_invalid_is_reported_not_acted_on() {
    let mut h = Harness::new();
    h.message(customer("c1", 10_000));
    h.events();
    let report = h.push(StreamId::Transport, Fact::AuthInvalid);
    assert!(report.auth_invalid);
    assert!(h.core.auth_invalid());
    h.waiting();
    assert!(h.events().is_empty());
}

// ------------------------------------------------------- QA regressions

#[test]
fn echo_after_local_rejection_confirms_outbox_and_index_and_clears_round() {
    // The SDK reported a failure, but the server echoes the message back
    // with our local id: the customer received it. Outbox and index must
    // both say confirmed and the round ends.
    let mut h = Harness::new();
    h.message(customer("c1", 10_000));
    h.events();
    let intent = h.core.create_send_intent(GID, 11_000).unwrap();
    h.core.mark_submitted(&intent.local_id).unwrap();
    h.core
        .apply_send_result(
            &intent.local_id,
            SendDisposition::Rejected {
                code: "E".into(),
                reason: "sdk".into(),
            },
        )
        .unwrap();
    h.waiting();
    let mut echo = msg(
        "t1",
        12_000,
        SenderRole::MerchantSelf,
        MessageSource::Realtime,
    );
    echo.local_id = Some(intent.local_id.clone());
    assert!(matches!(
        h.message(echo).message,
        Some(MergeOutcome::Linked { .. })
    ));
    assert!(h
        .core
        .index()
        .find_by_message_id(GID, "t1")
        .unwrap()
        .is_confirmed_merchant_reply());
    assert_eq!(
        h.core.outbox().get(&intent.local_id).unwrap().state,
        SendState::Confirmed {
            server_message_id: "t1".into(),
            server_time_ms: 12_000
        }
    );
    assert!(h.core.round_state(GID).is_idle());
    assert_eq!(
        ended_reason(&h.events()),
        Some(RoundEndReason::MerchantReplyConfirmed)
    );
    // Still no path to a resend afterwards.
    assert!(h.core.mark_submitted(&intent.local_id).is_err());
}

#[test]
fn sequence_exhaustion_at_u64_max_breaks_the_stream_instead_of_overflowing() {
    let mut h = Harness::new();
    let mut env = h.envelope(StreamId::Message, Fact::Message(customer("c1", 1)));
    env.seq = u64::MAX;
    assert!(h.core.ingest(env.clone()).unwrap().applied);
    env.fact = Fact::Message(customer("c2", 2));
    let rep = h.core.ingest(env.clone()).unwrap();
    assert!(!rep.applied);
    assert_eq!(
        rep.dropped,
        Some(DropReason::Gap {
            expected: u64::MAX,
            got: u64::MAX
        })
    );
    assert_eq!(rep.needs_resync, Some(StreamId::Message));
    assert!(h.core.is_reconciling());
    // Only a new epoch brings the stream back.
    h.core
        .resync_complete(StreamId::Message, StreamCursor::new(2, 0));
    env.epoch = 2;
    env.seq = 1;
    assert!(h.core.ingest(env).unwrap().applied);
    assert_eq!(h.core.reconcile_state(), ReconcileState::Normal);
}

#[test]
fn reply_sent_before_the_customer_message_was_indexed_is_judged_by_server_order() {
    // Restart: the index is empty, the agent answers from the web page at
    // once (intent without a customer boundary), then compensation brings
    // the customer message that was stamped *before* the reply.
    let mut h = Harness::new();
    let intent = h.core.create_send_intent(GID, 20_000).unwrap();
    assert_eq!(intent.customer_boundary_message_id, None);
    h.core.mark_submitted(&intent.local_id).unwrap();
    h.core
        .apply_send_result(
            &intent.local_id,
            SendDisposition::Confirmed {
                server_message_id: "t1".into(),
                server_time_ms: 20_000,
            },
        )
        .unwrap();
    h.message(msg(
        "c1",
        10_000,
        SenderRole::Customer,
        MessageSource::Compensation,
    ));
    assert!(
        h.core.round_state(GID).is_idle(),
        "c1 was answered: no false alarm"
    );
    assert!(h.events().is_empty());
    // Proactive message, then a customer message stamped *after* it: a
    // round starts (the reply cannot have answered it).
    h.message(customer("c2", 30_000));
    assert_eq!(h.waiting().start_message_id.as_deref(), Some("c2"));
    assert_eq!(h.events().len(), 1);
    // Equal stamps stay ambiguous (待核对), never cleared.
    let mut h2 = Harness::new();
    let i2 = h2.core.create_send_intent(GID, 5_000).unwrap();
    h2.core.mark_submitted(&i2.local_id).unwrap();
    h2.core
        .apply_send_result(
            &i2.local_id,
            SendDisposition::Confirmed {
                server_message_id: "t2".into(),
                server_time_ms: 5_000,
            },
        )
        .unwrap();
    h2.message(customer("c3", 5_000));
    assert!(!h2.pending().start_confirmed);
}

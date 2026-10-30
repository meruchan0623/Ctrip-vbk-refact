//! Shared fixtures for the QA scenario tests. Synthetic data only: no
//! credentials, no customer text, no real ids.
#![allow(dead_code, clippy::unwrap_used)]

use contracts::{
    AccountContext, AccountId, ConversationFact, ConversationStatus, Environment, MessageFact,
    MessageSource, MsgKind, RoundEndReason, RoundEvent, SenderRole,
};
use core_im::{Fact, FactEnvelope, ImCore, IngestReport, Round, RoundState, StreamId};
use core_notify::{Effect, NotifyCore, Now, Sound};

pub const GID: &str = "group-0001";
pub const GID2: &str = "group-0002";
pub const T0_SERVER: i64 = 1_700_000_000_000;
pub const T1_MS: i64 = 30_000;

pub fn ctx(id: &str, env: &str, generation: u64) -> AccountContext {
    AccountContext::new(AccountId::new(id), Environment::named(env), generation)
}

/// The default test identity `(test, acc-test)` at `generation`.
pub fn acc(generation: u64) -> AccountContext {
    ctx("acc-test", "test", generation)
}

pub fn msg_in(gid: &str, mid: &str, t: i64, role: SenderRole, src: MessageSource) -> MessageFact {
    MessageFact {
        gid: gid.into(),
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

pub fn customer_in(gid: &str, mid: &str, t: i64) -> MessageFact {
    msg_in(gid, mid, t, SenderRole::Customer, MessageSource::Realtime)
}

pub fn customer(mid: &str, t: i64) -> MessageFact {
    customer_in(GID, mid, t)
}

pub fn conv_for(
    gid: &str,
    status: ConversationStatus,
    in_group: bool,
    full: bool,
) -> ConversationFact {
    ConversationFact {
        gid: gid.into(),
        status,
        agent_in_group: in_group,
        is_owner: true,
        service_type: "1513".into(),
        last_message_time_ms: None,
        last_update_time_ms: Some(1_000),
        unread_count: 1,
        is_full_snapshot: full,
    }
}

pub fn conv(status: ConversationStatus, in_group: bool, full: bool) -> ConversationFact {
    conv_for(GID, status, in_group, full)
}

/// Drives one `ImCore` with per-stream sequence numbers.
pub struct ImHarness {
    pub core: ImCore,
    pub account: AccountContext,
    pub epoch: u64,
    pub seq: [u64; 3],
}

impl ImHarness {
    /// A core with an eligible `GID` conversation already known.
    pub fn new() -> Self {
        Self::with_account(acc(1))
    }

    pub fn with_account(account: AccountContext) -> Self {
        let mut h = Self::bare(account);
        h.conversation(conv(ConversationStatus::Active, true, false));
        h
    }

    /// A core without any conversation fact.
    pub fn bare(account: AccountContext) -> Self {
        Self {
            core: ImCore::new(account.clone()),
            account,
            epoch: 1,
            seq: [0; 3],
        }
    }

    /// Wraps a restored core; sequence numbers start fresh.
    pub fn from_core(core: ImCore) -> Self {
        let account = core.account().clone();
        Self {
            core,
            account,
            epoch: 1,
            seq: [0; 3],
        }
    }

    fn idx(stream: StreamId) -> usize {
        match stream {
            StreamId::Message => 0,
            StreamId::Conversation => 1,
            StreamId::Transport => 2,
        }
    }

    pub fn envelope(&mut self, stream: StreamId, fact: Fact) -> FactEnvelope {
        let i = Self::idx(stream);
        self.seq[i] += 1;
        FactEnvelope {
            account: self.account.clone(),
            stream,
            epoch: self.epoch,
            seq: self.seq[i],
            fact,
        }
    }

    /// Skips `n` sequence numbers on `stream` (simulates lost envelopes).
    pub fn skip(&mut self, stream: StreamId, n: u64) {
        self.seq[Self::idx(stream)] += n;
    }

    pub fn push(&mut self, stream: StreamId, fact: Fact) -> IngestReport {
        let env = self.envelope(stream, fact);
        self.core.ingest(env).unwrap()
    }

    pub fn try_push(
        &mut self,
        stream: StreamId,
        fact: Fact,
    ) -> Result<IngestReport, contracts::AppError> {
        let env = self.envelope(stream, fact);
        self.core.ingest(env)
    }

    pub fn message(&mut self, fact: MessageFact) -> IngestReport {
        self.push(StreamId::Message, Fact::Message(fact))
    }

    pub fn conversation(&mut self, fact: ConversationFact) -> IngestReport {
        self.push(StreamId::Conversation, Fact::Conversation(fact))
    }

    pub fn events(&mut self) -> Vec<RoundEvent> {
        self.core.drain_round_events()
    }

    pub fn waiting(&self) -> &Round {
        self.waiting_for(GID)
    }

    pub fn waiting_for(&self, gid: &str) -> &Round {
        match self.core.round_state(gid) {
            RoundState::Waiting(r) => r,
            other => panic!("expected Waiting for {gid}, got {other:?}"),
        }
    }

    pub fn pending(&self) -> &Round {
        match self.core.round_state(GID) {
            RoundState::PendingVerification(r) => r,
            other => panic!("expected PendingVerification, got {other:?}"),
        }
    }
}

pub fn ended_reason(events: &[RoundEvent]) -> Option<RoundEndReason> {
    events.iter().find_map(|e| match e {
        RoundEvent::Ended { reason, .. } => Some(*reason),
        _ => None,
    })
}

pub fn count_ended(events: &[RoundEvent]) -> usize {
    events
        .iter()
        .filter(|e| matches!(e, RoundEvent::Ended { .. }))
        .count()
}

pub fn count_started(events: &[RoundEvent]) -> usize {
    events
        .iter()
        .filter(|e| matches!(e, RoundEvent::Started { .. }))
        .count()
}

// ----------------------------------------------------------------- notify

pub fn now_at(monotonic_ms: u64, server_now_ms: i64, trusted: bool) -> Now {
    Now::new(monotonic_ms, server_now_ms, trusted)
}

/// `Now` whose server axis equals the im fixture clock: `server == monotonic
/// + T0_SERVER`, so a message at `T0_SERVER + x` waited `now.monotonic - x`.
pub fn clock(ms: u64) -> Now {
    Now::new(ms, T0_SERVER + ms as i64, true)
}

/// Applies every round event to the notify core at `now`.
pub fn feed(notify: &mut NotifyCore, events: Vec<RoundEvent>, now: &Now) -> Vec<Effect> {
    let mut out = Vec::new();
    for e in events {
        out.extend(notify.apply_round_event(e, now));
    }
    out
}

/// Ticks at 1 Hz for seconds `from_s+1 ..= to_s` after `base`.
pub fn drive(core: &mut NotifyCore, base: &Now, from_s: u64, to_s: u64) -> Vec<Effect> {
    let mut all = Vec::new();
    for s in (from_s + 1)..=to_s {
        all.extend(core.tick(&base.plus_ms(s * 1000)));
    }
    all
}

pub fn raises(effects: &[Effect]) -> usize {
    effects
        .iter()
        .filter(|e| matches!(e, Effect::ShowAlarm { raise: true }))
        .count()
}

pub fn shows(effects: &[Effect]) -> usize {
    effects
        .iter()
        .filter(|e| matches!(e, Effect::ShowAlarm { .. }))
        .count()
}

pub fn sounds(effects: &[Effect], sound: Sound) -> usize {
    effects
        .iter()
        .filter(|e| **e == Effect::PlaySound(sound))
        .count()
}

pub fn has(effects: &[Effect], wanted: &Effect) -> bool {
    effects.iter().any(|e| e == wanted)
}

pub fn count(effects: &[Effect], wanted: &Effect) -> usize {
    effects.iter().filter(|e| *e == wanted).count()
}

/// Deterministic LCG for fuzz-ish loops (std only).
pub struct Lcg(pub u64);

impl Lcg {
    pub fn new(seed: u64) -> Self {
        Self(seed)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0 >> 11
    }

    pub fn below(&mut self, n: u64) -> u64 {
        self.next_u64() % n.max(1)
    }

    pub fn i64(&mut self) -> i64 {
        self.next_u64() as i64 ^ (self.next_u64() << 53) as i64
    }
}

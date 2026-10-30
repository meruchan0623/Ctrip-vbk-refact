//! `ImCore` (one per `AccountContext`) and `ImCores` (one per persistent
//! identity, holding the current generation).
//!
//! Pure domain: no I/O, no clocks. Callers pass times and `ClockReading`s.

use std::collections::{BTreeMap, BTreeSet};

use contracts::events::CursorStep;
use contracts::{
    codes as shared_codes, AccountContext, AccountId, AppError, ConversationStatus, Environment,
    MessageFact, MessageSource, MsgKind, ReconcileState, RoundEndReason, RoundEvent,
    SendDisposition, SenderRole, StreamCursor,
};

use crate::codes;
use crate::conversations::ConversationRegistry;
use crate::dedup::{MessageIndex, MessageRecord};
use crate::ingest::{DropReason, Fact, FactEnvelope, IngestReport, StreamId, TransportState};
use crate::outbox::{Outbox, OutboxEntry, ReconcileOutcome, SendIntent, SendState};
use crate::rounds::{
    evaluate, BusinessLineRule, BusinessLineRules, Coverage, Eligibility, Evaluation,
    PersistedRound, RoundState, RoundTracker,
};
use crate::watermarks::{SyncStateSnapshot, SyncWatermarks};

/// Minimal persisted state of one core (dev 05-store). The store crate owns
/// serialization; this is a plain struct.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersistedImState {
    pub account: AccountContext,
    pub sync: SyncStateSnapshot,
    pub rounds: Vec<PersistedRound>,
    pub outbox: Vec<OutboxEntry>,
    pub round_seq: u64,
    pub local_seq: u64,
    /// Already-masked labels, `(gid, label)`.
    pub labels: Vec<(String, String)>,
}

/// IM domain state of one account generation.
#[derive(Debug, Clone)]
pub struct ImCore {
    account: AccountContext,
    cursors: BTreeMap<StreamId, StreamCursor>,
    /// Streams whose cursor broke (gap / epoch change); envelopes are dropped
    /// until `resync_complete`.
    cursor_broken: BTreeSet<StreamId>,
    /// Streams that must complete a resync before rounds are evaluated
    /// again (reconcile barrier, strong-alert §5).
    required_resyncs: BTreeSet<StreamId>,
    reconcile: ReconcileState,
    reconcile_generation: u64,
    index: MessageIndex,
    conversations: ConversationRegistry,
    watermarks: SyncWatermarks,
    outbox: Outbox,
    rounds: RoundTracker,
    rules: BusinessLineRules,
    transport: Option<TransportState>,
    auth_invalid: bool,
    local_seq: u64,
}

impl ImCore {
    pub fn new(account: AccountContext) -> Self {
        Self {
            rounds: RoundTracker::new(account.clone()),
            account,
            cursors: BTreeMap::new(),
            cursor_broken: BTreeSet::new(),
            required_resyncs: BTreeSet::new(),
            reconcile: ReconcileState::Normal,
            reconcile_generation: 0,
            index: MessageIndex::new(),
            conversations: ConversationRegistry::new(),
            watermarks: SyncWatermarks::new(),
            outbox: Outbox::new(),
            rules: BusinessLineRules::new(),
            transport: None,
            auth_invalid: false,
            local_seq: 0,
        }
    }

    /// Restore under the persisted account context. See [`Self::restore_as`].
    pub fn restore(snapshot: PersistedImState) -> Self {
        let account = snapshot.account.clone();
        Self::restore_with(snapshot, account)
    }

    /// Restore under a re-authenticated context of the same persistent
    /// identity (a new `session_generation` must not drop the outbox or
    /// rounds). The core starts in `Reconciling` with every round in
    /// `PendingVerification`; only `resync_complete` for the message and
    /// conversation streams plus fresh facts promote them.
    pub fn restore_as(
        snapshot: PersistedImState,
        account: AccountContext,
    ) -> Result<Self, AppError> {
        if snapshot.account.persistent_key() != account.persistent_key() {
            return Err(AppError::new(
                codes::IM_ACCOUNT_MISMATCH,
                "snapshot belongs to another identity",
            ));
        }
        if account.session_generation < snapshot.account.session_generation {
            return Err(AppError::new(
                shared_codes::ACCOUNT_STALE_GENERATION,
                "restore context older than snapshot",
            ));
        }
        Ok(Self::restore_with(snapshot, account))
    }

    fn restore_with(snapshot: PersistedImState, account: AccountContext) -> Self {
        let mut core = Self::new(account.clone());
        core.watermarks = SyncWatermarks::from_snapshot(snapshot.sync);
        core.outbox = Outbox::from_entries(
            snapshot
                .outbox
                .into_iter()
                .map(|mut e| {
                    e.intent.account = account.clone();
                    // A send that was in flight when the process died has an
                    // unknown outcome; never a candidate for resend.
                    if matches!(e.state, SendState::Pending | SendState::Submitted) {
                        e.state = SendState::Unknown;
                    }
                    e
                })
                .collect(),
        );
        core.local_seq = snapshot.local_seq;
        core.rounds.set_seq(snapshot.round_seq);
        for (gid, label) in snapshot.labels {
            core.rounds.set_label(&gid, label);
        }
        for round in snapshot.rounds {
            core.rounds.restore_round(round);
        }
        core.required_resyncs.insert(StreamId::Message);
        core.required_resyncs.insert(StreamId::Conversation);
        core.enter_reconciling();
        core
    }

    /// Plain persisted form (store crate persists it).
    pub fn persisted_state(&self) -> PersistedImState {
        PersistedImState {
            account: self.account.clone(),
            sync: self.watermarks.snapshot(),
            rounds: self.rounds.persisted(),
            outbox: self.outbox.entries().cloned().collect(),
            round_seq: self.rounds.seq(),
            local_seq: self.local_seq,
            labels: Vec::new(),
        }
    }

    // ------------------------------------------------------------ accessors

    pub fn account(&self) -> &AccountContext {
        &self.account
    }

    pub fn reconcile_state(&self) -> ReconcileState {
        self.reconcile
    }

    pub fn is_reconciling(&self) -> bool {
        matches!(self.reconcile, ReconcileState::Reconciling { .. })
    }

    pub fn cursor(&self, stream: StreamId) -> Option<StreamCursor> {
        self.cursors.get(&stream).copied()
    }

    pub fn transport_state(&self) -> Option<TransportState> {
        self.transport
    }

    pub fn auth_invalid(&self) -> bool {
        self.auth_invalid
    }

    pub fn index(&self) -> &MessageIndex {
        &self.index
    }

    pub fn conversations(&self) -> &ConversationRegistry {
        &self.conversations
    }

    pub fn watermarks(&self) -> &SyncWatermarks {
        &self.watermarks
    }

    pub fn sync_snapshot(&self) -> SyncStateSnapshot {
        self.watermarks.snapshot()
    }

    pub fn outbox(&self) -> &Outbox {
        &self.outbox
    }

    pub fn round_state(&self, gid: &str) -> &RoundState {
        self.rounds.state(gid)
    }

    /// `(gid, state)` for every conversation holding a round.
    pub fn active_rounds(&self) -> impl Iterator<Item = (&str, &RoundState)> {
        self.rounds.active()
    }

    pub fn drain_round_events(&mut self) -> Vec<RoundEvent> {
        self.rounds.drain_events()
    }

    /// `Active && agent_in_group` and not excluded by a business-line rule.
    pub fn eligible_for_reminder(&self, gid: &str) -> bool {
        matches!(self.eligibility(gid), Eligibility::Eligible)
    }

    pub fn unread(&self, gid: &str) -> u32 {
        self.conversations.unread(gid)
    }

    pub fn total_unread(&self) -> u32 {
        self.conversations.total_unread()
    }

    /// Conversations missing from the last full snapshot that need
    /// `getConversationInfoByGidList`.
    pub fn pending_reread(&self) -> Vec<String> {
        self.conversations.pending_reread()
    }

    pub fn business_line_rules(&self) -> &BusinessLineRules {
        &self.rules
    }

    pub fn set_business_line_rule(
        &mut self,
        service_type: impl Into<String>,
        rule: BusinessLineRule,
    ) {
        self.rules.set(service_type, rule);
        self.reconcile_all();
    }

    /// Supply an already-masked label for `RoundEvent::Started`.
    pub fn set_conversation_label(&mut self, gid: &str, masked_label: impl Into<String>) {
        self.rounds.set_label(gid, masked_label);
    }

    // --------------------------------------------------------------- ingest

    /// Apply one adapter envelope.
    ///
    /// * older generation → `account.stale_generation`, nothing applied;
    /// * other identity / newer generation → `im.generation_mismatch`;
    /// * per-stream cursor: `Duplicate` dropped, `Gap`/`EpochChanged` enter
    ///   `Reconciling` and report `needs_resync`.
    pub fn ingest(&mut self, env: FactEnvelope) -> Result<IngestReport, AppError> {
        self.check_generation(&env.account)?;
        let mut report = IngestReport::default();
        let stream = env.stream;
        let next = env.cursor();

        if self.cursor_broken.contains(&stream) {
            report.dropped = Some(DropReason::AwaitingResync);
            report.needs_resync = Some(stream);
            return Ok(report);
        }
        if let Some(cur) = self.cursors.get(&stream).copied() {
            match cur.classify(next) {
                CursorStep::Next => {}
                CursorStep::Duplicate => {
                    report.dropped = Some(DropReason::DuplicateSeq);
                    return Ok(report);
                }
                CursorStep::Gap { expected, got } => {
                    self.break_stream(stream);
                    report.dropped = Some(DropReason::Gap { expected, got });
                    report.needs_resync = Some(stream);
                    return Ok(report);
                }
                CursorStep::EpochChanged => {
                    self.break_stream(stream);
                    report.dropped = Some(DropReason::EpochChanged);
                    report.needs_resync = Some(stream);
                    return Ok(report);
                }
            }
        }
        self.cursors.insert(stream, next);

        let before = self.rounds.pending_events();
        match env.fact {
            Fact::Message(fact) => {
                let outcome = self.index.merge(&fact)?;
                if outcome.is_change() {
                    self.watermarks
                        .note_message_seen(&fact.gid, fact.create_time_ms);
                    self.absorb_ack_evidence(&fact);
                    self.reconcile_gid(&fact.gid);
                }
                report.message = Some(outcome);
            }
            Fact::Conversation(fact) => {
                self.conversations.apply(&fact);
                self.reconcile_gid(&fact.gid);
            }
            Fact::ConversationListSync {
                full,
                last_update_time_ms,
            } => {
                self.watermarks.note_list_sync(last_update_time_ms);
                if full {
                    self.conversations.complete_full_snapshot();
                } else {
                    self.conversations.complete_increment();
                }
            }
            Fact::CompensationSync {
                last_message_timestamp_ms,
            } => {
                self.watermarks
                    .note_compensation_sync(last_message_timestamp_ms);
            }
            Fact::Transport(state) => {
                self.transport = Some(state);
            }
            Fact::AuthInvalid => {
                self.auth_invalid = true;
                report.auth_invalid = true;
            }
        }
        report.applied = true;
        report.round_events = self.rounds.pending_events().saturating_sub(before);
        if self.is_reconciling() {
            report.needs_resync = self.required_resyncs.iter().next().copied();
        }
        Ok(report)
    }

    /// The caller re-handshook `stream`; `new_cursor` is the position just
    /// before the first envelope it will deliver next. When no stream is
    /// pending any more the barrier lifts and every round is re-evaluated.
    pub fn resync_complete(&mut self, stream: StreamId, new_cursor: StreamCursor) {
        self.cursors.insert(stream, new_cursor);
        self.cursor_broken.remove(&stream);
        self.required_resyncs.remove(&stream);
        if self.required_resyncs.is_empty() && self.is_reconciling() {
            self.reconcile = ReconcileState::Normal;
            self.reconcile_all();
        }
    }

    /// Streams still awaiting `resync_complete`.
    pub fn required_resyncs(&self) -> Vec<StreamId> {
        self.required_resyncs.iter().copied().collect()
    }

    /// Identity generation advanced (logout / replace / ticket expired).
    /// Emits `Invalidated` for every round and drops in-flight state. The
    /// outbox is kept (persisted unknowns are reconciled later), re-bound to
    /// the new context.
    pub fn invalidate_generation(&mut self, new_ctx: AccountContext) -> Result<(), AppError> {
        if new_ctx.persistent_key() != self.account.persistent_key() {
            return Err(AppError::new(
                codes::IM_ACCOUNT_MISMATCH,
                "new context is another identity",
            ));
        }
        if new_ctx.session_generation <= self.account.session_generation {
            return Err(AppError::new(
                shared_codes::ACCOUNT_STALE_GENERATION,
                "new generation is not newer",
            ));
        }
        self.rounds.invalidate(new_ctx.clone());
        let kept: Vec<OutboxEntry> = self
            .outbox
            .entries()
            .cloned()
            .map(|mut e| {
                e.intent.account = new_ctx.clone();
                if matches!(e.state, SendState::Pending | SendState::Submitted) {
                    e.state = SendState::Unknown;
                }
                e
            })
            .collect();
        self.outbox = Outbox::from_entries(kept);
        self.account = new_ctx;
        self.cursors.clear();
        self.cursor_broken.clear();
        self.index = MessageIndex::new();
        self.conversations = ConversationRegistry::new();
        self.transport = None;
        self.auth_invalid = false;
        self.required_resyncs.insert(StreamId::Message);
        self.required_resyncs.insert(StreamId::Conversation);
        self.enter_reconciling();
        Ok(())
    }

    // --------------------------------------------------------------- outbox

    /// Create an immutable send intent for `gid` at `now_ms`, freezing the
    /// current round and the newest known customer message. The caller
    /// persists it before submitting.
    pub fn create_send_intent(&mut self, gid: &str, now_ms: i64) -> Result<SendIntent, AppError> {
        self.local_seq = self.local_seq.saturating_add(1);
        let local_id = format!(
            "{}-{}-{}",
            self.account.account_id, self.account.session_generation, self.local_seq
        );
        let round = self.rounds.state(gid).round();
        let intent = SendIntent {
            local_id,
            gid: gid.to_string(),
            account: self.account.clone(),
            created_at_ms: now_ms,
            frozen_round_id: round.map(|r| r.round_id.clone()),
            frozen_round_version: round.map(|r| r.version),
            customer_boundary_message_id: self
                .index
                .latest_customer_business(gid)
                .and_then(|m| m.message_id.clone()),
        };
        self.outbox.insert(intent.clone())?;
        Ok(intent)
    }

    /// The intent was handed to the transport. Never ends a round.
    pub fn mark_submitted(&mut self, local_id: &str) -> Result<(), AppError> {
        self.outbox.mark_submitted(local_id)?;
        let Some(entry) = self.outbox.get(local_id) else {
            return Ok(());
        };
        let fact = MessageFact {
            gid: entry.intent.gid.clone(),
            message_id: None,
            local_id: Some(local_id.to_string()),
            create_time_ms: entry.intent.created_at_ms,
            sender_role: SenderRole::MerchantSelf,
            sender_id: self.account.account_id.as_str().to_string(),
            kind: MsgKind::Business,
            source: MessageSource::Realtime,
            disposition: Some(SendDisposition::Unknown),
        };
        self.index.merge(&fact)?;
        Ok(())
    }

    /// Alias of [`Self::mark_submitted`] (rule e: never ends a round).
    pub fn on_send_submitted(&mut self, local_id: &str) -> Result<(), AppError> {
        self.mark_submitted(local_id)
    }

    /// Apply `send_result` / read-back. `Confirmed` merges the server id and
    /// time into the index and re-evaluates the round: the reply only covers
    /// customer messages up to the intent's boundary.
    pub fn apply_send_result(
        &mut self,
        local_id: &str,
        disposition: SendDisposition,
    ) -> Result<SendState, AppError> {
        let state = self.outbox.apply_send_result(local_id, disposition)?;
        self.sync_outbox_into_index(local_id)?;
        Ok(state)
    }

    /// Reconcile an unknown send against server facts read back for its
    /// conversation. No resend path exists; `StillUnknown` stays persisted.
    pub fn reconcile_unknown(
        &mut self,
        local_id: &str,
        server_facts: &[MessageFact],
    ) -> Result<ReconcileOutcome, AppError> {
        let outcome = self.outbox.reconcile_unknown(local_id, server_facts)?;
        self.sync_outbox_into_index(local_id)?;
        Ok(outcome)
    }

    fn sync_outbox_into_index(&mut self, local_id: &str) -> Result<(), AppError> {
        let Some(entry) = self.outbox.get(local_id).cloned() else {
            return Ok(());
        };
        let (message_id, create_time_ms, disposition) = match &entry.state {
            SendState::Confirmed {
                server_message_id,
                server_time_ms,
            } => (
                Some(server_message_id.clone()),
                *server_time_ms,
                Some(SendDisposition::Confirmed {
                    server_message_id: server_message_id.clone(),
                    server_time_ms: *server_time_ms,
                }),
            ),
            SendState::Rejected { code, reason } => (
                None,
                entry.intent.created_at_ms,
                Some(SendDisposition::Rejected {
                    code: code.clone(),
                    reason: reason.clone(),
                }),
            ),
            SendState::Unknown | SendState::Submitted => (
                None,
                entry.intent.created_at_ms,
                Some(SendDisposition::Unknown),
            ),
            SendState::Pending => return Ok(()),
        };
        let fact = MessageFact {
            gid: entry.intent.gid.clone(),
            message_id,
            local_id: Some(local_id.to_string()),
            create_time_ms,
            sender_role: SenderRole::MerchantSelf,
            sender_id: self.account.account_id.as_str().to_string(),
            kind: MsgKind::Business,
            source: MessageSource::Realtime,
            disposition,
        };
        if self.index.merge(&fact)?.is_change() {
            self.watermarks
                .note_message_seen(&fact.gid, fact.create_time_ms);
            self.reconcile_gid(&fact.gid);
        }
        Ok(())
    }

    /// An inbound fact that carries our `local_id` with a server id is
    /// evidence that an unknown/submitted send was accepted (回推先于 ACK).
    fn absorb_ack_evidence(&mut self, fact: &MessageFact) {
        let (Some(lid), Some(mid)) = (&fact.local_id, &fact.message_id) else {
            return;
        };
        let Some(entry) = self.outbox.get(lid) else {
            return;
        };
        if matches!(entry.state, SendState::Submitted | SendState::Unknown) {
            // Cannot fail: the entry exists and is not final.
            let _ = self.outbox.apply_send_result(
                lid,
                SendDisposition::Confirmed {
                    server_message_id: mid.clone(),
                    server_time_ms: fact.create_time_ms,
                },
            );
        }
    }

    // ------------------------------------------------------- user actions

    /// Read receipt sent/observed. Never ends a round.
    pub fn on_read(&mut self, _gid: &str, _up_to_message_id: Option<&str>) {}

    /// Conversation opened: clears local unread; never ends a round.
    pub fn on_open_conversation(&mut self, gid: &str) -> bool {
        self.conversations.clear_unread(gid)
    }

    /// Send button clicked. Never ends a round.
    pub fn on_send_clicked(&mut self, _gid: &str) {}

    // ------------------------------------------------------------ history

    /// A `getMessageList` page landed (messages themselves arrive as facts).
    pub fn note_history_page(
        &mut self,
        gid: &str,
        oldest_in_page_ms: i64,
        next_breakpoint_ms: Option<i64>,
    ) {
        self.watermarks
            .note_history_page(gid, oldest_in_page_ms, next_breakpoint_ms);
        self.reconcile_gid(gid);
    }

    /// The server's `rangeMessage.isDone` for a backward page. The only way
    /// the complete watermark advances; confirms pending starts.
    pub fn prove_history_complete(
        &mut self,
        gid: &str,
        is_done_from_server: bool,
        oldest_ms: i64,
    ) -> bool {
        let advanced = self
            .watermarks
            .prove_history_complete(gid, is_done_from_server, oldest_ms);
        self.reconcile_gid(gid);
        advanced
    }

    // ----------------------------------------------------------- internals

    fn check_generation(&self, incoming: &AccountContext) -> Result<(), AppError> {
        if self.account.is_stale_generation_of(incoming) {
            return Err(AppError::new(
                shared_codes::ACCOUNT_STALE_GENERATION,
                "envelope from an older generation",
            )
            .with_detail(format!(
                "core={} envelope={}",
                self.account.session_generation, incoming.session_generation
            )));
        }
        if !self.account.is_current_for(incoming) {
            return Err(AppError::new(
                codes::IM_GENERATION_MISMATCH,
                "envelope is not for this core generation",
            ));
        }
        Ok(())
    }

    fn enter_reconciling(&mut self) {
        if !self.is_reconciling() {
            self.reconcile_generation = self.reconcile_generation.saturating_add(1);
            self.reconcile = ReconcileState::Reconciling {
                generation: self.reconcile_generation,
            };
        }
    }

    fn break_stream(&mut self, stream: StreamId) {
        self.cursor_broken.insert(stream);
        self.required_resyncs.insert(stream);
        self.enter_reconciling();
    }

    fn frozen(&self) -> bool {
        !self.required_resyncs.is_empty()
    }

    fn eligibility(&self, gid: &str) -> Eligibility {
        let Some(entry) = self.conversations.get(gid) else {
            return Eligibility::Unknown;
        };
        if self.rules.rule_for(&entry.service_type) == BusinessLineRule::Excluded {
            return Eligibility::NotEligible(RoundEndReason::NotEligible);
        }
        if entry.is_reminder_eligible() {
            return Eligibility::Eligible;
        }
        Eligibility::NotEligible(match entry.status {
            ConversationStatus::Finished => RoundEndReason::ConversationFinished,
            ConversationStatus::TransferredOut => RoundEndReason::TransferredOut,
            ConversationStatus::Active | ConversationStatus::Unknown => RoundEndReason::NotEligible,
        })
    }

    fn evaluate_gid(&self, gid: &str) -> (Evaluation, bool) {
        let ordered = self.index.ordered(gid);
        let positions: BTreeMap<&str, usize> = ordered
            .iter()
            .enumerate()
            .filter_map(|(i, m)| m.message_id.as_deref().map(|id| (id, i)))
            .collect();
        let outbox = &self.outbox;
        let coverage = |reply: &MessageRecord, customer: &MessageRecord| -> Coverage {
            let by_time = if customer.create_time_ms < reply.create_time_ms {
                Coverage::Covered
            } else if customer.create_time_ms == reply.create_time_ms {
                Coverage::Ambiguous
            } else {
                Coverage::NotCovered
            };
            let Some(intent) = reply.local_id.as_deref().and_then(|lid| outbox.get(lid)) else {
                return by_time;
            };
            // Own send with a frozen boundary: covers only customer messages
            // the agent could have seen when composing.
            let Some(boundary) = intent.intent.customer_boundary_message_id.as_deref() else {
                return Coverage::NotCovered;
            };
            let (Some(bpos), Some(cpos)) = (
                positions.get(boundary),
                customer
                    .message_id
                    .as_deref()
                    .and_then(|id| positions.get(id)),
            ) else {
                return if by_time == Coverage::NotCovered {
                    Coverage::NotCovered
                } else {
                    Coverage::Ambiguous
                };
            };
            if cpos > bpos {
                return Coverage::NotCovered;
            }
            match by_time {
                Coverage::Covered | Coverage::Ambiguous => Coverage::Covered,
                Coverage::NotCovered => Coverage::Ambiguous,
            }
        };
        let eval = evaluate(&ordered, self.watermarks.paged_history(gid), &coverage);
        let start_known = self
            .rounds
            .state(gid)
            .round()
            .and_then(|r| r.start_message_id.as_deref())
            .is_some_and(|id| positions.contains_key(id));
        (eval, start_known)
    }

    fn reconcile_gid(&mut self, gid: &str) {
        if self.frozen() {
            return;
        }
        let eligibility = self.eligibility(gid);
        let (eval, start_known) = self.evaluate_gid(gid);
        self.rounds.reconcile(gid, eligibility, &eval, start_known);
    }

    fn reconcile_all(&mut self) {
        if self.frozen() {
            return;
        }
        let mut gids: BTreeSet<String> = self.index.gids().map(str::to_string).collect();
        gids.extend(self.rounds.active().map(|(g, _)| g.to_string()));
        gids.extend(self.conversations.entries().map(|e| e.gid.clone()));
        for gid in gids {
            self.reconcile_gid(&gid);
        }
    }
}

/// Cores keyed by persistent identity `(environment, account_id)`; each
/// holds the current generation for that identity.
#[derive(Debug, Default)]
pub struct ImCores {
    cores: BTreeMap<(Environment, AccountId), ImCore>,
}

impl ImCores {
    pub fn new() -> Self {
        Self::default()
    }

    fn key_of(ctx: &AccountContext) -> (Environment, AccountId) {
        (ctx.environment.clone(), ctx.account_id.clone())
    }

    /// Insert (or replace) the core for its persistent identity.
    pub fn insert(&mut self, core: ImCore) -> Option<ImCore> {
        self.cores.insert(Self::key_of(core.account()), core)
    }

    pub fn remove(&mut self, ctx: &AccountContext) -> Option<ImCore> {
        self.cores.remove(&Self::key_of(ctx))
    }

    pub fn get(&self, ctx: &AccountContext) -> Option<&ImCore> {
        self.cores.get(&Self::key_of(ctx))
    }

    pub fn get_mut(&mut self, ctx: &AccountContext) -> Option<&mut ImCore> {
        self.cores.get_mut(&Self::key_of(ctx))
    }

    pub fn iter(&self) -> impl Iterator<Item = &ImCore> {
        self.cores.values()
    }

    pub fn len(&self) -> usize {
        self.cores.len()
    }

    pub fn is_empty(&self) -> bool {
        self.cores.is_empty()
    }

    /// Route an envelope to the core of its persistent identity.
    pub fn ingest(&mut self, env: FactEnvelope) -> Result<IngestReport, AppError> {
        match self.cores.get_mut(&Self::key_of(&env.account)) {
            Some(core) => core.ingest(env),
            None => Err(AppError::new(
                shared_codes::ACCOUNT_UNKNOWN,
                "no core for this identity",
            )),
        }
    }

    /// Advance the generation of one identity.
    pub fn invalidate_generation(&mut self, new_ctx: AccountContext) -> Result<(), AppError> {
        match self.cores.get_mut(&Self::key_of(&new_ctx)) {
            Some(core) => core.invalidate_generation(new_ctx),
            None => Err(AppError::new(
                shared_codes::ACCOUNT_UNKNOWN,
                "no core for this identity",
            )),
        }
    }

    /// Aggregate unread across every core (saturating).
    pub fn total_unread(&self) -> u32 {
        self.cores
            .values()
            .fold(0u32, |acc, c| acc.saturating_add(c.total_unread()))
    }

    pub fn drain_round_events(&mut self) -> Vec<RoundEvent> {
        self.cores
            .values_mut()
            .flat_map(ImCore::drain_round_events)
            .collect()
    }
}

//! IM fact contracts: the bounded, typed events the web adapter emits to the
//! Rust core (strong-alert §3) and the send-disposition vocabulary
//! (architecture §4 "confirmed/rejected/unknown").
//!
//! Facts carry identity and generation but never credentials or message
//! bodies. The host validates the source view and generation; the payload's
//! self-reported account is never trusted on its own.

/// Where a message fact came from. The same business message may arrive
/// through several sources and must be deduplicated by its business
/// identity (`gid + message_id`), never counted twice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MessageSource {
    /// XMPP/WSS push through the official Web IM SDK.
    Realtime,
    /// Page / SDK initialization replay.
    Init,
    /// `getMessageList` pagination (history).
    History,
    /// `getRecentMessages` compensation loop.
    Compensation,
}

impl MessageSource {
    /// Only realtime and compensation can carry *new* customer messages for
    /// the alarm logic; init/history are replays and must never restart an
    /// old waiting round (strong-alert §4.6).
    pub fn is_replay(&self) -> bool {
        matches!(self, MessageSource::Init | MessageSource::History)
    }
}

/// Sender role as resolved from server facts (member list / role fields),
/// not guessed from display names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SenderRole {
    Customer,
    /// The logged-in merchant agent (this account).
    MerchantSelf,
    /// Another merchant agent of the same vendor.
    MerchantOther,
    CtripAgent,
    Robot,
    System,
    /// Not resolvable yet: reconcile before treating as a reply or a
    /// customer message.
    Unknown,
}

impl SenderRole {
    /// Whether a *successful* message from this role counts as a valid
    /// merchant reply that ends a waiting round (strong-alert §4.2/§4.4).
    pub fn is_valid_merchant_reply(&self) -> bool {
        matches!(self, SenderRole::MerchantSelf | SenderRole::MerchantOther)
    }
}

/// Coarse message kind. `Business` is any customer-visible business message
/// (text, image, file, video, card…); `Control` covers typing/read/recall
/// and other non-content events that never start or end a waiting round.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MsgKind {
    Business,
    Recall,
    ReadReceipt,
    Typing,
    Control,
}

/// Disposition of an outbound send.
///
/// A send button click, HTTP 200 or "socket connected" is never a
/// confirmation. `Unknown` must be persisted and reconciled, never blindly
/// resent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendDisposition {
    Confirmed {
        /// Server message id (`tid`) from `send_result` / HTTP read-back.
        server_message_id: String,
        server_time_ms: i64,
    },
    Rejected {
        code: String,
        reason: String,
    },
    Unknown,
}

impl SendDisposition {
    pub fn is_confirmed(&self) -> bool {
        matches!(self, SendDisposition::Confirmed { .. })
    }
}

/// One message fact.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageFact {
    pub gid: String,
    /// Server message id when known. For an outbound message before its
    /// `send_result`, this is `None` and `local_id` identifies it.
    pub message_id: Option<String>,
    pub local_id: Option<String>,
    /// Server create time in Unix milliseconds (13-digit).
    pub create_time_ms: i64,
    pub sender_role: SenderRole,
    /// Opaque sender id (uid / agent id) — no display name.
    pub sender_id: String,
    pub kind: MsgKind,
    pub source: MessageSource,
    /// Present for outbound messages; `None` for inbound.
    pub disposition: Option<SendDisposition>,
}

impl MessageFact {
    /// Business identity used for cross-source deduplication. Falls back to
    /// the local id only while the server id is unknown.
    pub fn dedup_key(&self) -> Option<String> {
        match (&self.message_id, &self.local_id) {
            (Some(mid), _) => Some(format!("{}#m:{}", self.gid, mid)),
            (None, Some(lid)) => Some(format!("{}#l:{}", self.gid, lid)),
            (None, None) => None,
        }
    }

    /// A customer business message that can open a waiting round.
    pub fn is_customer_business(&self) -> bool {
        self.sender_role == SenderRole::Customer && self.kind == MsgKind::Business
    }

    /// A confirmed valid merchant reply that can close a waiting round.
    pub fn is_confirmed_merchant_reply(&self) -> bool {
        self.sender_role.is_valid_merchant_reply()
            && self.kind == MsgKind::Business
            && match &self.disposition {
                // Inbound facts about other agents' replies are server facts.
                None => self.message_id.is_some(),
                Some(d) => d.is_confirmed(),
            }
    }
}

/// Conversation (worksheet) status as read from the server list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ConversationStatus {
    /// Serviceable ("处理中").
    Active,
    /// Finished ("已完成") — no reminders.
    Finished,
    /// Responsibility transferred away from this agent — no reminders.
    TransferredOut,
    /// Numeric status that is not mapped yet; treat as not serviceable for
    /// reminders until reconciled.
    Unknown,
}

/// Conversation fact from the ~5 s `getConversationList` increment or a full
/// snapshot. `is_full_snapshot` distinguishes "absent from this increment"
/// (means nothing) from "absent from a full list" (may mean removed).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversationFact {
    pub gid: String,
    pub status: ConversationStatus,
    /// Whether the current agent is a member of the group.
    pub agent_in_group: bool,
    pub is_owner: bool,
    /// Business line, e.g. `"1513"`; opaque.
    pub service_type: String,
    pub last_message_time_ms: Option<i64>,
    pub last_update_time_ms: Option<i64>,
    pub unread_count: u32,
    pub is_full_snapshot: bool,
}

impl ConversationFact {
    /// Whether this conversation may currently produce reply-timeout
    /// reminders (strong-alert §4.1).
    pub fn is_reminder_eligible(&self) -> bool {
        self.status == ConversationStatus::Active && self.agent_in_group
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fact(role: SenderRole, kind: MsgKind, disp: Option<SendDisposition>) -> MessageFact {
        MessageFact {
            gid: "g1".into(),
            message_id: Some("m1".into()),
            local_id: None,
            create_time_ms: 1_700_000_000_000,
            sender_role: role,
            sender_id: "u".into(),
            kind,
            source: MessageSource::Realtime,
            disposition: disp,
        }
    }

    #[test]
    fn dedup_key_prefers_server_id() {
        let mut f = fact(SenderRole::Customer, MsgKind::Business, None);
        assert_eq!(f.dedup_key().as_deref(), Some("g1#m:m1"));
        f.message_id = None;
        f.local_id = Some("l9".into());
        assert_eq!(f.dedup_key().as_deref(), Some("g1#l:l9"));
        f.local_id = None;
        assert_eq!(f.dedup_key(), None);
    }

    #[test]
    fn reply_validity_requires_confirmation_and_merchant_role() {
        assert!(
            fact(SenderRole::MerchantSelf, MsgKind::Business, None).is_confirmed_merchant_reply()
        );
        assert!(fact(
            SenderRole::MerchantSelf,
            MsgKind::Business,
            Some(SendDisposition::Confirmed {
                server_message_id: "t".into(),
                server_time_ms: 1
            })
        )
        .is_confirmed_merchant_reply());
        assert!(!fact(
            SenderRole::MerchantSelf,
            MsgKind::Business,
            Some(SendDisposition::Unknown)
        )
        .is_confirmed_merchant_reply());
        assert!(!fact(SenderRole::Robot, MsgKind::Business, None).is_confirmed_merchant_reply());
        assert!(
            !fact(SenderRole::CtripAgent, MsgKind::Business, None).is_confirmed_merchant_reply()
        );
        assert!(!fact(SenderRole::MerchantSelf, MsgKind::ReadReceipt, None)
            .is_confirmed_merchant_reply());
        assert!(!fact(SenderRole::Unknown, MsgKind::Business, None).is_confirmed_merchant_reply());
    }

    #[test]
    fn replay_sources() {
        assert!(MessageSource::Init.is_replay());
        assert!(MessageSource::History.is_replay());
        assert!(!MessageSource::Realtime.is_replay());
        assert!(!MessageSource::Compensation.is_replay());
    }
}

// ------------------------------------------------------------------ rounds
//
// The waiting-round seam between core-im (producer; owns the first T1
// deadline) and core-notify (consumer; owns escalation, sound and snooze).
// Keyed by `(AccountContext, gid, round_id)`; `version` increments on every
// change so that a stale hide/ack cannot act on a newer round state.

/// Reference to one waiting round.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct WaitingRoundRef {
    pub account: crate::identity::AccountContext,
    pub gid: String,
    pub round_id: String,
    pub version: u64,
}

/// Why a waiting round ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RoundEndReason {
    /// Server-confirmed valid merchant reply (self or another merchant agent).
    MerchantReplyConfirmed,
    ConversationFinished,
    TransferredOut,
    /// Conversation no longer eligible (agent left group, status unknown…).
    NotEligible,
}

/// Events emitted by core-im about waiting rounds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoundEvent {
    Started {
        round: WaitingRoundRef,
        /// `None` while the start is still "待核对".
        start_message_id: Option<String>,
        start_time_ms: Option<i64>,
        start_confirmed: bool,
        /// Desensitized conversation label (already masked).
        label: String,
    },
    /// The start of an existing round was confirmed or recomputed (e.g. an
    /// earlier customer message arrived out of order). The start never moves
    /// later because of newer customer messages.
    StartConfirmed {
        round: WaitingRoundRef,
        start_message_id: String,
        start_time_ms: i64,
    },
    Ended {
        round: WaitingRoundRef,
        reason: RoundEndReason,
    },
    /// Identity generation advanced (logout / replace): drop everything for
    /// this round's account.
    Invalidated { round: WaitingRoundRef },
}

impl RoundEvent {
    pub fn round(&self) -> &WaitingRoundRef {
        match self {
            RoundEvent::Started { round, .. }
            | RoundEvent::StartConfirmed { round, .. }
            | RoundEvent::Ended { round, .. }
            | RoundEvent::Invalidated { round } => round,
        }
    }
}

/// Reconciliation barrier state (strong-alert §5). Owned by core-im; notify
/// may only consume it and must never declare recovery complete itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ReconcileState {
    Normal,
    /// Sleep/offline/gap/stale snapshot: keep unfinished rounds, pause new
    /// popups and sounds until compensation and list refresh complete.
    Reconciling {
        generation: u64,
    },
}

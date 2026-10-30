//! Fact envelopes handed from the web adapter to the core (strong-alert §3,
//! plan F02) and the per-ingest report.
//!
//! `Fact` mirrors the TypeScript `AdapterFact` union in
//! `vbk/ui/packages/ipc/src/contracts.ts`; `FactEnvelope` mirrors
//! `AdapterFactEnvelope`. Nothing here carries credentials or message bodies.

use contracts::{AccountContext, ConversationFact, MessageFact, StreamCursor};

use crate::dedup::MergeOutcome;

/// Adapter → core stream identity. Each stream has its own `epoch/seq`
/// cursor; a gap on one stream never invalidates another.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum StreamId {
    /// `im.message`: message facts and compensation sync markers.
    Message,
    /// `im.conversation`: conversation facts and list sync markers.
    Conversation,
    /// `im.transport`: transport state and auth invalidation.
    Transport,
}

impl StreamId {
    /// Stream name as used by the TypeScript `FactStreams` constants.
    pub fn name(&self) -> &'static str {
        match self {
            StreamId::Message => "im.message",
            StreamId::Conversation => "im.conversation",
            StreamId::Transport => "im.transport",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "im.message" => Some(StreamId::Message),
            "im.conversation" => Some(StreamId::Conversation),
            "im.transport" => Some(StreamId::Transport),
            _ => None,
        }
    }

    pub const ALL: [StreamId; 3] = [
        StreamId::Message,
        StreamId::Conversation,
        StreamId::Transport,
    ];
}

/// Transport connection state as reported by the adapter. "Connected" is a
/// transport fact only; it is never domain readiness and never a send
/// confirmation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TransportState {
    Connecting,
    Connected,
    Disconnected,
    Reconnecting,
}

/// One adapter fact. Mirrors `AdapterFact`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fact {
    Message(MessageFact),
    Conversation(ConversationFact),
    /// A `getConversationList` round finished. `full` distinguishes a full
    /// list (absent known conversations become "missing from snapshot") from
    /// an increment (absence means nothing).
    ConversationListSync {
        full: bool,
        last_update_time_ms: Option<i64>,
    },
    /// A `getRecentMessages` compensation round finished.
    CompensationSync {
        last_message_timestamp_ms: Option<i64>,
    },
    Transport(TransportState),
    /// The web session is no longer authenticated. The core only records it;
    /// generation invalidation is decided by core-account.
    AuthInvalid,
}

/// Envelope the host hands to the core after validating the source view.
/// Mirrors `AdapterFactEnvelope`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FactEnvelope {
    pub account: AccountContext,
    pub stream: StreamId,
    pub epoch: u64,
    pub seq: u64,
    pub fact: Fact,
}

impl FactEnvelope {
    pub fn cursor(&self) -> StreamCursor {
        StreamCursor::new(self.epoch, self.seq)
    }
}

/// Why an envelope was not applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DropReason {
    /// `seq` already applied (or older) in the same epoch.
    DuplicateSeq,
    /// Missing events in between; the stream needs a re-handshake.
    Gap { expected: u64, got: u64 },
    /// The stream instance was rebuilt; the stream needs a re-handshake.
    EpochChanged,
    /// A previous gap/epoch change on this stream has not been resolved by
    /// `resync_complete` yet.
    AwaitingResync,
}

/// Outcome of one `ingest` call.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IngestReport {
    /// The fact was applied to the core state.
    pub applied: bool,
    /// Set when the envelope was dropped (never applied).
    pub dropped: Option<DropReason>,
    /// The caller must re-handshake this stream and then call
    /// `resync_complete(stream, new_cursor)`.
    pub needs_resync: Option<StreamId>,
    /// For message facts: how the fact merged into the index.
    pub message: Option<MergeOutcome>,
    /// Number of round events emitted by this ingest (drain them with
    /// `drain_round_events`).
    pub round_events: usize,
    /// The fact was `AuthInvalid`; core-account must decide the generation
    /// change.
    pub auth_invalid: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_names_round_trip() {
        for s in StreamId::ALL {
            assert_eq!(StreamId::from_name(s.name()), Some(s));
        }
        assert_eq!(StreamId::from_name("im.other"), None);
    }
}

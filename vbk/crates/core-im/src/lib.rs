//! IM domain: cross-source dedup, sync watermarks, send intents and waiting
//! rounds (std-only).
//!
//! Pure domain crate: no I/O, no clocks (callers pass `ClockReading`s and
//! times), deterministic. Consumes the frozen `contracts` types only.
//!
//! Module map:
//! * [`ingest`] — `FactEnvelope` / `Fact` mirror of the adapter facts and the
//!   per-envelope report;
//! * [`dedup`] — cross-source `MessageIndex`;
//! * [`conversations`] — conversation registry (increment vs. full snapshot);
//! * [`watermarks`] — list / compensation cursors and per-conversation
//!   history windows with a proof-only complete watermark;
//! * [`outbox`] — immutable `SendIntent`s and `confirmed/rejected/unknown`
//!   without any resend path;
//! * [`rounds`] — waiting-round engine and first T1 deadline;
//! * [`im_core`] — `ImCore` per account generation and `ImCores` per
//!   persistent identity.

pub mod conversations;
pub mod dedup;
pub mod im_core;
pub mod ingest;
pub mod outbox;
pub mod rounds;
pub mod watermarks;

pub use conversations::{ConversationChange, ConversationEntry, ConversationRegistry, Presence};
pub use dedup::{MergeOutcome, MessageIndex, MessageRecord};
pub use im_core::{ImCore, ImCores, PersistedImState};
pub use ingest::{DropReason, Fact, FactEnvelope, IngestReport, StreamId, TransportState};
pub use outbox::{Outbox, OutboxEntry, ReconcileOutcome, SendIntent, SendState};
pub use rounds::{
    first_t1_deadline, mask_label, BusinessLineRule, BusinessLineRules, Deadline, Eligibility,
    PersistedRound, Round, RoundState,
};
pub use watermarks::{HistoryWindow, SyncStateSnapshot, SyncWatermarks};

/// Error codes private to this crate (prefix convention `im.*`).
pub mod codes {
    /// A message fact carried neither a server id nor a local id.
    pub const IM_FACT_UNIDENTIFIED: &str = "im.fact_unidentified";
    /// Envelope or context is for another identity, or a generation newer
    /// than the core's (call `invalidate_generation` first).
    pub const IM_GENERATION_MISMATCH: &str = "im.generation_mismatch";
    /// Snapshot / context belongs to another persistent identity.
    pub const IM_ACCOUNT_MISMATCH: &str = "im.account_mismatch";
    pub const IM_UNKNOWN_INTENT: &str = "im.unknown_intent";
    pub const IM_DUPLICATE_INTENT: &str = "im.duplicate_intent";
    /// The requested transition is not allowed from the intent's state.
    pub const IM_INTENT_STATE: &str = "im.intent_state";
}

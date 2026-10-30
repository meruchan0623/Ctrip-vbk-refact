//! Shared contracts for the VBooking web-IM client (`vbk/`).
//!
//! This crate is the single source of truth for identity, event envelope,
//! error, IM-fact and alarm DTO types that every core crate, the Tauri host and
//! the TypeScript side agree on. It is `std`-only on purpose: the cores must be
//! unit-testable without a crate registry, and nothing here may carry
//! credentials, cookies or customer message bodies.
//!
//! The TypeScript mirror lives in `vbk/ui/packages/ipc/src/contracts.ts`; keep
//! the two in step (there is no code generator in this environment).
//!
//! Design sources: `docs/dev/00-architecture.md` §4, `docs/dev/03-strong-alert.md`,
//! `docs/plan/00-master-development-plan.md` §2–3 and the archived
//! `docs/archive/desktop-baseline/dev/00-architecture.md` §4.

pub mod clock;
pub mod error;
pub mod events;
pub mod identity;
pub mod im;
pub mod json;
pub mod notify;

pub use clock::{ClockQuality, ClockReading};
pub use error::{codes, AppError};
pub use events::{EventEnvelope, Snapshot, StreamCursor, StreamKey};
pub use identity::{
    AccountContext, AccountId, AggregateScope, ConversationRef, Environment, Scope, ViewContext,
};
pub use im::{
    ConversationFact, ConversationStatus, MessageFact, MessageSource, MsgKind, ReconcileState,
    RoundEndReason, RoundEvent, SendDisposition, SenderRole, WaitingRoundRef,
};
pub use notify::{
    AlarmCommand, AlarmEntry, AlarmLevel, AlarmSnapshot, ReminderSettings, SnoozeMinutes,
};

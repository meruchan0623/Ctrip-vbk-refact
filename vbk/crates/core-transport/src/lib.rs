//! Transport supervision state machine (I-05b, class A part; std-only, pure).
//!
//! The supervisor owns no socket, timer or WebView. The host feeds it
//! [`Event`]s together with an explicit `now_ms`, and executes the returned
//! [`Action`]s. That keeps every invariant testable without X11 / a real
//! machine. **It is deliberately not wired into `adapter.rs` or the WebView
//! rebuild path**: the I-05b prerequisite (X11 decision file
//! `docs/decisions/2026-11-xx-sdk-resource-conflict.md`) is not satisfied.
//!
//! Invariants (each has tests, see `tests/properties.rs`):
//!
//! 1. Escalation ladder `heartbeat timeout -> in-page compensation -> reload
//!    -> rebuild`; the level of the next attempt is a pure function of the
//!    external failure counter, so it survives instance replacement.
//! 2. Retry delays are exponential with deterministic-RNG jitter, never
//!    decrease within a failure streak and never exceed the cap.
//! 3. Circuit counters live outside the instance ([`CircuitCounters`],
//!    serialisable); a new instance resumes the streak instead of zeroing it
//!    (the official STA-01 counter-example).
//! 4. Four terminal reasons ([`TerminalReason`]) are not failures: no breaker
//!    count, and zero reconnect actions afterwards until
//!    [`Event::AccountRebound`].
//! 5. `Network { online: false }` freezes all counting and timers.
//! 6. `Draining -> Rebuilding -> Compensating -> Online`; sends are rejected
//!    while draining (see [`Supervisor::send_gate`]).
//! 7. Compensation starts at `now - 2 min` with a 5 s cadence window.

pub mod counters;
pub mod rng;
pub mod supervisor;

pub use counters::{BackoffPolicy, CircuitCounters, CountersError};
pub use rng::{Rng, SplitMix64, ZeroRng};
pub use supervisor::{
    Action, CompensationPlan, ConfigError, Event, Level, Phase, RejectReason, SdkStatus, SendGate,
    Supervisor, TerminalReason, TransportConfig,
};

//! Reply-timeout escalation (L0–L4), snooze, DND and alarm snapshots
//! (std-only). Design: `docs/dev/03-strong-alert.md`.
//!
//! # Shape
//!
//! [`NotifyCore`] is a pure, deterministic state machine. It owns no clock,
//! timer, thread or I/O: the host passes a [`Now`] into every call and
//! executes the returned [`Effect`]s. Facts come from core-im
//! (`RoundEvent`, `ReconcileState`), time from core-net (`ClockReading`),
//! environment from the shell ([`SystemState`], [`DndMode`]) and commands
//! from the alarm/setting/tray windows (`AlarmCommand`).
//!
//! # Effect model
//!
//! There is no internal effect queue. Every input method returns the
//! effects it causes, computed with the `Now` it received; [`NotifyCore::tick`]
//! returns time-driven effects (escalation, snooze expiry, L4 loop, the
//! 1 Hz `UpdateAlarm` refresh). Hosts apply effects in order.
//!
//! # Invariants (README §不变量 4)
//!
//! Only `RoundEvent::Ended` / `Invalidated` remove an entry. Read, open,
//! send and send-unknown never reach this crate as inputs. "清除" hides a
//! round id locally and never pretends it was answered.

mod banner;
mod commands;
mod dnd;
mod effects;
mod engine;
mod escalation;
mod now;
mod rounds;
mod snapshot;
mod unread;

pub use banner::{
    BANNER_MAX_STACKED, BANNER_STAY_MS, BANNER_WIDTH_PX, NEW_MESSAGE_SOUND_MIN_GAP_MS,
};
pub use commands::{CommandAck, CommandSource};
pub use dnd::{DndMode, DND_ONE_HOUR_MS};
pub use effects::{Effect, Sound};
pub use engine::{codes, LocalOptions, NotifyCore, RestoredRound, SystemState};
pub use escalation::{L4_CAP_MS, L4_PERIOD_MS};
pub use now::Now;
pub use rounds::{RoundState, T2_MS};
pub use snapshot::{is_red, mask_label, LOCKED_LABEL};
pub use unread::BadgeText;

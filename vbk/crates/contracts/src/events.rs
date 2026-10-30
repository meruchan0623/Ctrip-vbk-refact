//! Event envelope and snapshot contracts (archive §4.3 / plan F02).
//!
//! Every stream is identified by `scope + stream + epoch`; `seq` increases
//! only within that triple. A consumer subscribes first (buffering), then
//! takes an atomic snapshot, drops buffered events with `seq <= snapshot.seq`
//! in the same epoch, and replays the rest in order. Any gap, epoch change,
//! buffer overflow or re-subscription stops delta application and restarts
//! the handshake. A rebuilt stream MUST use a new epoch; resetting `seq` to 0
//! under the old epoch is forbidden.

use crate::identity::Scope;

/// Identity of a stream instance.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct StreamKey {
    pub scope: Scope,
    pub stream: String,
    pub epoch: u64,
}

/// Position within a stream instance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct StreamCursor {
    pub epoch: u64,
    pub seq: u64,
}

impl StreamCursor {
    pub const fn new(epoch: u64, seq: u64) -> Self {
        Self { epoch, seq }
    }

    /// Classifies `next` relative to this cursor.
    pub fn classify(&self, next: StreamCursor) -> CursorStep {
        if next.epoch != self.epoch {
            CursorStep::EpochChanged
        } else if next.seq == self.seq + 1 {
            CursorStep::Next
        } else if next.seq <= self.seq {
            CursorStep::Duplicate
        } else {
            CursorStep::Gap {
                expected: self.seq + 1,
                got: next.seq,
            }
        }
    }
}

/// Result of comparing an incoming cursor against the last applied one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CursorStep {
    /// Exactly the next sequence number: apply.
    Next,
    /// Already applied (or older): drop.
    Duplicate,
    /// Missing events in between: stop applying, re-snapshot.
    Gap { expected: u64, got: u64 },
    /// Stream instance was rebuilt: stop applying, re-handshake.
    EpochChanged,
}

/// `EventEnvelope{scope, stream, epoch, seq, payload}`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventEnvelope<P> {
    pub scope: Scope,
    pub stream: String,
    pub epoch: u64,
    pub seq: u64,
    pub payload: P,
}

impl<P> EventEnvelope<P> {
    pub fn cursor(&self) -> StreamCursor {
        StreamCursor::new(self.epoch, self.seq)
    }

    pub fn key(&self) -> StreamKey {
        StreamKey {
            scope: self.scope.clone(),
            stream: self.stream.clone(),
            epoch: self.epoch,
        }
    }
}

/// Atomic snapshot `{scope, stream, epoch, seq, data}` taken from the same
/// actor commit sequence that produces the events.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot<D> {
    pub scope: Scope,
    pub stream: String,
    pub epoch: u64,
    pub seq: u64,
    pub data: D,
}

impl<D> Snapshot<D> {
    pub fn cursor(&self) -> StreamCursor {
        StreamCursor::new(self.epoch, self.seq)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_classification() {
        let c = StreamCursor::new(2, 10);
        assert_eq!(c.classify(StreamCursor::new(2, 11)), CursorStep::Next);
        assert_eq!(c.classify(StreamCursor::new(2, 10)), CursorStep::Duplicate);
        assert_eq!(c.classify(StreamCursor::new(2, 3)), CursorStep::Duplicate);
        assert_eq!(
            c.classify(StreamCursor::new(2, 13)),
            CursorStep::Gap {
                expected: 11,
                got: 13
            }
        );
        assert_eq!(
            c.classify(StreamCursor::new(3, 0)),
            CursorStep::EpochChanged
        );
        // A rebuilt stream that wrongly kept the epoch and reset seq must not
        // look like a fresh start; it is classified as a duplicate and the
        // consumer will notice the stall and re-handshake.
        assert_eq!(c.classify(StreamCursor::new(2, 0)), CursorStep::Duplicate);
    }
}

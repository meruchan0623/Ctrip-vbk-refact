//! Network status model (archive 06-net §4.9) and the F14 rule: being
//! offline is never evidence that the ticket expired.
//!
//! The host feeds system connectivity hints and probe results; this module
//! only decides the published state and how a response outcome should be
//! reported while in that state.

use contracts::{codes, AppError};

use crate::soa::SoaOutcome;

/// Published connectivity state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum NetStatus {
    Online,
    /// System reports no connectivity, or probes to the gateway fail while
    /// the system claims to be offline.
    Offline,
    /// System says online but the Ctrip gateway is unreachable ("连上了
    /// Wi-Fi 但到不了携程").
    Degraded,
}

/// Inputs to the state machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum NetEvent {
    /// System connectivity hint (NLM or equivalent) — a hint, not proof.
    SystemOnline,
    SystemOffline,
    /// Bounded probe to the gateway health endpoint succeeded.
    ProbeOk,
    /// Probe failed.
    ProbeFailed,
    /// A business request failed at the connection level; `consecutive` is
    /// the count of such failures in a row.
    ConnectFailure {
        consecutive: u32,
    },
    /// A business request completed at the HTTP level (any status): the
    /// gateway is reachable.
    RequestReachedGateway,
}

/// Consecutive connection failures that trigger a probe (archive §4.9).
pub const PROBE_AFTER_FAILURES: u32 = 3;

/// Small state machine with a sequence number for snapshots/events.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NetStatusMachine {
    status: NetStatus,
    seq: u64,
    system_online: bool,
}

impl Default for NetStatusMachine {
    fn default() -> Self {
        Self::new(NetStatus::Online)
    }
}

impl NetStatusMachine {
    pub fn new(initial: NetStatus) -> Self {
        Self {
            status: initial,
            seq: 0,
            system_online: initial != NetStatus::Offline,
        }
    }

    pub fn status(&self) -> NetStatus {
        self.status
    }

    pub fn seq(&self) -> u64 {
        self.seq
    }

    /// Applies an event; returns the new status when it changed.
    pub fn apply(&mut self, event: NetEvent) -> Option<NetStatus> {
        let next = match event {
            NetEvent::SystemOffline => {
                self.system_online = false;
                NetStatus::Offline
            }
            NetEvent::SystemOnline => {
                self.system_online = true;
                // Online hint alone does not prove reachability: stay where a
                // probe can confirm, but leave Offline.
                match self.status {
                    NetStatus::Offline => NetStatus::Degraded,
                    s => s,
                }
            }
            NetEvent::ProbeOk | NetEvent::RequestReachedGateway => {
                self.system_online = true;
                NetStatus::Online
            }
            NetEvent::ProbeFailed => {
                if self.system_online {
                    NetStatus::Degraded
                } else {
                    NetStatus::Offline
                }
            }
            NetEvent::ConnectFailure { consecutive } => {
                if consecutive >= PROBE_AFTER_FAILURES && self.status == NetStatus::Online {
                    NetStatus::Degraded
                } else {
                    self.status
                }
            }
        };
        if next != self.status {
            self.status = next;
            self.seq += 1;
            Some(next)
        } else {
            None
        }
    }

    /// Whether the host should run a bounded probe after this event.
    pub fn should_probe(&self, event: NetEvent) -> bool {
        match event {
            NetEvent::SystemOnline => true,
            NetEvent::ConnectFailure { consecutive } => consecutive >= PROBE_AFTER_FAILURES,
            _ => false,
        }
    }
}

/// F14: maps a classified outcome to the error reported to core-account /
/// the UI, taking the network state into account. While `Offline`, even an
/// auth-looking response (captive portal, stale proxy page, cached error)
/// is reported as `net.offline`, never as `account.ticket_expired`.
pub fn report_outcome(status: NetStatus, outcome: &SoaOutcome) -> Option<AppError> {
    if outcome.is_success() {
        return None;
    }
    if status == NetStatus::Offline {
        return Some(
            AppError::new(codes::NET_OFFLINE, "network offline; response not trusted")
                .retryable()
                .with_detail(outcome.kind_name()),
        );
    }
    outcome.to_app_error()
}

#[cfg(test)]
mod tests {
    use super::*;
    use contracts::json::JsonValue;

    #[test]
    fn transitions() {
        let mut m = NetStatusMachine::default();
        assert_eq!(m.status(), NetStatus::Online);
        assert_eq!(m.apply(NetEvent::SystemOffline), Some(NetStatus::Offline));
        assert_eq!(m.apply(NetEvent::SystemOffline), None);
        assert_eq!(m.seq(), 1);
        assert_eq!(m.apply(NetEvent::SystemOnline), Some(NetStatus::Degraded));
        assert!(m.should_probe(NetEvent::SystemOnline));
        assert_eq!(m.apply(NetEvent::ProbeOk), Some(NetStatus::Online));
        assert_eq!(m.apply(NetEvent::ConnectFailure { consecutive: 2 }), None);
        assert!(!m.should_probe(NetEvent::ConnectFailure { consecutive: 2 }));
        assert!(m.should_probe(NetEvent::ConnectFailure { consecutive: 3 }));
        assert_eq!(
            m.apply(NetEvent::ConnectFailure { consecutive: 3 }),
            Some(NetStatus::Degraded)
        );
        assert_eq!(
            m.apply(NetEvent::RequestReachedGateway),
            Some(NetStatus::Online)
        );
        m.apply(NetEvent::SystemOffline);
        assert_eq!(m.apply(NetEvent::ProbeFailed), None);
        assert_eq!(m.status(), NetStatus::Offline);
    }

    #[test]
    fn offline_never_implies_ticket_expired() {
        let e = report_outcome(NetStatus::Offline, &SoaOutcome::AuthInvalid).expect("error");
        assert!(e.is(codes::NET_OFFLINE));
        assert!(!e.is(codes::ACCOUNT_TICKET_EXPIRED));
        let e = report_outcome(NetStatus::Online, &SoaOutcome::AuthInvalid).expect("error");
        assert!(e.is(codes::ACCOUNT_TICKET_EXPIRED));
        let e = report_outcome(NetStatus::Degraded, &SoaOutcome::AuthInvalid).expect("error");
        assert!(e.is(codes::ACCOUNT_TICKET_EXPIRED));
        assert!(report_outcome(
            NetStatus::Offline,
            &SoaOutcome::Success {
                body: JsonValue::object()
            }
        )
        .is_none());
    }
}

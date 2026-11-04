//! Contract version handshake (I-03).
//!
//! The Rust crate and the TypeScript mirror (`ui/packages/ipc/src/contracts.ts`)
//! carry the same `CONTRACT_VERSION`. A local window announces the version it
//! was built against with its first call (`contract_hello`); on a mismatch the
//! host rejects **every** command of that window and records a diagnostic.
//! Bump the constant on both sides whenever a shared shape changes
//! incompatibly. A drift test on the TS side parses this file to keep the two
//! numbers equal.

use std::collections::HashMap;

use crate::error::{codes, AppError};

pub const CONTRACT_VERSION: u32 = 2;

/// Upper bound for retained diagnostics; the oldest entry is dropped first.
const MAX_DIAGNOSTICS: usize = 32;

/// One rejected handshake. Carries only the window label and two integers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GateDiagnostic {
    pub label: String,
    /// `None` when a command arrived before any `contract_hello`.
    pub offered: Option<u32>,
    pub expected: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Verdict {
    Accepted,
    /// Sticky: a window that announced a wrong version stays rejected until
    /// the host forgets it (window destroyed / app restarted).
    Rejected(u32),
}

/// Per-window handshake state. Not thread-safe by itself; the host wraps it
/// in a `Mutex`.
#[derive(Debug)]
pub struct ContractGate {
    expected: u32,
    windows: HashMap<String, Verdict>,
    diagnostics: Vec<GateDiagnostic>,
}

impl Default for ContractGate {
    fn default() -> Self {
        Self::new(CONTRACT_VERSION)
    }
}

fn mismatch(label: &str, offered: Option<u32>, expected: u32) -> AppError {
    let message = match offered {
        Some(v) => format!("contract version {v} is not supported (host speaks {expected})"),
        None => format!(
            "window sent a command before announcing its contract version (host speaks {expected})"
        ),
    };
    AppError::new(codes::HOST_CONTRACT_MISMATCH, message).with_detail(format!("window={label}"))
}

impl ContractGate {
    pub fn new(expected: u32) -> Self {
        Self {
            expected,
            windows: HashMap::new(),
            diagnostics: Vec::new(),
        }
    }

    fn record(&mut self, label: &str, offered: Option<u32>) {
        if self.diagnostics.len() == MAX_DIAGNOSTICS {
            self.diagnostics.remove(0);
        }
        self.diagnostics.push(GateDiagnostic {
            label: label.to_owned(),
            offered,
            expected: self.expected,
        });
    }

    /// First call of a window. Idempotent for a matching version; a wrong
    /// version (also after an earlier accept) rejects the window for good.
    pub fn hello(&mut self, label: &str, offered: u32) -> Result<(), AppError> {
        if matches!(self.windows.get(label), Some(Verdict::Rejected(_))) {
            return Err(mismatch(label, Some(offered), self.expected));
        }
        if offered == self.expected {
            self.windows.insert(label.to_owned(), Verdict::Accepted);
            return Ok(());
        }
        self.windows
            .insert(label.to_owned(), Verdict::Rejected(offered));
        self.record(label, Some(offered));
        Err(mismatch(label, Some(offered), self.expected))
    }

    /// Gate for every other command of the window.
    pub fn check(&mut self, label: &str) -> Result<(), AppError> {
        match self.windows.get(label).copied() {
            Some(Verdict::Accepted) => Ok(()),
            Some(Verdict::Rejected(offered)) => Err(mismatch(label, Some(offered), self.expected)),
            None => {
                // Not sticky: the window may simply not have announced itself
                // yet. The early caller is still recorded as evidence.
                self.record(label, None);
                Err(mismatch(label, None, self.expected))
            }
        }
    }

    /// Drop the state of a destroyed window (its label may be reused).
    pub fn forget(&mut self, label: &str) {
        self.windows.remove(label);
    }

    pub fn diagnostics(&self) -> &[GateDiagnostic] {
        &self.diagnostics
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use crate::json::JsonValue;

    #[test]
    fn matching_hello_opens_the_window() {
        let mut gate = ContractGate::default();
        assert!(gate.check("main").is_err(), "no handshake yet");
        gate.hello("main", CONTRACT_VERSION).unwrap();
        gate.hello("main", CONTRACT_VERSION).unwrap();
        gate.check("main").unwrap();
        assert!(
            gate.check("alarm").is_err(),
            "other windows are independent"
        );
    }

    #[test]
    fn mismatching_version_rejects_every_command_of_that_window_only() {
        let mut gate = ContractGate::default();
        gate.hello("main", CONTRACT_VERSION).unwrap();
        let err = gate.hello("setting", CONTRACT_VERSION + 1).unwrap_err();
        assert!(err.is(codes::HOST_CONTRACT_MISMATCH));
        assert!(err.detail.as_deref().unwrap().contains("setting"));
        for _ in 0..3 {
            assert!(gate
                .check("setting")
                .unwrap_err()
                .is(codes::HOST_CONTRACT_MISMATCH));
        }
        gate.check("main").unwrap();
    }

    #[test]
    fn rejection_is_sticky_even_if_a_later_hello_matches() {
        let mut gate = ContractGate::default();
        gate.hello("setting", 0).unwrap_err();
        assert!(gate.hello("setting", CONTRACT_VERSION).is_err());
        assert!(gate.check("setting").is_err());
        gate.forget("setting");
        gate.hello("setting", CONTRACT_VERSION).unwrap();
        gate.check("setting").unwrap();
    }

    #[test]
    fn downgrade_after_accept_rejects() {
        let mut gate = ContractGate::default();
        gate.hello("main", CONTRACT_VERSION).unwrap();
        assert!(gate.hello("main", CONTRACT_VERSION + 1).is_err());
        assert!(gate.check("main").is_err());
    }

    #[test]
    fn early_command_does_not_poison_a_later_matching_hello() {
        let mut gate = ContractGate::default();
        assert!(gate.check("main").is_err());
        gate.hello("main", CONTRACT_VERSION).unwrap();
        gate.check("main").unwrap();
    }

    #[test]
    fn diagnostics_are_recorded_and_bounded() {
        let mut gate = ContractGate::default();
        gate.hello("setting", 7).unwrap_err();
        gate.check("alarm").unwrap_err();
        assert_eq!(
            gate.diagnostics(),
            &[
                GateDiagnostic {
                    label: "setting".into(),
                    offered: Some(7),
                    expected: CONTRACT_VERSION
                },
                GateDiagnostic {
                    label: "alarm".into(),
                    offered: None,
                    expected: CONTRACT_VERSION
                },
            ]
        );
        for i in 0..100 {
            let _ = gate.check(&format!("w{i}"));
        }
        assert_eq!(gate.diagnostics().len(), MAX_DIAGNOSTICS);
    }

    /// The wire payload of `contract_hello` is `{"version": <u32>}`.
    #[test]
    fn hello_payload_round_trips_through_json() {
        let wire = format!("{{\"version\":{CONTRACT_VERSION}}}");
        let parsed = JsonValue::parse(&wire).unwrap();
        let again = JsonValue::parse(&parsed.to_json()).unwrap();
        assert_eq!(parsed, again);
        assert_eq!(
            again.get("version").and_then(JsonValue::as_i64),
            Some(i64::from(CONTRACT_VERSION))
        );
    }
}

//! Outbox: immutable send intents and their dispositions (F04, plan §3.2,
//! IM-04).
//!
//! `Pending → Submitted → Confirmed | Rejected | Unknown`. `Unknown` is kept
//! and reconciled against server facts; there is deliberately **no resend
//! API** in this crate. A send intent freezes the waiting round it answers
//! and the newest customer message the agent could have seen
//! (`customer_boundary_message_id`), so that a late ACK can only release the
//! customer messages it provably covers (plan §7 "迟到回复证据").

use std::collections::BTreeMap;

use contracts::{AccountContext, AppError, MessageFact, SendDisposition};

use crate::codes;

/// Immutable description of one outbound send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendIntent {
    pub local_id: String,
    pub gid: String,
    pub account: AccountContext,
    pub created_at_ms: i64,
    /// Waiting round in progress when the intent was created.
    pub frozen_round_id: Option<String>,
    pub frozen_round_version: Option<u64>,
    /// Newest customer business message known at creation; the reply covers
    /// customer messages up to and including it, nothing newer.
    pub customer_boundary_message_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendState {
    Pending,
    Submitted,
    Confirmed {
        server_message_id: String,
        server_time_ms: i64,
    },
    Rejected {
        code: String,
        reason: String,
    },
    /// Outcome unknown (timeout, disconnect, crash). Persisted; reconciled,
    /// never resent automatically.
    Unknown,
}

impl SendState {
    pub fn is_final(&self) -> bool {
        matches!(
            self,
            SendState::Confirmed { .. } | SendState::Rejected { .. }
        )
    }

    pub fn is_unknown(&self) -> bool {
        matches!(self, SendState::Unknown)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboxEntry {
    pub intent: SendIntent,
    pub state: SendState,
}

/// Result of `reconcile_unknown`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReconcileOutcome {
    Confirmed {
        server_message_id: String,
        server_time_ms: i64,
    },
    /// No evidence either way: stay unknown (a missing read-back is not a
    /// proof of non-execution).
    StillUnknown,
    Rejected {
        code: String,
        reason: String,
    },
}

#[derive(Debug, Clone, Default)]
pub struct Outbox {
    entries: BTreeMap<String, OutboxEntry>,
}

impl Outbox {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_entries(entries: Vec<OutboxEntry>) -> Self {
        Self {
            entries: entries
                .into_iter()
                .map(|e| (e.intent.local_id.clone(), e))
                .collect(),
        }
    }

    pub fn entries(&self) -> impl Iterator<Item = &OutboxEntry> {
        self.entries.values()
    }

    pub fn get(&self, local_id: &str) -> Option<&OutboxEntry> {
        self.entries.get(local_id)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Intents whose outcome still needs reconciliation.
    pub fn unknown(&self) -> impl Iterator<Item = &OutboxEntry> {
        self.entries.values().filter(|e| e.state.is_unknown())
    }

    pub fn insert(&mut self, intent: SendIntent) -> Result<(), AppError> {
        if self.entries.contains_key(&intent.local_id) {
            return Err(
                AppError::new(codes::IM_DUPLICATE_INTENT, "send intent already exists")
                    .with_detail(format!("local_id={}", intent.local_id)),
            );
        }
        self.entries.insert(
            intent.local_id.clone(),
            OutboxEntry {
                intent,
                state: SendState::Pending,
            },
        );
        Ok(())
    }

    fn entry_mut(&mut self, local_id: &str) -> Result<&mut OutboxEntry, AppError> {
        self.entries.get_mut(local_id).ok_or_else(|| {
            AppError::new(
                codes::IM_UNKNOWN_INTENT,
                "no send intent with this local id",
            )
            .with_detail(format!("local_id={local_id}"))
        })
    }

    /// `Pending → Submitted`. Idempotent for `Submitted`; a final or unknown
    /// state cannot be re-submitted (that would be a resend).
    pub fn mark_submitted(&mut self, local_id: &str) -> Result<(), AppError> {
        let entry = self.entry_mut(local_id)?;
        match entry.state {
            SendState::Pending | SendState::Submitted => {
                entry.state = SendState::Submitted;
                Ok(())
            }
            _ => Err(
                AppError::new(codes::IM_INTENT_STATE, "intent is not pending")
                    .with_detail(format!("local_id={local_id} state={:?}", entry.state)),
            ),
        }
    }

    /// Apply a `send_result` / HTTP read-back disposition. Final states never
    /// regress: a late `Unknown` after `Confirmed` is ignored, a conflicting
    /// final result is an error.
    pub fn apply_send_result(
        &mut self,
        local_id: &str,
        disposition: SendDisposition,
    ) -> Result<SendState, AppError> {
        let entry = self.entry_mut(local_id)?;
        let next = match (&entry.state, disposition) {
            (
                SendState::Confirmed {
                    server_message_id, ..
                },
                SendDisposition::Confirmed {
                    server_message_id: mid,
                    ..
                },
            ) if *server_message_id == mid => entry.state.clone(),
            (s, SendDisposition::Unknown) if s.is_final() => s.clone(),
            (s, d) if s.is_final() => {
                return Err(
                    AppError::new(codes::IM_INTENT_STATE, "conflicting final send result")
                        .with_detail(format!("local_id={local_id} state={s:?} incoming={d:?}")),
                );
            }
            (
                _,
                SendDisposition::Confirmed {
                    server_message_id,
                    server_time_ms,
                },
            ) => SendState::Confirmed {
                server_message_id,
                server_time_ms,
            },
            (_, SendDisposition::Rejected { code, reason }) => SendState::Rejected { code, reason },
            (_, SendDisposition::Unknown) => SendState::Unknown,
        };
        entry.state = next.clone();
        Ok(next)
    }

    /// Reconcile an unknown (or still submitted) intent against server
    /// facts read back for its conversation. Only evidence changes the
    /// state; absence keeps it unknown.
    pub fn reconcile_unknown(
        &mut self,
        local_id: &str,
        server_facts: &[MessageFact],
    ) -> Result<ReconcileOutcome, AppError> {
        let entry = self.entry_mut(local_id)?;
        match &entry.state {
            SendState::Confirmed {
                server_message_id,
                server_time_ms,
            } => {
                return Ok(ReconcileOutcome::Confirmed {
                    server_message_id: server_message_id.clone(),
                    server_time_ms: *server_time_ms,
                })
            }
            SendState::Rejected { code, reason } => {
                return Ok(ReconcileOutcome::Rejected {
                    code: code.clone(),
                    reason: reason.clone(),
                })
            }
            SendState::Pending => {
                return Err(
                    AppError::new(codes::IM_INTENT_STATE, "intent was never submitted")
                        .with_detail(format!("local_id={local_id}")),
                );
            }
            SendState::Submitted | SendState::Unknown => {}
        }
        let gid = entry.intent.gid.as_str();
        let matching = server_facts
            .iter()
            .filter(|f| f.gid == gid && f.local_id.as_deref() == Some(local_id));
        let mut rejected: Option<(String, String)> = None;
        for fact in matching {
            match (&fact.message_id, &fact.disposition) {
                (Some(mid), None) | (Some(mid), Some(SendDisposition::Unknown)) => {
                    let state = SendState::Confirmed {
                        server_message_id: mid.clone(),
                        server_time_ms: fact.create_time_ms,
                    };
                    entry.state = state;
                    return Ok(ReconcileOutcome::Confirmed {
                        server_message_id: mid.clone(),
                        server_time_ms: fact.create_time_ms,
                    });
                }
                (
                    _,
                    Some(SendDisposition::Confirmed {
                        server_message_id,
                        server_time_ms,
                    }),
                ) => {
                    entry.state = SendState::Confirmed {
                        server_message_id: server_message_id.clone(),
                        server_time_ms: *server_time_ms,
                    };
                    return Ok(ReconcileOutcome::Confirmed {
                        server_message_id: server_message_id.clone(),
                        server_time_ms: *server_time_ms,
                    });
                }
                (_, Some(SendDisposition::Rejected { code, reason })) => {
                    rejected = Some((code.clone(), reason.clone()));
                }
                (None, None) | (None, Some(SendDisposition::Unknown)) => {}
            }
        }
        if let Some((code, reason)) = rejected {
            entry.state = SendState::Rejected {
                code: code.clone(),
                reason: reason.clone(),
            };
            return Ok(ReconcileOutcome::Rejected { code, reason });
        }
        entry.state = SendState::Unknown;
        Ok(ReconcileOutcome::StillUnknown)
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use contracts::{AccountId, Environment, MessageSource, MsgKind, SenderRole};

    fn ctx() -> AccountContext {
        AccountContext::new(AccountId::new("acc"), Environment::named("test"), 1)
    }

    fn intent(lid: &str) -> SendIntent {
        SendIntent {
            local_id: lid.into(),
            gid: "g".into(),
            account: ctx(),
            created_at_ms: 100,
            frozen_round_id: None,
            frozen_round_version: None,
            customer_boundary_message_id: None,
        }
    }

    fn server_fact(
        lid: Option<&str>,
        mid: Option<&str>,
        disp: Option<SendDisposition>,
    ) -> MessageFact {
        MessageFact {
            gid: "g".into(),
            message_id: mid.map(Into::into),
            local_id: lid.map(Into::into),
            create_time_ms: 120,
            sender_role: SenderRole::MerchantSelf,
            sender_id: "me".into(),
            kind: MsgKind::Business,
            source: MessageSource::History,
            disposition: disp,
        }
    }

    #[test]
    fn lifecycle_and_no_regression() {
        let mut ob = Outbox::new();
        ob.insert(intent("l1")).unwrap();
        assert!(ob
            .insert(intent("l1"))
            .unwrap_err()
            .is(codes::IM_DUPLICATE_INTENT));
        ob.mark_submitted("l1").unwrap();
        ob.mark_submitted("l1").unwrap();
        assert_eq!(
            ob.apply_send_result("l1", SendDisposition::Unknown)
                .unwrap(),
            SendState::Unknown
        );
        assert!(
            ob.mark_submitted("l1").is_err(),
            "unknown cannot be re-submitted"
        );
        let st = ob
            .apply_send_result(
                "l1",
                SendDisposition::Confirmed {
                    server_message_id: "t1".into(),
                    server_time_ms: 130,
                },
            )
            .unwrap();
        assert!(matches!(st, SendState::Confirmed { .. }));
        assert_eq!(
            ob.apply_send_result("l1", SendDisposition::Unknown)
                .unwrap(),
            st
        );
        assert!(ob
            .apply_send_result(
                "l1",
                SendDisposition::Rejected {
                    code: "x".into(),
                    reason: "y".into()
                }
            )
            .is_err());
        assert!(ob
            .apply_send_result("zz", SendDisposition::Unknown)
            .unwrap_err()
            .is(codes::IM_UNKNOWN_INTENT));
    }

    #[test]
    fn reconcile_unknown_paths() {
        let mut ob = Outbox::new();
        ob.insert(intent("l1")).unwrap();
        assert!(ob
            .reconcile_unknown("l1", &[])
            .unwrap_err()
            .is(codes::IM_INTENT_STATE));
        ob.mark_submitted("l1").unwrap();
        ob.apply_send_result("l1", SendDisposition::Unknown)
            .unwrap();
        // Nothing found: still unknown (not rejected).
        assert_eq!(
            ob.reconcile_unknown("l1", &[]).unwrap(),
            ReconcileOutcome::StillUnknown
        );
        assert_eq!(ob.unknown().count(), 1);
        // Other local id: irrelevant.
        assert_eq!(
            ob.reconcile_unknown("l1", &[server_fact(Some("l9"), Some("t9"), None)])
                .unwrap(),
            ReconcileOutcome::StillUnknown
        );
        // Found by local id with a server id: confirmed.
        let out = ob
            .reconcile_unknown("l1", &[server_fact(Some("l1"), Some("t1"), None)])
            .unwrap();
        assert_eq!(
            out,
            ReconcileOutcome::Confirmed {
                server_message_id: "t1".into(),
                server_time_ms: 120
            }
        );
        assert_eq!(ob.unknown().count(), 0);

        let mut ob = Outbox::new();
        ob.insert(intent("l2")).unwrap();
        ob.mark_submitted("l2").unwrap();
        ob.apply_send_result("l2", SendDisposition::Unknown)
            .unwrap();
        let rej = SendDisposition::Rejected {
            code: "E".into(),
            reason: "denied".into(),
        };
        let out = ob
            .reconcile_unknown("l2", &[server_fact(Some("l2"), None, Some(rej))])
            .unwrap();
        assert!(matches!(out, ReconcileOutcome::Rejected { .. }));
    }
}

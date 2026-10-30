//! Conversation registry built from `ConversationFact`s (dev 06-net, F05/F06).
//!
//! * An increment only updates the conversations it names; absence from an
//!   increment means nothing.
//! * A full snapshot (`is_full_snapshot` facts followed by
//!   `ConversationListSync { full: true }`) marks known conversations that
//!   did not appear as `MissingFromSnapshot`. They are never deleted and never
//!   treated as finished; the integration re-reads them with
//!   `getConversationInfoByGidList` and feeds the result back as a fact.

use std::collections::{BTreeMap, BTreeSet};

use contracts::{ConversationFact, ConversationStatus};

/// Whether the conversation was present in the latest full snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Presence {
    Present,
    /// Absent from a full list since `since_generation` (the registry's
    /// snapshot counter). Pending re-read; not proof of anything.
    MissingFromSnapshot {
        since_generation: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversationEntry {
    pub gid: String,
    pub status: ConversationStatus,
    pub agent_in_group: bool,
    pub is_owner: bool,
    pub service_type: String,
    pub last_message_time_ms: Option<i64>,
    pub last_update_time_ms: Option<i64>,
    /// Server-reported unread count from the latest fact.
    pub server_unread: u32,
    /// Locally cleared by `on_open_conversation` until the next fact.
    pub unread_cleared_locally: bool,
    pub presence: Presence,
}

impl ConversationEntry {
    fn from_fact(fact: &ConversationFact) -> Self {
        Self {
            gid: fact.gid.clone(),
            status: fact.status,
            agent_in_group: fact.agent_in_group,
            is_owner: fact.is_owner,
            service_type: fact.service_type.clone(),
            last_message_time_ms: fact.last_message_time_ms,
            last_update_time_ms: fact.last_update_time_ms,
            server_unread: fact.unread_count,
            unread_cleared_locally: false,
            presence: Presence::Present,
        }
    }

    /// `Active && agent_in_group` (strong-alert §4.1). Uses the last known
    /// status even while missing from a snapshot.
    pub fn is_reminder_eligible(&self) -> bool {
        self.status == ConversationStatus::Active && self.agent_in_group
    }

    pub fn unread(&self) -> u32 {
        if self.unread_cleared_locally {
            0
        } else {
            self.server_unread
        }
    }

    pub fn is_missing_from_snapshot(&self) -> bool {
        matches!(self.presence, Presence::MissingFromSnapshot { .. })
    }
}

/// Result of applying one conversation fact.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConversationChange {
    Inserted,
    Updated,
    Unchanged,
}

#[derive(Debug, Clone, Default)]
pub struct ConversationRegistry {
    entries: BTreeMap<String, ConversationEntry>,
    /// gids seen with `is_full_snapshot` since the last `complete_full_snapshot`.
    snapshot_gids: Option<BTreeSet<String>>,
    snapshot_generation: u64,
}

impl ConversationRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn get(&self, gid: &str) -> Option<&ConversationEntry> {
        self.entries.get(gid)
    }

    pub fn entries(&self) -> impl Iterator<Item = &ConversationEntry> {
        self.entries.values()
    }

    pub fn snapshot_generation(&self) -> u64 {
        self.snapshot_generation
    }

    /// Apply an increment or snapshot member. Presence becomes `Present`.
    pub fn apply(&mut self, fact: &ConversationFact) -> ConversationChange {
        if fact.is_full_snapshot {
            self.snapshot_gids
                .get_or_insert_with(BTreeSet::new)
                .insert(fact.gid.clone());
        }
        let fresh = ConversationEntry::from_fact(fact);
        match self.entries.get_mut(&fact.gid) {
            Some(existing) => {
                if *existing == fresh {
                    ConversationChange::Unchanged
                } else {
                    *existing = fresh;
                    ConversationChange::Updated
                }
            }
            None => {
                self.entries.insert(fact.gid.clone(), fresh);
                ConversationChange::Inserted
            }
        }
    }

    /// A full list finished: every known conversation that was not part of
    /// it becomes `MissingFromSnapshot`. Returns the newly missing gids.
    pub fn complete_full_snapshot(&mut self) -> Vec<String> {
        self.snapshot_generation = self.snapshot_generation.saturating_add(1);
        let seen = self.snapshot_gids.take().unwrap_or_default();
        let generation = self.snapshot_generation;
        let mut newly_missing = Vec::new();
        for (gid, entry) in self.entries.iter_mut() {
            if seen.contains(gid) {
                continue;
            }
            if entry.presence == Presence::Present {
                entry.presence = Presence::MissingFromSnapshot {
                    since_generation: generation,
                };
                newly_missing.push(gid.clone());
            }
        }
        newly_missing
    }

    /// An increment finished: nothing to infer from absence. Any partial
    /// snapshot bookkeeping is discarded.
    pub fn complete_increment(&mut self) {
        self.snapshot_gids = None;
    }

    /// Conversations that need `getConversationInfoByGidList`.
    pub fn pending_reread(&self) -> Vec<String> {
        self.entries
            .values()
            .filter(|e| e.is_missing_from_snapshot())
            .map(|e| e.gid.clone())
            .collect()
    }

    /// `Some(true)` when eligible, `Some(false)` when known and not
    /// eligible, `None` when the conversation is unknown.
    pub fn eligible_for_reminder(&self, gid: &str) -> Option<bool> {
        self.entries
            .get(gid)
            .map(ConversationEntry::is_reminder_eligible)
    }

    pub fn unread(&self, gid: &str) -> u32 {
        self.entries.get(gid).map_or(0, ConversationEntry::unread)
    }

    pub fn total_unread(&self) -> u32 {
        self.entries
            .values()
            .fold(0u32, |acc, e| acc.saturating_add(e.unread()))
    }

    /// Local clear (opening the conversation). The next fact overrides it.
    pub fn clear_unread(&mut self, gid: &str) -> bool {
        match self.entries.get_mut(gid) {
            Some(e) => {
                e.unread_cleared_locally = true;
                true
            }
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fact(gid: &str, status: ConversationStatus, full: bool) -> ConversationFact {
        ConversationFact {
            gid: gid.into(),
            status,
            agent_in_group: true,
            is_owner: true,
            service_type: "1513".into(),
            last_message_time_ms: None,
            last_update_time_ms: None,
            unread_count: 2,
            is_full_snapshot: full,
        }
    }

    #[test]
    fn increment_absence_means_nothing() {
        let mut reg = ConversationRegistry::new();
        reg.apply(&fact("a", ConversationStatus::Active, false));
        reg.apply(&fact("b", ConversationStatus::Active, false));
        reg.apply(&fact("a", ConversationStatus::Active, false));
        reg.complete_increment();
        assert!(reg.pending_reread().is_empty());
        assert_eq!(reg.eligible_for_reminder("b"), Some(true));
    }

    #[test]
    fn full_snapshot_marks_missing_but_keeps_entry() {
        let mut reg = ConversationRegistry::new();
        reg.apply(&fact("a", ConversationStatus::Active, false));
        reg.apply(&fact("b", ConversationStatus::Active, false));
        reg.apply(&fact("a", ConversationStatus::Active, true));
        let missing = reg.complete_full_snapshot();
        assert_eq!(missing, vec!["b".to_string()]);
        assert_eq!(reg.len(), 2);
        assert!(reg
            .get("b")
            .is_some_and(ConversationEntry::is_missing_from_snapshot));
        // Still eligible: absence is not proof of finished.
        assert_eq!(reg.eligible_for_reminder("b"), Some(true));
        assert_eq!(reg.pending_reread(), vec!["b".to_string()]);
        // Re-read restores presence.
        reg.apply(&fact("b", ConversationStatus::Finished, false));
        assert!(reg.pending_reread().is_empty());
        assert_eq!(reg.eligible_for_reminder("b"), Some(false));
    }

    #[test]
    fn unread_local_clear_until_next_fact() {
        let mut reg = ConversationRegistry::new();
        reg.apply(&fact("a", ConversationStatus::Active, false));
        assert_eq!(reg.total_unread(), 2);
        assert!(reg.clear_unread("a"));
        assert_eq!(reg.total_unread(), 0);
        reg.apply(&fact("a", ConversationStatus::Active, false));
        assert_eq!(reg.unread("a"), 2);
        assert!(!reg.clear_unread("zzz"));
    }
}

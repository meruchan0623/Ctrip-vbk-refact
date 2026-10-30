//! Cross-source message deduplication (strong-alert §4.6, archive §4.5).
//!
//! The same business message reaches the core through realtime push, init
//! replay, history pages and the compensation loop, sometimes twice through
//! two WSS connections. All copies merge into one `MessageRecord` keyed by
//! `MessageFact::dedup_key()`. An outbound message is first known by its
//! `#l:<local_id>` key; when a server id arrives (ACK or echo) the record is
//! re-keyed to `#m:<message_id>` and the local key becomes an alias, so a
//! later inbound copy of the same server id is a duplicate.
//!
//! Per conversation the records are kept ordered by server create time so
//! that out-of-order arrivals re-sort instead of being appended.

use std::collections::BTreeMap;

use contracts::{AppError, MessageFact, MessageSource, MsgKind, SendDisposition, SenderRole};

use crate::codes;

/// One deduplicated message. Carries no body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageRecord {
    pub gid: String,
    pub message_id: Option<String>,
    pub local_id: Option<String>,
    /// Server create time (ms). For an outbound message before its server
    /// id is known this is the local creation time.
    pub create_time_ms: i64,
    pub sender_role: SenderRole,
    pub sender_id: String,
    pub kind: MsgKind,
    pub disposition: Option<SendDisposition>,
    /// Every source this message was seen from (sorted, unique).
    pub sources: Vec<MessageSource>,
    /// How many copies were merged (including the first).
    pub seen_count: u32,
}

impl MessageRecord {
    fn from_fact(fact: &MessageFact) -> Self {
        Self {
            gid: fact.gid.clone(),
            message_id: fact.message_id.clone(),
            local_id: fact.local_id.clone(),
            create_time_ms: fact.create_time_ms,
            sender_role: fact.sender_role,
            sender_id: fact.sender_id.clone(),
            kind: fact.kind,
            disposition: fact.disposition.clone(),
            sources: vec![fact.source],
            seen_count: 1,
        }
    }

    /// Current dedup key (`#m:` when the server id is known).
    pub fn key(&self) -> Option<String> {
        match (&self.message_id, &self.local_id) {
            (Some(mid), _) => Some(format!("{}#m:{}", self.gid, mid)),
            (None, Some(lid)) => Some(format!("{}#l:{}", self.gid, lid)),
            (None, None) => None,
        }
    }

    /// Seen from at least one non-replay source (realtime/compensation or
    /// the local outbox). Only such messages may start a waiting round.
    pub fn seen_live(&self) -> bool {
        self.sources.iter().any(|s| !s.is_replay())
    }

    pub fn is_customer_business(&self) -> bool {
        self.sender_role == SenderRole::Customer && self.kind == MsgKind::Business
    }

    /// Same rule as `MessageFact::is_confirmed_merchant_reply`.
    pub fn is_confirmed_merchant_reply(&self) -> bool {
        self.sender_role.is_valid_merchant_reply()
            && self.kind == MsgKind::Business
            && match &self.disposition {
                None => self.message_id.is_some(),
                Some(d) => d.is_confirmed(),
            }
    }

    /// Business message whose sender role is not resolved yet.
    pub fn is_unresolved_business(&self) -> bool {
        self.sender_role == SenderRole::Unknown && self.kind == MsgKind::Business
    }

    /// Merge another copy into this record. Returns whether anything
    /// semantically changed (role resolved, disposition upgraded, server
    /// time or id learned). Seeing the same copy again is not a change.
    fn absorb(&mut self, fact: &MessageFact) -> bool {
        let mut changed = false;
        self.seen_count = self.seen_count.saturating_add(1);
        if !self.sources.contains(&fact.source) {
            // Gaining the first non-replay source is evidence that matters
            // to the round engine (rule b), so it counts as a change.
            let was_live = self.seen_live();
            self.sources.push(fact.source);
            self.sources.sort_by_key(|s| source_rank(*s));
            if !was_live && self.seen_live() {
                changed = true;
            }
        }
        if self.sender_role == SenderRole::Unknown && fact.sender_role != SenderRole::Unknown {
            self.sender_role = fact.sender_role;
            changed = true;
        }
        if self.sender_id.is_empty() && !fact.sender_id.is_empty() {
            self.sender_id = fact.sender_id.clone();
        }
        if self.local_id.is_none() && fact.local_id.is_some() {
            self.local_id = fact.local_id.clone();
            changed = true;
        }
        if self.message_id.is_none() {
            if let Some(mid) = &fact.message_id {
                self.message_id = Some(mid.clone());
                // A server id comes with server time.
                self.create_time_ms = fact.create_time_ms;
                changed = true;
            }
        }
        changed |= self.absorb_disposition(fact);
        changed
    }

    fn absorb_disposition(&mut self, fact: &MessageFact) -> bool {
        match (&self.disposition, &fact.disposition) {
            // Final states never regress.
            (Some(SendDisposition::Confirmed { .. }), _) => false,
            (Some(SendDisposition::Rejected { .. }), Some(SendDisposition::Confirmed { .. })) => {
                // Server says it exists after all: evidence wins over a
                // local rejection.
                self.take_confirmed(fact)
            }
            (Some(SendDisposition::Rejected { .. }), Some(_)) => false,
            (_, Some(SendDisposition::Confirmed { .. })) => self.take_confirmed(fact),
            (_, Some(SendDisposition::Rejected { .. })) => {
                self.disposition = fact.disposition.clone();
                true
            }
            (None, Some(SendDisposition::Unknown)) => {
                self.disposition = Some(SendDisposition::Unknown);
                true
            }
            (Some(SendDisposition::Unknown), None) | (Some(SendDisposition::Rejected { .. }), None) => {
                // Inbound echo of our own outbound message (回推先于 ACK):
                // a server id is server evidence of acceptance, even after
                // the SDK reported a local rejection.
                match &fact.message_id {
                    Some(mid) => {
                        self.disposition = Some(SendDisposition::Confirmed {
                            server_message_id: mid.clone(),
                            server_time_ms: fact.create_time_ms,
                        });
                        self.create_time_ms = fact.create_time_ms;
                        true
                    }
                    None => false,
                }
            }
            (Some(SendDisposition::Unknown), Some(SendDisposition::Unknown)) | (None, None) => {
                false
            }
        }
    }

    fn take_confirmed(&mut self, fact: &MessageFact) -> bool {
        if let Some(SendDisposition::Confirmed {
            server_message_id,
            server_time_ms,
        }) = &fact.disposition
        {
            if self.message_id.is_none() {
                self.message_id = Some(server_message_id.clone());
            }
            self.create_time_ms = *server_time_ms;
            self.disposition = fact.disposition.clone();
            return true;
        }
        false
    }

    /// Rebuild a fact view of this record (first live source preferred).
    pub fn to_fact(&self) -> MessageFact {
        MessageFact {
            gid: self.gid.clone(),
            message_id: self.message_id.clone(),
            local_id: self.local_id.clone(),
            create_time_ms: self.create_time_ms,
            sender_role: self.sender_role,
            sender_id: self.sender_id.clone(),
            kind: self.kind,
            source: self
                .sources
                .iter()
                .copied()
                .find(|s| !s.is_replay())
                .or_else(|| self.sources.first().copied())
                .unwrap_or(MessageSource::History),
            disposition: self.disposition.clone(),
        }
    }
}

fn source_rank(s: MessageSource) -> u8 {
    match s {
        MessageSource::Realtime => 0,
        MessageSource::Compensation => 1,
        MessageSource::Init => 2,
        MessageSource::History => 3,
    }
}

/// How a fact merged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergeOutcome {
    /// New business identity.
    Inserted,
    /// Already known and nothing changed (counted once).
    Duplicate,
    /// Already known; a field was upgraded (role resolved, disposition
    /// confirmed, server time learned).
    Updated,
    /// A `#l:` record received its server id and now lives under `#m:`.
    Linked {
        local_key: String,
        server_key: String,
    },
}

impl MergeOutcome {
    pub fn is_change(&self) -> bool {
        !matches!(self, MergeOutcome::Duplicate)
    }
}

/// Dedup index for one account.
#[derive(Debug, Clone, Default)]
pub struct MessageIndex {
    records: BTreeMap<String, MessageRecord>,
    /// `#l:` key → `#m:` key after correlation.
    aliases: BTreeMap<String, String>,
    /// gid → keys ordered by `(create_time_ms, key)`.
    by_gid: BTreeMap<String, Vec<String>>,
}

impl MessageIndex {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    /// Resolve an alias to the current key.
    pub fn resolve_key<'a>(&'a self, key: &'a str) -> &'a str {
        self.aliases.get(key).map_or(key, String::as_str)
    }

    pub fn get(&self, key: &str) -> Option<&MessageRecord> {
        self.records.get(self.resolve_key(key))
    }

    pub fn find_by_message_id(&self, gid: &str, message_id: &str) -> Option<&MessageRecord> {
        self.records.get(&format!("{gid}#m:{message_id}"))
    }

    pub fn find_by_local_id(&self, gid: &str, local_id: &str) -> Option<&MessageRecord> {
        self.get(&format!("{gid}#l:{local_id}"))
    }

    pub fn gids(&self) -> impl Iterator<Item = &str> {
        self.by_gid.keys().map(String::as_str)
    }

    /// Records of one conversation ordered by server time (then key).
    pub fn ordered(&self, gid: &str) -> Vec<&MessageRecord> {
        self.by_gid
            .get(gid)
            .map(|keys| keys.iter().filter_map(|k| self.records.get(k)).collect())
            .unwrap_or_default()
    }

    /// Latest customer business message of a conversation (by order).
    pub fn latest_customer_business(&self, gid: &str) -> Option<&MessageRecord> {
        self.ordered(gid)
            .into_iter()
            .rev()
            .find(|m| m.is_customer_business())
    }

    /// Merge one fact. Errors with `im.fact_unidentified` when the fact has
    /// neither a server id nor a local id.
    pub fn merge(&mut self, fact: &MessageFact) -> Result<MergeOutcome, AppError> {
        let key = fact.dedup_key().ok_or_else(|| {
            AppError::new(
                codes::IM_FACT_UNIDENTIFIED,
                "message fact has no message_id or local_id",
            )
        })?;
        let local_key = fact
            .local_id
            .as_ref()
            .map(|lid| format!("{}#l:{}", fact.gid, lid));

        if let Some(mid) = &fact.message_id {
            let server_key = format!("{}#m:{}", fact.gid, mid);
            if self.records.contains_key(&server_key) {
                return Ok(self.absorb_into(&server_key, fact));
            }
            if let Some(lkey) = &local_key {
                if let Some(mut rec) = self.records.remove(lkey) {
                    rec.absorb(fact);
                    rec.message_id = Some(mid.clone());
                    self.replace_key(&fact.gid, lkey, &server_key);
                    self.aliases.insert(lkey.clone(), server_key.clone());
                    self.records.insert(server_key.clone(), rec);
                    self.resort(&fact.gid);
                    return Ok(MergeOutcome::Linked {
                        local_key: lkey.clone(),
                        server_key,
                    });
                }
            }
            self.insert_new(server_key, fact);
            return Ok(MergeOutcome::Inserted);
        }

        // Local-only fact.
        let resolved = self.resolve_key(&key).to_string();
        if self.records.contains_key(&resolved) {
            return Ok(self.absorb_into(&resolved, fact));
        }
        self.insert_new(key, fact);
        Ok(MergeOutcome::Inserted)
    }

    fn absorb_into(&mut self, key: &str, fact: &MessageFact) -> MergeOutcome {
        let (changed, gid) = match self.records.get_mut(key) {
            Some(rec) => (rec.absorb(fact), rec.gid.clone()),
            None => return MergeOutcome::Duplicate,
        };
        if changed {
            self.resort(&gid);
            MergeOutcome::Updated
        } else {
            MergeOutcome::Duplicate
        }
    }

    fn insert_new(&mut self, key: String, fact: &MessageFact) {
        self.records
            .insert(key.clone(), MessageRecord::from_fact(fact));
        self.by_gid.entry(fact.gid.clone()).or_default().push(key);
        self.resort(&fact.gid);
    }

    fn replace_key(&mut self, gid: &str, old: &str, new: &str) {
        if let Some(keys) = self.by_gid.get_mut(gid) {
            for k in keys.iter_mut() {
                if k == old {
                    *k = new.to_string();
                }
            }
        }
    }

    fn resort(&mut self, gid: &str) {
        let Some(keys) = self.by_gid.get_mut(gid) else {
            return;
        };
        let records = &self.records;
        keys.sort_by(|a, b| {
            let ta = records.get(a).map_or(i64::MIN, |r| r.create_time_ms);
            let tb = records.get(b).map_or(i64::MIN, |r| r.create_time_ms);
            ta.cmp(&tb).then_with(|| a.cmp(b))
        });
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    fn fact(mid: Option<&str>, lid: Option<&str>, t: i64, src: MessageSource) -> MessageFact {
        MessageFact {
            gid: "g".into(),
            message_id: mid.map(Into::into),
            local_id: lid.map(Into::into),
            create_time_ms: t,
            sender_role: SenderRole::Customer,
            sender_id: "c".into(),
            kind: MsgKind::Business,
            source: src,
            disposition: None,
        }
    }

    #[test]
    fn same_server_id_from_three_sources_is_one_record() {
        let mut idx = MessageIndex::new();
        assert_eq!(
            idx.merge(&fact(Some("m1"), None, 10, MessageSource::Realtime))
                .unwrap(),
            MergeOutcome::Inserted
        );
        assert_eq!(
            idx.merge(&fact(Some("m1"), None, 10, MessageSource::Realtime))
                .unwrap(),
            MergeOutcome::Duplicate
        );
        assert_eq!(
            idx.merge(&fact(Some("m1"), None, 10, MessageSource::Compensation))
                .unwrap(),
            MergeOutcome::Duplicate
        );
        assert_eq!(
            idx.merge(&fact(Some("m1"), None, 10, MessageSource::History))
                .unwrap(),
            MergeOutcome::Duplicate
        );
        assert_eq!(idx.len(), 1);
        let rec = idx.find_by_message_id("g", "m1").unwrap();
        assert_eq!(rec.seen_count, 4);
        assert_eq!(
            rec.sources,
            vec![
                MessageSource::Realtime,
                MessageSource::Compensation,
                MessageSource::History
            ]
        );
    }

    #[test]
    fn local_id_is_relinked_to_server_id() {
        let mut idx = MessageIndex::new();
        let mut out = fact(None, Some("l1"), 100, MessageSource::Realtime);
        out.sender_role = SenderRole::MerchantSelf;
        out.disposition = Some(SendDisposition::Unknown);
        idx.merge(&out).unwrap();
        let mut ack = out.clone();
        ack.message_id = Some("t1".into());
        ack.disposition = Some(SendDisposition::Confirmed {
            server_message_id: "t1".into(),
            server_time_ms: 105,
        });
        assert!(matches!(
            idx.merge(&ack).unwrap(),
            MergeOutcome::Linked { .. }
        ));
        assert_eq!(idx.len(), 1);
        assert_eq!(idx.resolve_key("g#l:l1"), "g#m:t1");
        let rec = idx.find_by_local_id("g", "l1").unwrap();
        assert_eq!(rec.create_time_ms, 105);
        assert!(rec.is_confirmed_merchant_reply());
        // Later inbound copy of the same server id is a duplicate.
        let mut echo = fact(Some("t1"), Some("l1"), 105, MessageSource::Compensation);
        echo.sender_role = SenderRole::MerchantSelf;
        assert_eq!(idx.merge(&echo).unwrap(), MergeOutcome::Duplicate);
        assert_eq!(idx.len(), 1);
    }

    #[test]
    fn echo_before_ack_confirms_unknown_outbound() {
        let mut idx = MessageIndex::new();
        let mut out = fact(None, Some("l1"), 100, MessageSource::Realtime);
        out.sender_role = SenderRole::MerchantSelf;
        out.disposition = Some(SendDisposition::Unknown);
        idx.merge(&out).unwrap();
        let mut echo = fact(Some("t1"), Some("l1"), 103, MessageSource::Realtime);
        echo.sender_role = SenderRole::MerchantSelf;
        assert!(matches!(
            idx.merge(&echo).unwrap(),
            MergeOutcome::Linked { .. }
        ));
        let rec = idx.find_by_message_id("g", "t1").unwrap();
        assert!(rec.is_confirmed_merchant_reply());
        assert_eq!(rec.create_time_ms, 103);
    }

    #[test]
    fn out_of_order_arrivals_resort_by_server_time() {
        let mut idx = MessageIndex::new();
        idx.merge(&fact(Some("m3"), None, 30, MessageSource::Realtime))
            .unwrap();
        idx.merge(&fact(Some("m1"), None, 10, MessageSource::History))
            .unwrap();
        idx.merge(&fact(Some("m2"), None, 20, MessageSource::Compensation))
            .unwrap();
        let ids: Vec<_> = idx
            .ordered("g")
            .iter()
            .map(|r| r.message_id.clone().unwrap())
            .collect();
        assert_eq!(ids, vec!["m1", "m2", "m3"]);
    }

    #[test]
    fn unknown_role_is_resolved_by_later_copy() {
        let mut idx = MessageIndex::new();
        let mut f = fact(Some("m1"), None, 10, MessageSource::Realtime);
        f.sender_role = SenderRole::Unknown;
        idx.merge(&f).unwrap();
        f.sender_role = SenderRole::Robot;
        assert_eq!(idx.merge(&f).unwrap(), MergeOutcome::Updated);
        assert_eq!(
            idx.find_by_message_id("g", "m1").unwrap().sender_role,
            SenderRole::Robot
        );
    }

    #[test]
    fn unidentified_fact_is_rejected() {
        let mut idx = MessageIndex::new();
        let err = idx
            .merge(&fact(None, None, 1, MessageSource::Realtime))
            .unwrap_err();
        assert!(err.is(codes::IM_FACT_UNIDENTIFIED));
    }
}

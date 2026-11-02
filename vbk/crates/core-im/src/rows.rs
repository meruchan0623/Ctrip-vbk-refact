//! Stable history row identity (I-08 / I-28a, core side).
//!
//! The UI windows the message pane and keeps a reading anchor
//! `{scope, key, offset}`. That only works when a row keeps its identity
//! while pages merge in and while a local row is confirmed by the server.
//! This module owns that guarantee so the UI no longer fuzzy-matches rows.
//!
//! Guarantees (see the tests, including a deterministic property test):
//! * **unique** — a `(gid, message_id)` or `(gid, local_id)` names at most
//!   one row; re-merging a page never splits or duplicates a row;
//! * **stable** — `RowId` is fixed when the row is first seen and survives
//!   enrichment (`local_id` gaining a `message_id`, or the reverse);
//! * **monotonic** — rows are strictly ordered by
//!   `(create_time_ms, RowId)`. `RowId` is `(epoch, ordinal)`: `epoch`
//!   decreases for each older page and increases for each live batch,
//!   `ordinal` is the position inside that page. Rows of an older page
//!   therefore sort before same-millisecond rows of a newer one, and the
//!   order never depends on an id that can change.
//!
//! Conflicting server ids are never merged: a row that already has a
//! `message_id` does not adopt a different one through a shared local id.

use std::collections::BTreeMap;

use contracts::AppError;

use crate::codes;

/// One input row of a history page / live batch (no body).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowInput {
    pub message_id: Option<String>,
    pub local_id: Option<String>,
    pub create_time_ms: i64,
}

/// Page-internal position that never changes once assigned.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RowId {
    pub epoch: i64,
    pub ordinal: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryRow {
    pub id: RowId,
    pub message_id: Option<String>,
    pub local_id: Option<String>,
    pub create_time_ms: i64,
}

impl HistoryRow {
    /// Primary anchor key: the local id when known (it survives the server
    /// confirmation), otherwise the server id.
    pub fn key(&self) -> String {
        match (&self.local_id, &self.message_id) {
            (Some(l), _) => format!("l:{l}"),
            (None, Some(m)) => format!("m:{m}"),
            // Rows are only created from identified inputs.
            (None, None) => String::new(),
        }
    }
}

/// Which side of the loaded range a batch extends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PageKind {
    /// An older history page (`direction: prev`).
    Earlier,
    /// Realtime / compensation / first page: newest side.
    Live,
}

#[derive(Debug, Clone, Default)]
struct Thread {
    rows: Vec<HistoryRow>,
    by_message: BTreeMap<String, usize>,
    by_local: BTreeMap<String, usize>,
    next_back: i64,
    next_fwd: i64,
}

impl Thread {
    fn reindex(&mut self) {
        self.by_message.clear();
        self.by_local.clear();
        for (i, r) in self.rows.iter().enumerate() {
            if let Some(m) = &r.message_id {
                self.by_message.insert(m.clone(), i);
            }
            if let Some(l) = &r.local_id {
                self.by_local.insert(l.clone(), i);
            }
        }
    }

    fn find(&self, input: &RowInput) -> Option<usize> {
        if let Some(m) = &input.message_id {
            if let Some(&i) = self.by_message.get(m) {
                return Some(i);
            }
        }
        let l = input.local_id.as_ref()?;
        let &i = self.by_local.get(l)?;
        let row = &self.rows[i];
        // A shared local id never bridges two different server ids.
        match (&row.message_id, &input.message_id) {
            (Some(a), Some(b)) if a != b => None,
            _ => Some(i),
        }
    }
}

/// Per-account row identity tracker.
#[derive(Debug, Clone, Default)]
pub struct HistoryRowIndex {
    threads: BTreeMap<String, Thread>,
}

impl HistoryRowIndex {
    pub fn new() -> Self {
        Self::default()
    }

    /// Rows of one conversation in display order.
    pub fn rows(&self, gid: &str) -> &[HistoryRow] {
        self.threads.get(gid).map_or(&[], |t| t.rows.as_slice())
    }

    pub fn find_by_message_id(&self, gid: &str, message_id: &str) -> Option<&HistoryRow> {
        let t = self.threads.get(gid)?;
        t.by_message.get(message_id).map(|&i| &t.rows[i])
    }

    pub fn find_by_local_id(&self, gid: &str, local_id: &str) -> Option<&HistoryRow> {
        let t = self.threads.get(gid)?;
        t.by_local.get(local_id).map(|&i| &t.rows[i])
    }

    /// Merge one page / batch. A page with an input that has no id is
    /// rejected with `im.fact_unidentified` and nothing is applied.
    pub fn merge_page(
        &mut self,
        gid: &str,
        kind: PageKind,
        page: &[RowInput],
    ) -> Result<&[HistoryRow], AppError> {
        if page
            .iter()
            .any(|r| r.message_id.is_none() && r.local_id.is_none())
        {
            return Err(AppError::new(
                codes::IM_FACT_UNIDENTIFIED,
                "history row carries neither message_id nor local_id",
            ));
        }
        let thread = self
            .threads
            .entry(gid.to_string())
            .or_insert_with(|| Thread {
                next_back: -1,
                next_fwd: 0,
                ..Thread::default()
            });
        let epoch = match kind {
            PageKind::Earlier => {
                let e = thread.next_back;
                thread.next_back -= 1;
                e
            }
            PageKind::Live => {
                let e = thread.next_fwd;
                thread.next_fwd += 1;
                e
            }
        };
        for (ordinal, input) in page.iter().enumerate() {
            if let Some(i) = thread.find(input) {
                // The input may also name a second, sparse row (one holding
                // only the local id, one only the server id): bridge them.
                let other = input
                    .local_id
                    .as_ref()
                    .and_then(|l| thread.by_local.get(l))
                    .copied()
                    .filter(|&j| j != i && thread.rows[j].message_id.is_none());
                let other = other.or_else(|| {
                    input
                        .message_id
                        .as_ref()
                        .and_then(|m| thread.by_message.get(m))
                        .copied()
                        .filter(|&j| j != i && thread.rows[j].local_id.is_none())
                });
                let i = match other {
                    Some(j) => {
                        // A row from an earlier merge survives so a known id
                        // stays put; otherwise the smaller id does.
                        let fresh = |r: &HistoryRow| (r.id.epoch == epoch) as u8;
                        let rank = |r: &HistoryRow| (fresh(r), r.id);
                        let (keep, drop) = if rank(&thread.rows[i]) <= rank(&thread.rows[j]) {
                            (i, j)
                        } else {
                            (j, i)
                        };
                        let gone = thread.rows.remove(drop);
                        let keep = if drop < keep { keep - 1 } else { keep };
                        let row = &mut thread.rows[keep];
                        if row.message_id.is_none() {
                            row.message_id = gone.message_id;
                        }
                        if row.local_id.is_none() {
                            row.local_id = gone.local_id;
                        }
                        keep
                    }
                    None => i,
                };
                let row = &mut thread.rows[i];
                // Enrichment only: ids never change once set.
                if row.message_id.is_none() {
                    row.message_id = input.message_id.clone();
                }
                if row.local_id.is_none() {
                    row.local_id = input.local_id.clone();
                }
                // The server time wins over a local creation time.
                if input.message_id.is_some() {
                    row.create_time_ms = input.create_time_ms;
                }
            } else {
                thread.rows.push(HistoryRow {
                    id: RowId {
                        epoch,
                        ordinal: ordinal as u32,
                    },
                    message_id: input.message_id.clone(),
                    local_id: input.local_id.clone(),
                    create_time_ms: input.create_time_ms,
                });
            }
            // Later inputs of the same page must see this row.
            thread.rows.sort_by_key(|r| (r.create_time_ms, r.id));
            thread.reindex();
        }
        Ok(&thread.rows)
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    fn inp(m: Option<&str>, l: Option<&str>, t: i64) -> RowInput {
        RowInput {
            message_id: m.map(str::to_string),
            local_id: l.map(str::to_string),
            create_time_ms: t,
        }
    }

    fn assert_invariants(rows: &[HistoryRow]) {
        for w in rows.windows(2) {
            assert!(
                (w[0].create_time_ms, w[0].id) < (w[1].create_time_ms, w[1].id),
                "strictly monotonic"
            );
        }
        let mut m = std::collections::BTreeSet::new();
        let mut l = std::collections::BTreeSet::new();
        for r in rows {
            if let Some(x) = &r.message_id {
                assert!(m.insert(x.clone()), "duplicate message_id {x}");
            }
            if let Some(x) = &r.local_id {
                assert!(l.insert(x.clone()), "duplicate local_id {x}");
            }
        }
    }

    #[test]
    fn earlier_page_sorts_before_same_millisecond_live_rows() {
        let mut ix = HistoryRowIndex::new();
        ix.merge_page("g", PageKind::Live, &[inp(Some("m3"), None, 100)])
            .unwrap();
        let rows = ix
            .merge_page(
                "g",
                PageKind::Earlier,
                &[inp(Some("m1"), None, 100), inp(Some("m2"), None, 100)],
            )
            .unwrap();
        let ids: Vec<_> = rows.iter().map(|r| r.message_id.clone().unwrap()).collect();
        assert_eq!(ids, ["m1", "m2", "m3"]);
        assert_invariants(rows);
    }

    #[test]
    fn local_row_keeps_its_id_and_position_when_the_server_confirms() {
        let mut ix = HistoryRowIndex::new();
        ix.merge_page(
            "g",
            PageKind::Live,
            &[inp(None, Some("l1"), 50), inp(Some("m9"), None, 50)],
        )
        .unwrap();
        let before = ix.find_by_local_id("g", "l1").unwrap().id;
        let key = ix.find_by_local_id("g", "l1").unwrap().key();
        ix.merge_page("g", PageKind::Live, &[inp(Some("m1"), Some("l1"), 50)])
            .unwrap();
        let row = ix.find_by_message_id("g", "m1").unwrap();
        assert_eq!(row.id, before);
        assert_eq!(row.key(), key, "anchor key survives confirmation");
        assert_eq!(ix.rows("g").len(), 2);
        assert_invariants(ix.rows("g"));
    }

    #[test]
    fn replaying_a_page_is_idempotent() {
        let mut ix = HistoryRowIndex::new();
        let page = [inp(Some("a"), None, 1), inp(Some("b"), None, 2)];
        ix.merge_page("g", PageKind::Earlier, &page).unwrap();
        let first = ix.rows("g").to_vec();
        ix.merge_page("g", PageKind::Earlier, &page).unwrap();
        assert_eq!(ix.rows("g"), first.as_slice());
    }

    #[test]
    fn conflicting_server_ids_sharing_a_local_id_stay_separate() {
        let mut ix = HistoryRowIndex::new();
        ix.merge_page("g", PageKind::Live, &[inp(Some("m1"), Some("l"), 1)])
            .unwrap();
        ix.merge_page("g", PageKind::Live, &[inp(Some("m2"), Some("l"), 2)])
            .unwrap();
        assert_eq!(ix.rows("g").len(), 2);
    }

    #[test]
    fn unidentified_row_rejects_the_whole_page() {
        let mut ix = HistoryRowIndex::new();
        let e = ix
            .merge_page(
                "g",
                PageKind::Live,
                &[inp(Some("a"), None, 1), inp(None, None, 2)],
            )
            .unwrap_err();
        assert_eq!(e.code, codes::IM_FACT_UNIDENTIFIED);
        assert!(ix.rows("g").is_empty());
    }

    #[test]
    fn conversations_are_independent() {
        let mut ix = HistoryRowIndex::new();
        ix.merge_page("a", PageKind::Live, &[inp(Some("x"), None, 1)])
            .unwrap();
        ix.merge_page("b", PageKind::Live, &[inp(Some("x"), None, 1)])
            .unwrap();
        assert_eq!(ix.rows("a").len(), 1);
        assert_eq!(ix.rows("b").len(), 1);
    }

    /// Deterministic pseudo-random page streams: invariants hold after every
    /// merge, and a row's `RowId` never changes once assigned.
    #[test]
    fn random_page_streams_keep_rows_unique_monotonic_and_stable() {
        let mut seed = 0x9E37_79B9_7F4A_7C15u64;
        let mut next = move |n: u64| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed % n
        };
        for _ in 0..200 {
            let mut ix = HistoryRowIndex::new();
            let mut seen: BTreeMap<String, RowId> = BTreeMap::new();
            for _ in 0..12 {
                let kind = if next(2) == 0 {
                    PageKind::Earlier
                } else {
                    PageKind::Live
                };
                let page: Vec<RowInput> = (0..next(6) + 1)
                    .map(|_| {
                        let n = next(12);
                        let t = next(5) as i64; // many same-ms ties
                        match next(3) {
                            0 => inp(Some(&format!("m{n}")), None, t),
                            1 => inp(None, Some(&format!("l{n}")), t),
                            _ => inp(Some(&format!("m{n}")), Some(&format!("l{n}")), t),
                        }
                    })
                    .collect();
                let rows = ix.merge_page("g", kind, &page).unwrap();
                assert_invariants(rows);
                for r in rows {
                    let mk = r.message_id.as_ref().map(|m| format!("m{m}"));
                    let lk = r.local_id.as_ref().map(|l| format!("l{l}"));
                    let known: Vec<RowId> = [&mk, &lk]
                        .into_iter()
                        .flatten()
                        .filter_map(|k| seen.get(k).copied())
                        .collect();
                    // Stable unless two sparse rows were bridged, in which
                    // case the earlier-seen id survives.
                    if let Some(min) = known.iter().min() {
                        assert_eq!(*min, r.id, "RowId changed for {mk:?}/{lk:?}");
                    }
                    for k in [mk, lk].into_iter().flatten() {
                        seen.insert(k, r.id);
                    }
                }
            }
        }
    }
}

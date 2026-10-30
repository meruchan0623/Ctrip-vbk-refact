//! Sync watermarks (F05, plan §7 "IM分页措辞", research transport §6).
//!
//! * The conversation-list cursor (`lastUpdateTime`) and the compensation
//!   cursor (`lastMessageTimestamp`) are separate chains and never swapped.
//! * Per conversation, `HistoryWindow` keeps the next page breakpoint and the
//!   oldest loaded time apart from `complete_watermark_ms`, which advances
//!   **only** through `prove_history_complete` with the server's
//!   `rangeMessage.isDone`. "Max time seen" never implies completeness.

use std::collections::BTreeMap;

/// Backward history window of one conversation.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct HistoryWindow {
    /// `endTime` to pass to the next `direction=prev` page. Saved per page;
    /// says nothing about completeness.
    pub page_breakpoint_ms: Option<i64>,
    /// `Some(t)`: the server proved (`isDone`) that no message older than
    /// `t` exists, i.e. the loaded window reaches the conversation start.
    pub complete_watermark_ms: Option<i64>,
    /// Oldest create time loaded through history pages.
    pub oldest_loaded_ms: Option<i64>,
    /// Newest create time seen from any source. Informational only.
    pub latest_seen_ms: Option<i64>,
}

impl HistoryWindow {
    pub fn is_complete(&self) -> bool {
        self.complete_watermark_ms.is_some()
    }
}

/// Plain persistence form of `SyncWatermarks` (the store crate owns the
/// serialization).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncStateSnapshot {
    pub list_cursor_ms: Option<i64>,
    pub compensation_cursor_ms: Option<i64>,
    pub history: Vec<(String, HistoryWindow)>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncWatermarks {
    list_cursor_ms: Option<i64>,
    compensation_cursor_ms: Option<i64>,
    history: BTreeMap<String, HistoryWindow>,
}

impl SyncWatermarks {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_snapshot(snapshot: SyncStateSnapshot) -> Self {
        Self {
            list_cursor_ms: snapshot.list_cursor_ms,
            compensation_cursor_ms: snapshot.compensation_cursor_ms,
            history: snapshot.history.into_iter().collect(),
        }
    }

    pub fn snapshot(&self) -> SyncStateSnapshot {
        SyncStateSnapshot {
            list_cursor_ms: self.list_cursor_ms,
            compensation_cursor_ms: self.compensation_cursor_ms,
            history: self
                .history
                .iter()
                .map(|(gid, w)| (gid.clone(), *w))
                .collect(),
        }
    }

    pub fn list_cursor_ms(&self) -> Option<i64> {
        self.list_cursor_ms
    }

    pub fn compensation_cursor_ms(&self) -> Option<i64> {
        self.compensation_cursor_ms
    }

    pub fn history(&self, gid: &str) -> Option<&HistoryWindow> {
        self.history.get(gid)
    }

    /// `getConversationList` finished with the server's `lastUpdateTime`.
    pub fn note_list_sync(&mut self, last_update_time_ms: Option<i64>) {
        if let Some(t) = last_update_time_ms {
            self.list_cursor_ms = Some(self.list_cursor_ms.map_or(t, |c| c.max(t)));
        }
    }

    /// `getRecentMessages` finished with the server's `lastMessageTimestamp`.
    pub fn note_compensation_sync(&mut self, last_message_timestamp_ms: Option<i64>) {
        if let Some(t) = last_message_timestamp_ms {
            self.compensation_cursor_ms = Some(self.compensation_cursor_ms.map_or(t, |c| c.max(t)));
        }
    }

    /// A message of any source was seen. Only moves `latest_seen_ms`.
    pub fn note_message_seen(&mut self, gid: &str, create_time_ms: i64) {
        let w = self.history.entry(gid.to_string()).or_default();
        w.latest_seen_ms = Some(
            w.latest_seen_ms
                .map_or(create_time_ms, |l| l.max(create_time_ms)),
        );
    }

    /// Whether history has been paged for this conversation at all.
    pub fn has_history_window(&self, gid: &str) -> bool {
        self.paged_history(gid).is_some()
    }

    /// The window only when history pages were actually loaded (a window
    /// that merely tracks `latest_seen_ms` says nothing about the past).
    pub fn paged_history(&self, gid: &str) -> Option<&HistoryWindow> {
        self.history.get(gid).filter(|w| {
            w.oldest_loaded_ms.is_some() || w.page_breakpoint_ms.is_some() || w.is_complete()
        })
    }

    /// One `getMessageList` page (`direction=prev`) landed. Saves the
    /// breakpoint and the oldest time; never touches the complete watermark.
    pub fn note_history_page(
        &mut self,
        gid: &str,
        oldest_in_page_ms: i64,
        next_breakpoint_ms: Option<i64>,
    ) {
        let w = self.history.entry(gid.to_string()).or_default();
        w.oldest_loaded_ms = Some(
            w.oldest_loaded_ms
                .map_or(oldest_in_page_ms, |o| o.min(oldest_in_page_ms)),
        );
        w.page_breakpoint_ms = next_breakpoint_ms;
    }

    /// The only way to advance `complete_watermark_ms`: the server's
    /// `isDone` for a backward page whose oldest message is `oldest_ms`.
    /// Returns whether the watermark advanced.
    pub fn prove_history_complete(
        &mut self,
        gid: &str,
        is_done_from_server: bool,
        oldest_ms: i64,
    ) -> bool {
        let w = self.history.entry(gid.to_string()).or_default();
        w.oldest_loaded_ms = Some(w.oldest_loaded_ms.map_or(oldest_ms, |o| o.min(oldest_ms)));
        if !is_done_from_server {
            return false;
        }
        let new = w
            .complete_watermark_ms
            .map_or(oldest_ms, |c| c.min(oldest_ms));
        let advanced = w.complete_watermark_ms != Some(new);
        w.complete_watermark_ms = Some(new);
        w.page_breakpoint_ms = None;
        advanced
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complete_watermark_only_via_proof() {
        let mut wm = SyncWatermarks::new();
        wm.note_message_seen("g", 1_000);
        wm.note_message_seen("g", 9_000);
        wm.note_history_page("g", 500, Some(500));
        let w = *wm.history("g").expect("window");
        assert_eq!(w.latest_seen_ms, Some(9_000));
        assert_eq!(w.oldest_loaded_ms, Some(500));
        assert_eq!(w.page_breakpoint_ms, Some(500));
        assert!(!w.is_complete());
        assert!(!wm.prove_history_complete("g", false, 400));
        assert!(!wm.history("g").is_some_and(HistoryWindow::is_complete));
        assert!(wm.prove_history_complete("g", true, 400));
        let w = *wm.history("g").expect("window");
        assert_eq!(w.complete_watermark_ms, Some(400));
        assert_eq!(w.page_breakpoint_ms, None);
    }

    #[test]
    fn cursors_are_separate_and_monotonic() {
        let mut wm = SyncWatermarks::new();
        wm.note_list_sync(Some(10));
        wm.note_list_sync(Some(5));
        wm.note_compensation_sync(Some(7));
        wm.note_compensation_sync(None);
        assert_eq!(wm.list_cursor_ms(), Some(10));
        assert_eq!(wm.compensation_cursor_ms(), Some(7));
        let snap = wm.snapshot();
        assert_eq!(SyncWatermarks::from_snapshot(snap), wm);
    }
}

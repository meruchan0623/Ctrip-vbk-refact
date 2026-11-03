//! Retention plan for completed outbound-journal records (I-14), std-only.
//!
//! Only *completed* records (confirmed / rejected) are ever candidates.
//! `unknown`, in-flight and upload-stage records are never pruned: they are
//! the safety fence that stops a replay, and only a human decision may end
//! them. A pruned `local_id` loses its same-id replay protection, so the
//! window must be far longer than any UI retry horizon (local ids are UUIDs
//! and are never reused by the UI).

/// 30 days.
pub const DEFAULT_WINDOW_MS: i64 = 30 * 24 * 60 * 60 * 1000;
pub const DEFAULT_MAX_COMPLETED: usize = 2000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetentionPolicy {
    pub window_ms: i64,
    pub max_completed: usize,
}

impl Default for RetentionPolicy {
    fn default() -> Self {
        Self {
            window_ms: DEFAULT_WINDOW_MS,
            max_completed: DEFAULT_MAX_COMPLETED,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetentionEntry {
    pub key: String,
    /// `Some(t)` only for a completed (confirmed/rejected) record. `None` for
    /// everything else, which therefore is never selected.
    pub completed_at_ms: Option<i64>,
}

/// Keys to delete: completed records older than the window, then the oldest
/// completed records beyond `max_completed`. Deterministic (oldest first, key
/// as tiebreak).
pub fn prune_keys(entries: &[RetentionEntry], now_ms: i64, policy: RetentionPolicy) -> Vec<String> {
    let mut completed: Vec<(i64, &str)> = entries
        .iter()
        .filter_map(|e| e.completed_at_ms.map(|t| (t, e.key.as_str())))
        .collect();
    completed.sort();
    let mut dropped = Vec::new();
    let mut kept = Vec::new();
    for (t, key) in completed {
        // A timestamp in the future (clock moved back) counts as age zero.
        if now_ms.saturating_sub(t) > policy.window_ms {
            dropped.push(key.to_string());
        } else {
            kept.push(key);
        }
    }
    let excess = kept.len().saturating_sub(policy.max_completed);
    dropped.extend(kept.into_iter().take(excess).map(str::to_string));
    dropped
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    fn done(key: &str, t: i64) -> RetentionEntry {
        RetentionEntry {
            key: key.into(),
            completed_at_ms: Some(t),
        }
    }
    fn open(key: &str) -> RetentionEntry {
        RetentionEntry {
            key: key.into(),
            completed_at_ms: None,
        }
    }
    const P: RetentionPolicy = RetentionPolicy {
        window_ms: 1000,
        max_completed: 2,
    };

    #[test]
    fn unknown_and_in_flight_are_never_selected_however_old() {
        let entries = [open("unknown-ancient"), open("uploading"), done("old", 0)];
        assert_eq!(prune_keys(&entries, 1_000_000, P), vec!["old".to_string()]);
    }

    #[test]
    fn window_boundary_is_exclusive_and_future_timestamps_are_kept() {
        let entries = [done("edge", 0), done("future", 5_000)];
        assert!(prune_keys(&entries, 1000, P).is_empty());
        assert_eq!(prune_keys(&entries, 1001, P), vec!["edge".to_string()]);
    }

    #[test]
    fn count_cap_drops_oldest_completed_first() {
        let entries = [done("c", 30), done("a", 10), done("b", 20), done("d", 40)];
        assert_eq!(
            prune_keys(&entries, 50, P),
            vec!["a".to_string(), "b".to_string()]
        );
        assert!(prune_keys(&entries[..2], 50, P).is_empty());
    }

    #[test]
    fn window_and_cap_combine_without_double_counting() {
        let entries = [
            done("stale", 0),
            done("a", 9000),
            done("b", 9100),
            done("c", 9200),
        ];
        assert_eq!(
            prune_keys(&entries, 9300, P),
            vec!["stale".to_string(), "a".to_string()]
        );
    }
}

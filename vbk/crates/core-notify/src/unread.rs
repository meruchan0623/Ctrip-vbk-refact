//! L0 silent count: unread aggregation across accounts → taskbar badge.

use std::collections::BTreeMap;

use contracts::AccountContext;

/// Taskbar badge content derived from the unread total (1–99, then "99+").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BadgeText {
    /// No badge (zero unread or badge disabled in settings).
    #[default]
    None,
    /// 1..=99.
    Count(u8),
    /// More than 99.
    Overflow,
}

impl BadgeText {
    pub fn from_total(total: u32) -> Self {
        match total {
            0 => BadgeText::None,
            1..=99 => BadgeText::Count(total as u8),
            _ => BadgeText::Overflow,
        }
    }

    /// The text to render, or `None` to clear the badge.
    pub fn text(&self) -> Option<String> {
        match self {
            BadgeText::None => None,
            BadgeText::Count(n) => Some(n.to_string()),
            BadgeText::Overflow => Some("99+".to_string()),
        }
    }
}

/// Per-conversation unread counts keyed by persistent account identity.
#[derive(Debug, Default)]
pub(crate) struct UnreadBook {
    counts: BTreeMap<(String, String, String), u32>,
    total: u64,
}

impl UnreadBook {
    fn key(account: &AccountContext, gid: &str) -> (String, String, String) {
        (
            account.environment.as_str().to_string(),
            account.account_id.as_str().to_string(),
            gid.to_string(),
        )
    }

    /// Records the count; returns whether the stored value changed.
    pub(crate) fn set(&mut self, account: &AccountContext, gid: &str, unread: u32) -> bool {
        let key = Self::key(account, gid);
        let previous = if unread == 0 {
            self.counts.remove(&key)
        } else {
            self.counts.insert(key, unread)
        };
        self.total = self.total - u64::from(previous.unwrap_or(0)) + u64::from(unread);
        previous.unwrap_or(0) != unread
    }

    pub(crate) fn total(&self) -> u32 {
        self.total.min(u64::from(u32::MAX)) as u32
    }

    /// Drops every count of one persistent account; returns whether any
    /// count was removed.
    pub(crate) fn clear_account(&mut self, environment: &str, account_id: &str) -> bool {
        let before = self.counts.len();
        let total = &mut self.total;
        self.counts.retain(|(env, id, _), count| {
            if env == environment && id == account_id {
                *total -= u64::from(*count);
                false
            } else {
                true
            }
        });
        self.counts.len() != before
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use contracts::{AccountId, Environment};

    fn acc(id: &str) -> AccountContext {
        AccountContext::new(AccountId::new(id), Environment::production(), 1)
    }

    #[test]
    fn badge_text_boundaries() {
        assert_eq!(BadgeText::from_total(0), BadgeText::None);
        assert_eq!(BadgeText::from_total(1).text().as_deref(), Some("1"));
        assert_eq!(BadgeText::from_total(99).text().as_deref(), Some("99"));
        assert_eq!(BadgeText::from_total(100), BadgeText::Overflow);
        assert_eq!(BadgeText::Overflow.text().as_deref(), Some("99+"));
    }

    #[test]
    fn cached_total_matches_saturated_oracle_after_overflow_and_removal() {
        let mut book = UnreadBook::default();
        assert!(book.set(&acc("a"), "g", u32::MAX));
        assert!(book.set(&acc("b"), "g", u32::MAX));
        assert_eq!(book.total(), u32::MAX);
        assert!(book.set(&acc("a"), "g", 0));
        assert_eq!(book.total(), u32::MAX);
        assert!(book.set(&acc("b"), "g", 7));
        assert_eq!(book.total(), 7);
        for i in 0..500 {
            let account = acc(if i % 2 == 0 { "a" } else { "b" });
            let gid = format!("g{}", i % 11);
            book.set(&account, &gid, if i % 7 == 0 { 0 } else { u32::MAX / 3 });
            if i % 13 == 0 {
                book.clear_account("production", "b");
            }
            let oracle = book
                .counts
                .values()
                .fold(0u32, |sum, n| sum.saturating_add(*n));
            assert_eq!(book.total(), oracle);
            assert_eq!(
                book.total,
                book.counts.values().map(|n| u64::from(*n)).sum::<u64>()
            );
        }
    }

    #[test]
    fn aggregates_across_accounts_and_clears() {
        let mut book = UnreadBook::default();
        assert!(book.set(&acc("a"), "g1", 3));
        assert!(!book.set(&acc("a"), "g1", 3));
        assert!(book.set(&acc("b"), "g1", 4));
        assert_eq!(book.total(), 7);
        assert!(book.set(&acc("a"), "g1", 0));
        assert_eq!(book.total(), 4);
        assert!(book.clear_account("production", "b"));
        assert_eq!(book.total(), 0);
        assert!(!book.clear_account("production", "b"));
    }
}

//! L2 banner bookkeeping: per-conversation merge counts, the 6 s stay
//! window, lock-screen hold and the new-message sound throttle.
//!
//! The host renders the banner (notifier window or system toast) and owns
//! hover-pause; the core only decides *whether* to show one and with what
//! merged count.

use contracts::AccountContext;

use crate::now::Now;

/// Banner stays on screen this long without hover (design default).
pub const BANNER_STAY_MS: u64 = 6_000;
/// Notifier banner width in logical pixels (design default; informative).
pub const BANNER_WIDTH_PX: u32 = 360;
/// Maximum stacked banners before the host folds the rest (informative).
pub const BANNER_MAX_STACKED: usize = 3;
/// New-message sound plays at most once per this interval.
pub const NEW_MESSAGE_SOUND_MIN_GAP_MS: u64 = 1_500;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BannerEntry {
    pub account: AccountContext,
    pub gid: String,
    pub count: u32,
    last_bump_monotonic: u64,
    /// Accumulated while the screen was locked; released on unlock.
    pub held: bool,
}

#[derive(Debug, Default)]
pub(crate) struct BannerBook {
    entries: Vec<BannerEntry>,
    last_sound_monotonic: Option<u64>,
}

impl BannerBook {
    /// Merges a new message into the conversation's banner (or opens one)
    /// and returns the merged count. A banner older than the stay window
    /// is replaced, so the count restarts at 1.
    pub(crate) fn bump(
        &mut self,
        account: &AccountContext,
        gid: &str,
        now: &Now,
        held: bool,
    ) -> u32 {
        self.expire(now);
        if let Some(e) = self
            .entries
            .iter_mut()
            .find(|e| e.account == *account && e.gid == gid)
        {
            e.count = e.count.saturating_add(1);
            e.last_bump_monotonic = now.monotonic_ms;
            e.held |= held;
            return e.count;
        }
        self.entries.push(BannerEntry {
            account: account.clone(),
            gid: gid.to_string(),
            count: 1,
            last_bump_monotonic: now.monotonic_ms,
            held,
        });
        1
    }

    /// Forgets banners whose stay window has elapsed (held ones persist).
    pub(crate) fn expire(&mut self, now: &Now) {
        self.entries.retain(|e| {
            e.held || now.monotonic_ms.saturating_sub(e.last_bump_monotonic) < BANNER_STAY_MS
        });
    }

    /// Releases banners accumulated during lock; they become live again
    /// with their stay window restarted at `now`.
    pub(crate) fn take_held(&mut self, now: &Now) -> Vec<BannerEntry> {
        let mut released = Vec::new();
        for e in self.entries.iter_mut().filter(|e| e.held) {
            e.held = false;
            e.last_bump_monotonic = now.monotonic_ms;
            released.push(e.clone());
        }
        released
    }

    /// Whether a new-message sound may play now; records it when allowed.
    pub(crate) fn try_sound(&mut self, now: &Now) -> bool {
        let allowed = match self.last_sound_monotonic {
            None => true,
            Some(last) => now.monotonic_ms.saturating_sub(last) >= NEW_MESSAGE_SOUND_MIN_GAP_MS,
        };
        if allowed {
            self.last_sound_monotonic = Some(now.monotonic_ms);
        }
        allowed
    }

    pub(crate) fn clear_account(&mut self, environment: &str, account_id: &str) {
        self.entries.retain(|e| {
            !(e.account.environment.as_str() == environment
                && e.account.account_id.as_str() == account_id)
        });
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use contracts::{AccountId, Environment};

    fn acc() -> AccountContext {
        AccountContext::new(AccountId::new("a"), Environment::production(), 1)
    }

    #[test]
    fn merges_within_stay_window_and_restarts_after() {
        let mut book = BannerBook::default();
        let t0 = Now::new(10_000, 1_000, true);
        assert_eq!(book.bump(&acc(), "g", &t0, false), 1);
        assert_eq!(book.bump(&acc(), "g", &t0.plus_ms(5_999), false), 2);
        assert_eq!(book.bump(&acc(), "g", &t0.plus_ms(5_999 + 6_000), false), 1);
        assert_eq!(book.bump(&acc(), "h", &t0.plus_ms(12_000), false), 1);
        assert_eq!(book.len(), 2);
    }

    #[test]
    fn held_banners_survive_expiry_and_release_once() {
        let mut book = BannerBook::default();
        let t0 = Now::new(0, 0, true);
        book.bump(&acc(), "g", &t0, true);
        book.bump(&acc(), "g", &t0.plus_ms(100), true);
        book.expire(&t0.plus_ms(60_000));
        let released = book.take_held(&t0.plus_ms(60_000));
        assert_eq!(released.len(), 1);
        assert_eq!(released[0].count, 2);
        assert!(book.take_held(&t0.plus_ms(60_000)).is_empty());
    }

    #[test]
    fn sound_throttle() {
        let mut book = BannerBook::default();
        let t0 = Now::new(0, 0, true);
        assert!(book.try_sound(&t0));
        assert!(!book.try_sound(&t0.plus_ms(1_499)));
        assert!(book.try_sound(&t0.plus_ms(1_500)));
    }
}

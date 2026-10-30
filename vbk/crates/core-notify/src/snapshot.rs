//! Desensitized alarm snapshot helpers (strong-alert §6).
//!
//! The crate has no field for message text at all; the only customer-
//! related string is the already masked conversation label, and even that
//! is replaced while the screen is locked.

use contracts::notify::RED_AFTER_SECONDS;
use contracts::AlarmEntry;

/// Label shown for every entry while the screen is locked.
pub const LOCKED_LABEL: &str = "●●●";

/// Keeps the first and last character and replaces the middle with `*`.
/// Strings of one or two characters become `"*"`; an empty string stays
/// empty.
pub fn mask_label(label: &str) -> String {
    let chars: Vec<char> = label.chars().collect();
    match chars.len() {
        0 => String::new(),
        1 | 2 => "*".to_string(),
        n => {
            let mut out = String::with_capacity(label.len());
            out.push(chars[0]);
            out.push_str(&"*".repeat(n - 2));
            out.push(chars[n - 1]);
            out
        }
    }
}

/// Whether the entry should be rendered red (waited longer than
/// [`RED_AFTER_SECONDS`]). Unconfirmed starts are never red.
pub fn is_red(entry: &AlarmEntry) -> bool {
    entry.start_confirmed && entry.waited_seconds > u64::from(RED_AFTER_SECONDS)
}

/// Sort order of the alarm list: longest wait first, then stable keys.
pub(crate) fn sort_entries(entries: &mut [AlarmEntry]) {
    entries.sort_by(|a, b| {
        b.waited_seconds
            .cmp(&a.waited_seconds)
            .then_with(|| a.account.account_id.cmp(&b.account.account_id))
            .then_with(|| a.gid.cmp(&b.gid))
            .then_with(|| a.round_id.cmp(&b.round_id))
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use contracts::{AccountContext, AccountId, AlarmLevel, Environment};

    #[test]
    fn mask_keeps_ends_only() {
        assert_eq!(mask_label(""), "");
        assert_eq!(mask_label("a"), "*");
        assert_eq!(mask_label("ab"), "*");
        assert_eq!(mask_label("abc"), "a*c");
        assert_eq!(mask_label("张三丰"), "张*丰");
        assert_eq!(mask_label("customer"), "c******r");
    }

    #[test]
    fn red_after_threshold() {
        let entry = |waited: u64, confirmed: bool| AlarmEntry {
            account: AccountContext::new(AccountId::new("a"), Environment::production(), 1),
            gid: "g".into(),
            round_id: "r".into(),
            version: 1,
            label: "x".into(),
            waiting_since_ms: Some(0),
            waited_seconds: waited,
            level: AlarmLevel::L3,
            start_confirmed: confirmed,
            snoozed_until_ms: None,
        };
        assert!(!is_red(&entry(90, true)));
        assert!(is_red(&entry(91, true)));
        assert!(!is_red(&entry(500, false)));
    }
}

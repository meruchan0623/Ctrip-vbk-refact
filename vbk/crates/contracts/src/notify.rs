//! Alarm / reminder DTOs shared by core-notify, the Tauri host and the
//! `alarm` window (strong-alert §2, §6).
//!
//! The alarm window only ever receives a desensitized snapshot built by Rust;
//! commands are limited to the set below and every command carries the
//! round id + version it acts on so a stale click cannot hide a newer round.

use crate::identity::AccountContext;

/// Escalation level (strong-alert §2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum AlarmLevel {
    /// Silent count: tray text, taskbar badge.
    L0,
    /// Flash: tray/taskbar flashing while main is not foreground.
    L1,
    /// Banner + one sound.
    L2,
    /// Strong alert window: first unanswered customer message waited ≥ T1.
    L3,
    /// Continuous strong alert (opt-in): L3 + T2 elapsed.
    L4,
}

/// Snooze options offered by the alarm window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SnoozeMinutes {
    Five,
    Ten,
    Thirty,
}

impl SnoozeMinutes {
    pub fn as_millis(self) -> u64 {
        let minutes: u64 = match self {
            SnoozeMinutes::Five => 5,
            SnoozeMinutes::Ten => 10,
            SnoozeMinutes::Thirty => 30,
        };
        minutes * 60 * 1000
    }
}

/// Allowed T1 thresholds in seconds (strong-alert §2).
pub const ALLOWED_T1_SECONDS: [u32; 5] = [30, 60, 90, 120, 180];
pub const DEFAULT_T1_SECONDS: u32 = 30;
/// L3 → L4 delay.
pub const T2_SECONDS: u32 = 60;
/// L4 loop sound period and cap.
pub const L4_SOUND_PERIOD_SECONDS: u32 = 15;
pub const L4_SOUND_CAP_SECONDS: u32 = 600;
/// Waiting time after which the alarm entry is rendered red.
pub const RED_AFTER_SECONDS: u32 = 90;

/// Reminder settings (strong-alert §2 "设置项").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReminderSettings {
    pub enabled: bool,
    pub t1_seconds: u32,
    pub timeout_sound: bool,
    /// L4 continuous reminder; default off.
    pub continuous_l4: bool,
    pub position_bottom_right: bool,
    /// "勿扰时仍提醒回复超时", default on.
    pub alert_during_dnd: bool,
    /// "全屏时仍弹回复超时", default on.
    pub alert_during_fullscreen: bool,
    pub tray_flash: bool,
    pub taskbar_badge: bool,
}

impl Default for ReminderSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            t1_seconds: DEFAULT_T1_SECONDS,
            timeout_sound: true,
            continuous_l4: false,
            position_bottom_right: true,
            alert_during_dnd: true,
            alert_during_fullscreen: true,
            tray_flash: true,
            taskbar_badge: true,
        }
    }
}

impl ReminderSettings {
    pub fn is_allowed_t1(seconds: u32) -> bool {
        ALLOWED_T1_SECONDS.contains(&seconds)
    }
}

/// One alarm entry. Desensitized: no customer text, no credentials.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlarmEntry {
    pub account: AccountContext,
    pub gid: String,
    pub round_id: String,
    /// Round version; hide/ack commands must echo it.
    pub version: u64,
    /// Display label for the conversation (already masked by Rust, e.g.
    /// customer nick with middle characters replaced); never raw message
    /// text.
    pub label: String,
    /// Server time (ms) of the first unanswered customer message of this
    /// round; `None` when the start is still "待核对".
    pub waiting_since_ms: Option<i64>,
    /// Seconds waited as computed by Rust at snapshot time.
    pub waited_seconds: u64,
    pub level: AlarmLevel,
    /// Whether the start time is confirmed (false → show "待核对").
    pub start_confirmed: bool,
    pub snoozed_until_ms: Option<i64>,
}

/// Snapshot delivered to the alarm window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlarmSnapshot {
    pub generated_at_ms: i64,
    pub clock_trusted: bool,
    /// Reconciling/stale: entries are kept but no new popups or sounds.
    pub reconciling: bool,
    pub settings: ReminderSettings,
    pub entries: Vec<AlarmEntry>,
}

/// Commands the alarm window may issue (strong-alert §6). Nothing here can
/// send a message, finish a conversation or open an arbitrary URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AlarmCommand {
    Snapshot,
    OpenConversation {
        account: AccountContext,
        gid: String,
        round_id: String,
        version: u64,
    },
    HideRound {
        account: AccountContext,
        gid: String,
        round_id: String,
        version: u64,
    },
    HideAll {
        /// Versions snapshot the user saw; rounds newer than listed stay.
        seen: Vec<(String, String, u64)>,
    },
    Snooze {
        account: AccountContext,
        gid: String,
        round_id: String,
        version: u64,
        minutes: SnoozeMinutes,
    },
    SetEnabled(bool),
    SetThreshold { t1_seconds: u32 },
    SetSoundEnabled(bool),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_follow_design() {
        let s = ReminderSettings::default();
        assert!(s.enabled);
        assert_eq!(s.t1_seconds, 30);
        assert!(!s.continuous_l4);
        assert!(s.alert_during_dnd);
        assert!(ReminderSettings::is_allowed_t1(90));
        assert!(!ReminderSettings::is_allowed_t1(45));
        assert_eq!(SnoozeMinutes::Thirty.as_millis(), 30 * 60 * 1000);
        assert!(AlarmLevel::L3 < AlarmLevel::L4);
    }
}

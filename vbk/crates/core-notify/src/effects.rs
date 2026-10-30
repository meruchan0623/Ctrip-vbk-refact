//! Effects the host executes. The core never performs I/O; every input
//! method returns the effects it causes and [`crate::NotifyCore::tick`]
//! returns the time-driven ones.

use contracts::AccountContext;

use crate::unread::BadgeText;

/// Which clip to play. The host owns decoding, mixing and devices.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Sound {
    /// New-message tone (L2), throttled to one per 1.5 s.
    NewMessage,
    /// Reply-timeout tone (L3), at most once per round.
    Timeout,
    /// One iteration of the L4 loop (every 15 s, ≤ 10 min).
    Loop,
}

/// Host-side actions requested by the core.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    /// Show the alarm window (without stealing focus). `raise: true` asks
    /// for one re-top (level change); `raise: false` only makes it visible.
    ShowAlarm { raise: bool },
    /// The alarm window is visible and its snapshot changed (1 Hz refresh
    /// or list change). Never re-tops the window.
    UpdateAlarm,
    /// No presentable entry remains (or the environment forbids the
    /// window): hide it.
    HideAlarm,
    PlaySound(Sound),
    /// Cut any clip that is still playing.
    StopSound,
    /// Start (`true`) or stop (`false`) tray / taskbar flashing.
    TrayFlash(bool),
    /// L0: unread total across accounts and the taskbar badge to render.
    Unread { total: u32, badge: BadgeText },
    /// L2 self-drawn banner, merged per conversation.
    Banner {
        account: AccountContext,
        gid: String,
        /// Messages merged into this banner within the stay window.
        count: u32,
        stay_ms: u64,
    },
    /// L2 degraded to a system notification (full-screen application).
    SystemToast {
        account: AccountContext,
        gid: String,
        count: u32,
    },
}

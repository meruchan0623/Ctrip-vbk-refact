//! Environment policy for L3/L4 presentation (strong-alert §2 "勿扰" and
//! the archived degradation matrix §4.7).
//!
//! Degradation changes the *channel*, never the round's level. When the
//! environment recovers, rounds that could not be shown are raised once.

use contracts::notify::{L4_SOUND_CAP_SECONDS, L4_SOUND_PERIOD_SECONDS};
use contracts::ReminderSettings;

use crate::engine::SystemState;

/// L4 loop period in milliseconds.
pub const L4_PERIOD_MS: u64 = L4_SOUND_PERIOD_SECONDS as u64 * 1000;
/// L4 loop cap in milliseconds (elapsed in L4).
pub const L4_CAP_MS: u64 = L4_SOUND_CAP_SECONDS as u64 * 1000;

/// What the current environment allows for the alarm window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Policy {
    /// New `ShowAlarm` raises may happen.
    pub window_new: bool,
    /// An already visible alarm window may stay; `false` hides it.
    pub window_keep: bool,
    /// Timeout / loop sounds may play.
    pub sound: bool,
    /// Tray/taskbar attention may be requested.
    pub flash: bool,
}

/// Inputs the policy depends on, gathered by the core.
#[derive(Debug, Clone, Copy)]
pub(crate) struct PolicyInput<'a> {
    pub settings: &'a ReminderSettings,
    pub system: &'a SystemState,
    /// Reconciling, or unlocked but not yet reconciled.
    pub barrier: bool,
    pub dnd_active: bool,
    pub ring_while_locked: bool,
}

pub(crate) fn policy(input: PolicyInput<'_>) -> Policy {
    let PolicyInput {
        settings,
        system,
        barrier,
        dnd_active,
        ring_while_locked,
    } = input;
    if barrier {
        // Keep entries and the window, pause new popups and sounds.
        return Policy {
            window_new: false,
            window_keep: true,
            sound: false,
            flash: false,
        };
    }
    if system.locked {
        // Hide customer content, stop sounds (unless the user opted in to
        // ringing while locked); nothing pops until reconcile after unlock.
        return Policy {
            window_new: false,
            window_keep: false,
            sound: ring_while_locked,
            flash: false,
        };
    }
    if system.presentation {
        return Policy {
            window_new: false,
            window_keep: false,
            sound: false,
            flash: true,
        };
    }
    if system.focus_assist {
        // L3 delayed, muted; an already visible window stays.
        return Policy {
            window_new: false,
            window_keep: true,
            sound: false,
            flash: false,
        };
    }
    if dnd_active && !settings.alert_during_dnd {
        return Policy {
            window_new: false,
            window_keep: false,
            sound: false,
            flash: false,
        };
    }
    if system.fullscreen_app && !settings.alert_during_fullscreen {
        // No window; flash plus the one-shot sound only.
        return Policy {
            window_new: false,
            window_keep: false,
            sound: true,
            flash: true,
        };
    }
    Policy {
        window_new: true,
        window_keep: true,
        sound: true,
        flash: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input<'a>(settings: &'a ReminderSettings, system: &'a SystemState) -> PolicyInput<'a> {
        PolicyInput {
            settings,
            system,
            barrier: false,
            dnd_active: false,
            ring_while_locked: false,
        }
    }

    #[test]
    fn matrix() {
        let s = ReminderSettings::default();
        let sys = SystemState::default();
        assert!(policy(input(&s, &sys)).window_new);

        let p = policy(PolicyInput {
            barrier: true,
            ..input(&s, &sys)
        });
        assert!(!p.window_new && p.window_keep && !p.sound);

        let locked = SystemState {
            locked: true,
            ..SystemState::default()
        };
        let p = policy(input(&s, &locked));
        assert!(!p.window_keep && !p.sound);
        let p = policy(PolicyInput {
            ring_while_locked: true,
            ..input(&s, &locked)
        });
        assert!(p.sound);

        let pres = SystemState {
            presentation: true,
            ..SystemState::default()
        };
        let p = policy(input(&s, &pres));
        assert!(!p.window_keep && !p.sound && p.flash);

        let dnd_default = policy(PolicyInput {
            dnd_active: true,
            ..input(&s, &sys)
        });
        assert!(dnd_default.window_new);
        let quiet = ReminderSettings {
            alert_during_dnd: false,
            ..ReminderSettings::default()
        };
        let p = policy(PolicyInput {
            dnd_active: true,
            ..input(&quiet, &sys)
        });
        assert!(!p.window_keep && !p.sound && !p.flash);

        let fs = SystemState {
            fullscreen_app: true,
            ..SystemState::default()
        };
        assert!(policy(input(&s, &fs)).window_new);
        let no_fs = ReminderSettings {
            alert_during_fullscreen: false,
            ..ReminderSettings::default()
        };
        let p = policy(input(&no_fs, &fs));
        assert!(!p.window_new && p.sound && p.flash);
    }
}

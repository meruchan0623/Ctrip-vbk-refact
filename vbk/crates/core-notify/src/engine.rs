//! `NotifyCore`: the single decision point for "whether and how to remind".
//!
//! Effect model: there is no internal queue. Every input method returns
//! the effects it causes (computed with the `Now` it received) and
//! [`NotifyCore::tick`] returns time-driven effects. Hosts apply effects in
//! order and call `tick` at 1 Hz while the alarm window is visible (more
//! often is harmless; less often only delays escalation).

use std::collections::BTreeMap;

use contracts::{
    AccountContext, AlarmEntry, AlarmLevel, AlarmSnapshot, AppError, ClockReading,
    ReconcileState, ReminderSettings, RoundEvent, WaitingRoundRef,
};

use crate::banner::{BannerBook, BANNER_STAY_MS};
use crate::dnd::DndMode;
use crate::effects::{Effect, Sound};
use crate::escalation::{policy, PolicyInput, L4_CAP_MS, L4_PERIOD_MS};
use crate::now::Now;
use crate::rounds::RoundState;
use crate::snapshot::{sort_entries, LOCKED_LABEL};
use crate::unread::{BadgeText, UnreadBook};

/// Module-private error codes (prefix convention from `contracts::codes`).
pub mod codes {
    /// `t1_seconds` is not one of `ALLOWED_T1_SECONDS`.
    pub const NOTIFY_INVALID_THRESHOLD: &str = "notify.invalid_threshold";
    /// The command names a round this core does not track.
    pub const NOTIFY_ROUND_NOT_FOUND: &str = "notify.round_not_found";
    /// The command is not permitted from its source window.
    pub const NOTIFY_COMMAND_NOT_ALLOWED: &str = "notify.command_not_allowed";
}

/// Host-observed environment (archived strong-alert §4.7 matrix).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SystemState {
    pub main_window_focused: bool,
    /// Conversation currently open in the main window, if any.
    pub viewing_gid: Option<String>,
    pub fullscreen_app: bool,
    pub presentation: bool,
    pub locked: bool,
    pub focus_assist: bool,
}

/// Local-only options with no frozen contract field yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct LocalOptions {
    /// "锁屏时仍响铃" (archive §4.11, default off): keep the L4 loop
    /// ringing while the screen is locked.
    pub ring_while_locked: bool,
}

/// Minimal per-round state persisted across restarts (strong-alert §5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoredRound {
    pub round: WaitingRoundRef,
    pub label: String,
    pub start_time_ms: Option<i64>,
    pub start_confirmed: bool,
    pub hidden_version: Option<u64>,
    pub snoozed_until_ms: Option<i64>,
}

/// Reply-timeout escalation, L0–L2 attention and alarm snapshots.
#[derive(Debug)]
pub struct NotifyCore {
    settings: ReminderSettings,
    options: LocalOptions,
    system: SystemState,
    dnd: DndMode,
    reconcile: ReconcileState,
    /// Unlocked, waiting for the host-triggered reconcile to reach `Normal`.
    awaiting_unlock_reconcile: bool,
    /// `restore()` happened and no `Normal` has been applied since.
    restore_barrier: bool,
    clock: Option<ClockReading>,
    rounds: Vec<RoundState>,
    unread: UnreadBook,
    banners: BannerBook,
    /// Highest accepted `session_generation` per persistent account.
    generations: BTreeMap<(String, String), u64>,
    alarm_visible: bool,
    sound_active: bool,
    tray_flashing: bool,
    last_badge: BadgeText,
}

impl Default for NotifyCore {
    fn default() -> Self {
        Self::new()
    }
}

impl NotifyCore {
    /// A core with default settings, `Normal` reconcile state and an
    /// unfocused, unlocked system.
    pub fn new() -> Self {
        Self {
            settings: ReminderSettings::default(),
            options: LocalOptions::default(),
            system: SystemState::default(),
            dnd: DndMode::Off,
            reconcile: ReconcileState::Normal,
            awaiting_unlock_reconcile: false,
            restore_barrier: false,
            clock: None,
            rounds: Vec::new(),
            unread: UnreadBook::default(),
            banners: BannerBook::default(),
            generations: BTreeMap::new(),
            alarm_visible: false,
            sound_active: false,
            tray_flashing: false,
            last_badge: BadgeText::None,
        }
    }

    /// A core starting from `settings` (validated like `set_settings`).
    pub fn with_settings(settings: ReminderSettings) -> Result<Self, AppError> {
        validate_settings(&settings)?;
        let mut core = Self::new();
        core.settings = settings;
        Ok(core)
    }

    // ------------------------------------------------------------ getters

    pub fn settings(&self) -> &ReminderSettings {
        &self.settings
    }

    pub fn options(&self) -> LocalOptions {
        self.options
    }

    pub fn system_state(&self) -> &SystemState {
        &self.system
    }

    pub fn dnd(&self) -> DndMode {
        self.dnd
    }

    pub fn dnd_active(&self, now: &Now) -> bool {
        self.dnd.is_active(now.server_now_ms)
    }

    pub fn reconcile_state(&self) -> ReconcileState {
        self.reconcile
    }

    /// Tracked rounds (diagnostics / tests). Order is insertion order.
    pub fn rounds(&self) -> &[RoundState] {
        &self.rounds
    }

    pub fn alarm_visible(&self) -> bool {
        self.alarm_visible
    }

    pub fn unread_total(&self) -> u32 {
        self.unread.total()
    }

    pub fn last_clock(&self) -> Option<ClockReading> {
        self.clock
    }

    // ------------------------------------------------------------- inputs

    /// Replaces the settings. `t1_seconds` must be one of
    /// `ALLOWED_T1_SECONDS`, otherwise `notify.invalid_threshold`.
    pub fn set_settings(
        &mut self,
        settings: ReminderSettings,
        now: &Now,
    ) -> Result<Vec<Effect>, AppError> {
        validate_settings(&settings)?;
        let old = std::mem::replace(&mut self.settings, settings);
        Ok(self.after_settings_change(&old, now))
    }

    pub fn set_options(&mut self, options: LocalOptions) {
        self.options = options;
    }

    /// Applies a new environment reading and returns the resulting
    /// effects (flash stop on focus, held banners on unlock, window hide
    /// on lock/presentation, re-raise on recovery).
    pub fn set_system_state(&mut self, state: SystemState, now: &Now) -> Vec<Effect> {
        let previous = std::mem::replace(&mut self.system, state);
        let mut out = Vec::new();

        if self.system.main_window_focused && self.tray_flashing {
            self.tray_flashing = false;
            out.push(Effect::TrayFlash(false));
        }
        if !previous.locked && self.system.locked {
            // Rounds presented before the lock are raised once more after
            // unlock + reconcile.
            for r in &mut self.rounds {
                r.clear_presentation();
            }
        }
        if previous.locked && !self.system.locked {
            self.awaiting_unlock_reconcile = true;
            let released = self.banners.take_held(now);
            if !released.is_empty() && self.l2_allowed(now) {
                for b in released {
                    out.push(self.banner_effect(b.account, b.gid, b.count));
                }
                if self.banners.try_sound(now) {
                    out.push(Effect::PlaySound(Sound::NewMessage));
                }
            }
        }
        out.extend(self.evaluate(now));
        out
    }

    /// Sets the tray DND mode.
    pub fn set_dnd(&mut self, mode: DndMode, now: &Now) -> Vec<Effect> {
        self.dnd = mode;
        let mut out = Vec::new();
        if self.dnd_active(now) && self.tray_flashing {
            self.tray_flashing = false;
            out.push(Effect::TrayFlash(false));
        }
        out.extend(self.evaluate(now));
        out
    }

    /// Records the latest clock reading. A trusted reading re-anchors every
    /// deadline that was computed as an estimate. Level changes caused by
    /// the re-anchoring surface on the next `tick`.
    pub fn apply_clock(&mut self, reading: ClockReading) {
        self.clock = Some(reading);
        if reading.trusted() {
            let now = Now::from_reading(&reading);
            let t1 = self.t1_ms();
            for r in self.rounds.iter_mut().filter(|r| r.estimated) {
                r.rebase(&now, t1);
            }
        }
    }

    /// Reconcile barrier owned by core-im. `Normal` releases popups held
    /// back by reconciling, unlock and restore (at most one raise).
    pub fn apply_reconcile_state(&mut self, state: ReconcileState, now: &Now) -> Vec<Effect> {
        self.reconcile = state;
        if state == ReconcileState::Normal {
            self.awaiting_unlock_reconcile = false;
            self.restore_barrier = false;
        }
        self.evaluate(now)
    }

    /// Consumes a waiting-round fact from core-im.
    pub fn apply_round_event(&mut self, event: RoundEvent, now: &Now) -> Vec<Effect> {
        let mut out = Vec::new();
        match event {
            RoundEvent::Invalidated { round } => {
                let gen = round.account.session_generation;
                let key = persistent_key(&round.account);
                out.extend(self.purge_account(&key, Some(gen)));
                let next = self.generations.get(&key).copied().unwrap_or(0).max(gen + 1);
                self.generations.insert(key, next);
            }
            RoundEvent::Started {
                round,
                start_time_ms,
                start_confirmed,
                label,
                ..
            } => {
                if !self.accept_generation(&round.account) {
                    return out;
                }
                let t1 = self.t1_ms();
                if let Some(idx) = self.find(&round.account, &round.gid, &round.round_id) {
                    let r = &mut self.rounds[idx];
                    if round.version < r.round.version {
                        return out;
                    }
                    r.round.version = round.version;
                    r.label = label;
                    if start_time_ms.is_some() {
                        r.start_time_ms = start_time_ms;
                    }
                    r.start_confirmed = start_confirmed && r.start_time_ms.is_some();
                    r.rebase(now, t1);
                    if r.restored {
                        r.reconfirmed_after_restore = true;
                    }
                } else {
                    // One open round per conversation: a new round id
                    // supersedes whatever was tracked for the same gid.
                    out.extend(self.remove_where(|r| {
                        r.round.account == round.account && r.round.gid == round.gid
                    }));
                    self.rounds.push(RoundState::new(
                        round,
                        label,
                        start_time_ms,
                        start_confirmed,
                        now,
                        t1,
                    ));
                }
            }
            RoundEvent::StartConfirmed {
                round,
                start_time_ms,
                ..
            } => {
                if !self.accept_generation(&round.account) {
                    return out;
                }
                let t1 = self.t1_ms();
                let Some(idx) = self.find(&round.account, &round.gid, &round.round_id) else {
                    return out;
                };
                let r = &mut self.rounds[idx];
                if round.version < r.round.version {
                    return out;
                }
                r.round.version = round.version;
                r.start_time_ms = Some(start_time_ms);
                r.start_confirmed = true;
                r.rebase(now, t1);
                if r.restored {
                    r.reconfirmed_after_restore = true;
                }
            }
            RoundEvent::Ended { round, .. } => {
                if !self.accept_generation(&round.account) {
                    return out;
                }
                out.extend(self.remove_where(|r| {
                    r.matches(&round.account, &round.gid, &round.round_id)
                }));
            }
        }
        out.extend(self.evaluate(now));
        out
    }

    /// Restores minimal round state after a restart. Restored rounds stay
    /// pending (not listed, no popups) until the first `Normal` reconcile
    /// *and* a `Started`/`StartConfirmed` for the same round; they then
    /// remind at most once.
    pub fn restore(&mut self, entries: Vec<RestoredRound>, now: &Now) {
        let t1 = self.t1_ms();
        self.restore_barrier = true;
        for e in entries {
            if !self.accept_generation(&e.round.account) {
                continue;
            }
            if self
                .find(&e.round.account, &e.round.gid, &e.round.round_id)
                .is_some()
            {
                continue;
            }
            let mut r = RoundState::new(
                e.round,
                e.label,
                e.start_time_ms,
                e.start_confirmed,
                now,
                t1,
            );
            r.restored = true;
            r.hidden_version = e.hidden_version;
            if let Some(until_ms) = e.snoozed_until_ms {
                let remaining = until_ms.saturating_sub(now.server_now_ms);
                if remaining > 0 {
                    r.snoozed_until_ms = Some(until_ms);
                    r.snoozed_until_monotonic = Some(
                        now.monotonic_ms
                            .saturating_add(u64::try_from(remaining).unwrap_or(0)),
                    );
                }
            }
            self.rounds.push(r);
        }
    }

    /// The minimal state a host should persist for `restore()`.
    pub fn persistable(&self) -> Vec<RestoredRound> {
        self.rounds
            .iter()
            .map(|r| RestoredRound {
                round: r.round.clone(),
                label: r.label.clone(),
                start_time_ms: r.start_time_ms,
                start_confirmed: r.start_confirmed,
                hidden_version: r.hidden_version,
                snoozed_until_ms: r.snoozed_until_ms,
            })
            .collect()
    }

    /// A new (deduplicated, non-replay) message arrived. Drives L1 (flash
    /// while main is not focused) and, for customer messages, L2 (banner
    /// merged per conversation + throttled sound).
    pub fn on_new_message(
        &mut self,
        account: &AccountContext,
        gid: &str,
        is_customer: bool,
        now: &Now,
    ) -> Vec<Effect> {
        let mut out = Vec::new();
        if !self.accept_generation(account) {
            return out;
        }
        let dnd = self.dnd_active(now);
        if !self.system.main_window_focused
            && self.settings.tray_flash
            && !dnd
            && !self.tray_flashing
        {
            self.tray_flashing = true;
            out.push(Effect::TrayFlash(true));
        }
        if !is_customer || !self.l2_allowed(now) {
            return out;
        }
        if self.system.main_window_focused && self.system.viewing_gid.as_deref() == Some(gid) {
            return out;
        }
        let count = self.banners.bump(account, gid, now, self.system.locked);
        if self.system.locked {
            return out;
        }
        out.push(self.banner_effect(account.clone(), gid.to_string(), count));
        if self.banners.try_sound(now) {
            out.push(Effect::PlaySound(Sound::NewMessage));
        }
        out
    }

    /// Unread count of one conversation changed (L0 aggregation).
    pub fn on_unread_changed(
        &mut self,
        account: &AccountContext,
        gid: &str,
        unread: u32,
    ) -> Vec<Effect> {
        let mut out = Vec::new();
        if !self.accept_generation(account) {
            return out;
        }
        if self.unread.set(account, gid, unread) {
            out.extend(self.unread_effect());
        }
        if self.unread.total() == 0 && self.tray_flashing {
            self.tray_flashing = false;
            out.push(Effect::TrayFlash(false));
        }
        out
    }

    /// Time-driven evaluation: escalation, snooze expiry, L4 loop and the
    /// 1 Hz `UpdateAlarm` refresh while the window is visible.
    pub fn tick(&mut self, now: &Now) -> Vec<Effect> {
        self.banners.expire(now);
        self.evaluate(now)
    }

    /// Desensitized snapshot for the alarm window, longest wait first.
    pub fn snapshot(&self, now: &Now) -> AlarmSnapshot {
        let t1 = self.t1_ms();
        let mut estimated = false;
        let mut entries: Vec<AlarmEntry> = self
            .rounds
            .iter()
            .filter(|r| self.settings.enabled && r.is_listed(now, t1, self.restore_barrier))
            .map(|r| {
                estimated |= r.estimated;
                AlarmEntry {
                    account: r.round.account.clone(),
                    gid: r.round.gid.clone(),
                    round_id: r.round.round_id.clone(),
                    version: r.round.version,
                    label: if self.system.locked {
                        LOCKED_LABEL.to_string()
                    } else {
                        r.label.clone()
                    },
                    waiting_since_ms: if r.start_confirmed {
                        r.start_time_ms
                    } else {
                        None
                    },
                    waited_seconds: r.waited_seconds(now),
                    level: r.level,
                    start_confirmed: r.start_confirmed,
                    snoozed_until_ms: r.snoozed_until_ms,
                }
            })
            .collect();
        sort_entries(&mut entries);
        AlarmSnapshot {
            generated_at_ms: now.server_now_ms,
            clock_trusted: now.clock_trusted && !estimated,
            reconciling: self.barrier_active(),
            settings: self.settings.clone(),
            entries,
        }
    }

    // ----------------------------------------------------- crate helpers

    pub(crate) fn t1_ms(&self) -> u64 {
        u64::from(self.settings.t1_seconds) * 1000
    }

    pub(crate) fn round_mut(&mut self, idx: usize) -> &mut RoundState {
        &mut self.rounds[idx]
    }

    pub(crate) fn rounds_mut(&mut self) -> &mut [RoundState] {
        &mut self.rounds
    }

    pub(crate) fn find(&self, account: &AccountContext, gid: &str, round_id: &str) -> Option<usize> {
        self.rounds
            .iter()
            .position(|r| r.matches(account, gid, round_id))
    }

    /// Rejects stale generations; a newer generation purges older state of
    /// the same persistent account.
    pub(crate) fn accept_generation(&mut self, account: &AccountContext) -> bool {
        let key = persistent_key(account);
        let gen = account.session_generation;
        match self.generations.get(&key).copied() {
            Some(known) if gen < known => false,
            Some(known) if gen > known => {
                let _ = self.purge_account(&key, Some(gen - 1));
                self.generations.insert(key, gen);
                true
            }
            Some(_) => true,
            None => {
                self.generations.insert(key, gen);
                true
            }
        }
    }

    /// Whether the command's generation is older than the newest seen.
    pub(crate) fn is_stale_generation(&self, account: &AccountContext) -> bool {
        self.generations
            .get(&persistent_key(account))
            .is_some_and(|known| account.session_generation < *known)
    }

    pub(crate) fn apply_settings_patch(
        &mut self,
        patch: impl FnOnce(&mut ReminderSettings),
        now: &Now,
    ) -> Result<Vec<Effect>, AppError> {
        let mut next = self.settings.clone();
        patch(&mut next);
        self.set_settings(next, now)
    }

    /// Removes rounds matching `pred`; emits `StopSound` when a sounding
    /// round goes away.
    pub(crate) fn remove_where(&mut self, pred: impl Fn(&RoundState) -> bool) -> Vec<Effect> {
        let mut out = Vec::new();
        let mut removed_sounding = false;
        self.rounds.retain(|r| {
            if pred(r) {
                removed_sounding |= r.level >= AlarmLevel::L3;
                false
            } else {
                true
            }
        });
        if removed_sounding && self.sound_active {
            self.sound_active = false;
            out.push(Effect::StopSound);
        }
        out
    }

    /// Emits `StopSound` if something may be playing (hide / snooze).
    pub(crate) fn silence(&mut self) -> Vec<Effect> {
        if self.sound_active {
            self.sound_active = false;
            vec![Effect::StopSound]
        } else {
            Vec::new()
        }
    }

    /// Drops every round, banner and unread count of one persistent
    /// account with `session_generation <= up_to` (all when `None`).
    fn purge_account(&mut self, key: &(String, String), up_to: Option<u64>) -> Vec<Effect> {
        let (env, id) = key.clone();
        let mut out = self.remove_where(|r| {
            r.same_persistent_account(&env, &id)
                && match up_to {
                    None => true,
                    Some(g) => r.round.account.session_generation <= g,
                }
        });
        self.banners.clear_account(&env, &id);
        if self.unread.clear_account(&env, &id) {
            out.extend(self.unread_effect());
        }
        out
    }

    fn unread_effect(&mut self) -> Vec<Effect> {
        let total = self.unread.total();
        let badge = if self.settings.taskbar_badge {
            BadgeText::from_total(total)
        } else {
            BadgeText::None
        };
        self.last_badge = badge;
        vec![Effect::Unread { total, badge }]
    }

    fn after_settings_change(&mut self, old: &ReminderSettings, now: &Now) -> Vec<Effect> {
        let mut out = Vec::new();
        let new = self.settings.clone();
        if old.t1_seconds != new.t1_seconds {
            let t1 = self.t1_ms();
            for r in &mut self.rounds {
                r.recompute_deadline(t1);
            }
        }
        if old.taskbar_badge != new.taskbar_badge {
            out.extend(self.unread_effect());
        }
        if !new.tray_flash && self.tray_flashing {
            self.tray_flashing = false;
            out.push(Effect::TrayFlash(false));
        }
        if old.enabled && !new.enabled {
            for r in &mut self.rounds {
                r.clear_presentation();
            }
            out.extend(self.silence());
        }
        if old.timeout_sound && !new.timeout_sound {
            out.extend(self.silence());
        }
        out.extend(self.evaluate(now));
        out
    }

    fn barrier_active(&self) -> bool {
        matches!(self.reconcile, ReconcileState::Reconciling { .. }) || self.awaiting_unlock_reconcile
    }

    /// L2 (banner + new-message sound) is allowed by the environment.
    fn l2_allowed(&self, now: &Now) -> bool {
        !self.dnd_active(now) && !self.system.presentation && !self.system.focus_assist
    }

    fn banner_effect(&self, account: AccountContext, gid: String, count: u32) -> Effect {
        if self.system.fullscreen_app {
            Effect::SystemToast {
                account,
                gid,
                count,
            }
        } else {
            Effect::Banner {
                account,
                gid,
                count,
                stay_ms: BANNER_STAY_MS,
            }
        }
    }

    /// The escalation pass shared by every input and by `tick`.
    pub(crate) fn evaluate(&mut self, now: &Now) -> Vec<Effect> {
        let settings = self.settings.clone();
        let t1_ms = self.t1_ms();
        let barrier = self.restore_barrier;
        let pol = policy(PolicyInput {
            settings: &settings,
            system: &self.system,
            barrier: self.barrier_active(),
            dnd_active: self.dnd.is_active(now.server_now_ms),
            ring_while_locked: self.options.ring_while_locked,
        });

        let mut raise = false;
        let mut quiet_show = false;
        let mut timeout_sound = false;
        let mut loop_sound = false;
        let mut flash = false;
        let mut any_presentable = false;

        for r in &mut self.rounds {
            r.expire_snooze(now);
            r.advance(now, &settings);
            if !settings.enabled || !r.is_presentable(now, t1_ms, barrier) {
                continue;
            }
            any_presentable = true;
            let level = r.level;
            let mut presented_now = false;
            if pol.window_new && r.raised_for_level != Some(level) {
                r.raised_for_level = Some(level);
                presented_now = true;
                flash = true;
                if r.restored && r.reminded_once_after_restore {
                    quiet_show = true;
                } else {
                    raise = true;
                    if r.restored {
                        r.reminded_once_after_restore = true;
                    }
                }
            } else if !pol.window_new && pol.flash && r.flashed_for_level != Some(level) {
                r.flashed_for_level = Some(level);
                presented_now = true;
                flash = true;
            }
            if presented_now && pol.sound && settings.timeout_sound && !r.l3_sound_played {
                r.l3_sound_played = true;
                timeout_sound = true;
            }
            if level == AlarmLevel::L4 && pol.sound && settings.timeout_sound {
                if let Some(entered) = r.l4_entered_monotonic {
                    let elapsed = now.monotonic_ms.saturating_sub(entered);
                    if elapsed <= L4_CAP_MS {
                        let due = match r.last_l4_sound_monotonic {
                            None => true,
                            Some(last) => now.monotonic_ms.saturating_sub(last) >= L4_PERIOD_MS,
                        };
                        if due {
                            r.last_l4_sound_monotonic = Some(now.monotonic_ms);
                            r.l4_sound_count = r.l4_sound_count.saturating_add(1);
                            loop_sound = true;
                        }
                    } else if !r.l4_cap_flashed {
                        r.l4_cap_flashed = true;
                        flash = true;
                    }
                }
            }
        }

        let mut out = Vec::new();
        if !pol.window_keep {
            if self.alarm_visible {
                self.alarm_visible = false;
                out.push(Effect::HideAlarm);
                for r in &mut self.rounds {
                    r.clear_presentation();
                }
            }
            if !pol.sound {
                out.extend(self.silence());
            }
        } else if raise {
            self.alarm_visible = true;
            out.push(Effect::ShowAlarm { raise: true });
        } else if quiet_show && !self.alarm_visible {
            self.alarm_visible = true;
            out.push(Effect::ShowAlarm { raise: false });
        } else if self.alarm_visible && !any_presentable {
            self.alarm_visible = false;
            out.push(Effect::HideAlarm);
            out.extend(self.silence());
        } else if self.alarm_visible {
            out.push(Effect::UpdateAlarm);
        }

        if timeout_sound {
            self.sound_active = true;
            out.push(Effect::PlaySound(Sound::Timeout));
        }
        if loop_sound {
            self.sound_active = true;
            out.push(Effect::PlaySound(Sound::Loop));
        }
        if flash && settings.tray_flash && !self.system.main_window_focused && !self.tray_flashing
        {
            self.tray_flashing = true;
            out.push(Effect::TrayFlash(true));
        }
        out
    }
}

fn validate_settings(settings: &ReminderSettings) -> Result<(), AppError> {
    if ReminderSettings::is_allowed_t1(settings.t1_seconds) {
        Ok(())
    } else {
        Err(AppError::new(
            codes::NOTIFY_INVALID_THRESHOLD,
            "t1_seconds must be one of 30/60/90/120/180",
        )
        .with_detail(format!("t1_seconds={}", settings.t1_seconds)))
    }
}

fn persistent_key(account: &AccountContext) -> (String, String) {
    (
        account.environment.as_str().to_string(),
        account.account_id.as_str().to_string(),
    )
}

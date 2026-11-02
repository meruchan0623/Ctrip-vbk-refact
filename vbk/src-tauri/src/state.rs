//! Host state: one mutex-guarded aggregate of the std-only cores plus the
//! glue that keeps them consistent (archive §4.5: one state-holding task,
//! explicit requests; no cross-module locking).
//!
//! Everything time-related is computed from `core-net`'s `ClockService`;
//! the host only supplies wall/monotonic readings.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use contracts::{
    AccountContext, AccountId, AlarmCommand, AlarmSnapshot, AppError, ClockReading, Environment,
    ReconcileState, ReminderSettings, RoundEvent,
};
use core_account::{AccountRegistry, LogoutMode};
use core_im::{Fact, FactEnvelope, ImCore, ImCores, StreamId, TransportState};
use core_net::clock::{ClockService, ReconcileCoordinator, ReconcileReason};
use core_notify::{
    mask_label, CommandAck, CommandSource, DndMode, Effect, NotifyCore, Now, RestoredRound,
    SystemState,
};
use core_store::{FileStore, Namespace, PersistJob, PersistQueue, ReminderStateRepo, RoundRecord, SyncWatermarkRepo};
use tauri::AppHandle;

use crate::dto::{AdapterFactDto, AdapterFactEnvelopeDto};
use crate::views::ViewRegistry;

/// Boot-scoped monotonic clock.
#[derive(Debug)]
pub struct HostClock {
    started: Instant,
}

impl HostClock {
    pub fn new() -> Self {
        Self {
            started: Instant::now(),
        }
    }

    pub fn monotonic_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    pub fn wall_ms(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or(Duration::ZERO)
            .as_millis() as i64
    }
}

impl Default for HostClock {
    fn default() -> Self {
        Self::new()
    }
}

/// Per-account glue that is not a core concern: which reconcile generation
/// is open for the account.
#[derive(Debug, Default)]
struct AccountGlue {
    reconcile: ReconcileCoordinator,
}

/// Aggregate of all cores. Guarded by one mutex in [`HostState`].
pub struct Cores {
    pub accounts: AccountRegistry,
    pub im: ImCores,
    pub notify: NotifyCore,
    pub clock: ClockService,
    pub views: ViewRegistry,
    pub store: Option<FileStore>,
    glue: HashMap<(Environment, AccountId), AccountGlue>,
    /// Pending effects produced by inputs between scheduler ticks.
    pending_effects: Vec<Effect>,
    quit_requested: bool,
    pending_persist: HashMap<Namespace, PersistJob>,
    pub persist_failed: HashMap<Namespace, AppError>,
    persist_receipt_seq: HashMap<Namespace, u64>,
    persist_locked: HashSet<Namespace>,
    persist_unlock_pending: HashMap<Namespace, u64>,
}

impl Cores {
    /// Caller holds the host lock before touching adapter display state.
    pub fn set_account_notifications(
        &mut self,
        account: &AccountContext,
        allowed: bool,
        now: &Now,
    ) -> bool {
        if self.accounts.validate(account).is_err() {
            return false;
        }
        let effects = self.notify.set_account_notifications(account, allowed, now);
        self.pending_effects.extend(effects);
        true
    }
}

impl std::fmt::Debug for Cores {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Cores")
            .field("accounts", &self.accounts.account_ids().len())
            .field("im", &self.im.len())
            .field("pending_effects", &self.pending_effects.len())
            .finish_non_exhaustive()
    }
}

pub struct HostState {
    pub clock: HostClock,
    cores: Mutex<Cores>,
    persistence: Option<PersistQueue>,
    persistence_start_error: Option<AppError>,
    persist_seq: AtomicU64,
}

impl std::fmt::Debug for HostState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostState").finish_non_exhaustive()
    }
}

impl HostState {
    pub fn new(store: Option<FileStore>, boot_epoch: u64) -> Self {
        let (persistence, persistence_start_error) = match store.clone().map(PersistQueue::new) {
            Some(Ok(queue)) => (Some(queue), None),
            Some(Err(error)) => (None, Some(error)),
            None => (None, None),
        };
        Self {
            persistence,
            persistence_start_error,
            persist_seq: AtomicU64::new(1),
            clock: HostClock::new(),
            cores: Mutex::new(Cores {
                accounts: AccountRegistry::new(boot_epoch),
                im: ImCores::new(),
                notify: NotifyCore::with_account_gating(),
                clock: ClockService::default(),
                views: ViewRegistry::default(),
                store,
                glue: HashMap::new(),
                pending_effects: Vec::new(),
                quit_requested: false,
                pending_persist: HashMap::new(),
                persist_failed: HashMap::new(),
                persist_receipt_seq: HashMap::new(),
                persist_locked: HashSet::new(),
                persist_unlock_pending: HashMap::new(),
            }),
        }
    }

    /// Locks the cores. A poisoned mutex is recovered rather than crashing
    /// the host: the state is only ever mutated through small, panic-free
    /// core methods.
    pub fn lock(&self) -> MutexGuard<'_, Cores> {
        match self.cores.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    /// Current clock reading as the cores should see it.
    pub fn reading(&self, cores: &mut Cores) -> ClockReading {
        cores
            .clock
            .reading(self.clock.wall_ms(), self.clock.monotonic_ms())
    }

    pub fn now(&self, cores: &mut Cores) -> Now {
        let reading = self.reading(cores);
        cores.notify.apply_clock(reading);
        Now::from_reading(&reading)
    }

    // ------------------------------------------------------------ views

    pub fn authorize(&self, label: &str, command: &str) -> Result<(), AppError> {
        self.lock().views.authorize(label, command).map(|_| ())
    }

    // ------------------------------------------------------------ IM facts

    /// Validates and ingests one adapter envelope. The account in the
    /// envelope is checked against core-account's current generation
    /// before anything is applied (strong-alert §3: payload identity is
    /// never trusted on its own).
    pub fn push_fact(
        &self,
        dto: AdapterFactEnvelopeDto,
    ) -> Result<core_im::IngestReport, AppError> {
        let mut cores = self.lock();
        let account: AccountContext = dto.account.clone().into();
        cores.accounts.validate(&account)?;
        let stream = StreamId::from_name(&dto.stream).ok_or_else(|| {
            AppError::new(
                "im.invalid_fact",
                format!("unknown stream {:?}", dto.stream),
            )
        })?;
        let fact = convert_fact(dto.fact)?;
        if cores.im.get(&account).is_none() {
            cores.im.insert(ImCore::new(account.clone()));
            // First facts after (re-)login: rounds persisted under this
            // identity come back as "待核对" and stay silent until the
            // reconcile barrier lifts (strong-alert §5, review O03).
            self.restore_rounds_for(&mut cores, &account);
        }
        let env = FactEnvelope {
            account: account.clone(),
            stream,
            epoch: dto.epoch,
            seq: dto.seq,
            fact,
        };
        let report = cores.im.ingest(env)?;
        if report.auth_invalid {
            // core-account decides the generation change; the host just
            // records the signal and revokes.
            let id = account.account_id.clone();
            if let Ok(revoke) = cores
                .accounts
                .invalidate(&id, "web session reported auth invalid")
            {
                let now = self.now(&mut cores);
                let effects = cores
                    .notify
                    .set_account_notifications(&account, false, &now);
                cores.pending_effects.extend(effects);
                let new_ctx = cores
                    .accounts
                    .current_context(&id)
                    .unwrap_or_else(|| account.next_generation());
                let _ = cores.im.invalidate_generation(new_ctx);
                log::info!(
                    "revoked generation {} for account {}",
                    revoke.revoked_generation,
                    revoke.account_id
                );
            }
        }
        if let Some(stream) = report.needs_resync {
            let key = (account.environment.clone(), account.account_id.clone());
            let gen = cores
                .glue
                .entry(key)
                .or_default()
                .reconcile
                .begin_reconcile(ReconcileReason::StreamGap);
            log::warn!("stream {:?} needs resync (reconcile gen {gen})", stream);
        }
        self.pump_rounds(&mut cores);
        let jobs = self.collect_round_snapshots(&cores);
        drop(cores);
        self.enqueue_snapshots(jobs);
        Ok(report)
    }

    /// Compensation watermark for `account` (Unix ms, 0 when unknown): the
    /// newer of the in-memory core cursor and the persisted one.
    pub fn compensation_watermark(&self, account: &AccountContext) -> i64 {
        let cores = self.lock();
        let live = cores
            .im
            .get(account)
            .and_then(|c| c.watermarks().compensation_cursor_ms());
        let stored = cores.store.as_ref().and_then(|s| {
            SyncWatermarkRepo::compensation_cursor(s, &Namespace::from_context(account))
                .ok()
                .flatten()
        });
        live.into_iter().chain(stored).max().unwrap_or(0).max(0)
    }

    /// Moves round events and reconcile state from core-im into
    /// core-notify, collecting the effects for the scheduler.
    fn pump_rounds(&self, cores: &mut Cores) {
        let now = self.now(cores);
        let events: Vec<RoundEvent> = cores.im.drain_round_events();
        let mut effects = Vec::new();
        for ev in events {
            effects.extend(cores.notify.apply_round_event(ev, &now));
        }
        // Aggregate reconcile state: reconciling if any account is.
        let state = if cores.im.iter().any(|c| c.is_reconciling()) {
            cores
                .im
                .iter()
                .find_map(|c| match c.reconcile_state() {
                    ReconcileState::Reconciling { generation } => {
                        Some(ReconcileState::Reconciling { generation })
                    }
                    ReconcileState::Normal => None,
                })
                .unwrap_or(ReconcileState::Normal)
        } else {
            ReconcileState::Normal
        };
        effects.extend(cores.notify.apply_reconcile_state(state, &now));
        cores.pending_effects.extend(effects);
    }

    /// Pure memory snapshot collection. All sequence allocation happens under
    /// Cores; no producer holds that lock while enqueueing or writing files.
    fn collect_round_snapshots(&self, cores: &Cores) -> Vec<PersistJob> {
        if cores.store.is_none() { return Vec::new(); }
        let mut by_ns: HashMap<Namespace, Vec<RoundRecord>> = HashMap::new();
        for core in cores.im.iter() {
            let ns = Namespace::from_context(core.account());
            if !cores.persist_locked.contains(&ns) { by_ns.entry(ns).or_default(); }
        }
        for r in cores.notify.persistable() {
            let ns = Namespace::from_context(&r.round.account);
            if cores.persist_locked.contains(&ns) { continue; }
            by_ns.entry(ns).or_default().push(RoundRecord {
                gid: r.round.gid.clone(), round_id: r.round.round_id.clone(),
                version: r.round.version, start_message_id: None,
                start_time_ms: r.start_time_ms, start_confirmed: r.start_confirmed,
                reminded_version: r.round.version,
                hidden_version: r.hidden_version.unwrap_or(0),
                snoozed_until_ms: r.snoozed_until_ms,
            });
        }
        by_ns.into_iter().map(|(ns, rounds)| {
            let compensation_cursor_ms = cores.im.iter()
                .find(|core| Namespace::from_context(core.account()) == ns)
                .and_then(|core| core.watermarks().compensation_cursor_ms());
            PersistJob { seq: self.persist_seq.fetch_add(1, Ordering::Relaxed),
                unlock_before_write: cores.persist_unlock_pending.contains_key(&ns),
                ns, rounds: Some(rounds), compensation_cursor_ms, logout_lock: false }
        }).collect()
    }

    fn enqueue_snapshots(&self, jobs: Vec<PersistJob>) {
        let Some(queue) = &self.persistence else { return; };
        for job in jobs {
            if let Err(job) = queue.try_enqueue(job) {
                core_store::queue::coalesce(&mut self.lock().pending_persist, job);
            }
        }
    }

    /// Nonblocking scheduler hook; pending overflow jobs are retried outside
    /// Cores, and successful newer receipts clear a previous save failure.
    pub fn service_persistence(&self) {
        let Some(queue) = &self.persistence else { return; };
        let receipts = queue.drain_receipts();
        let jobs = {
            let mut cores = self.lock();
            for receipt in receipts {
                if cores.persist_receipt_seq.get(&receipt.ns).is_some_and(|seq| *seq > receipt.seq) { continue; }
                cores.persist_receipt_seq.insert(receipt.ns.clone(), receipt.seq);
                match receipt.result {
                    Ok(()) => {
                        cores.persist_failed.remove(&receipt.ns);
                        if cores.persist_unlock_pending.get(&receipt.ns).is_some_and(|seq| receipt.seq >= *seq) {
                            cores.persist_unlock_pending.remove(&receipt.ns);
                        }
                    }
                    Err(error) => { cores.persist_failed.insert(receipt.ns, error); }
                }
            }
            std::mem::take(&mut cores.pending_persist).into_values().collect()
        };
        self.enqueue_snapshots(jobs);
    }

    /// Invoke only after the official page's verified identity is published.
    /// Unlock is ordered with the final logout snapshot and survives coalescing.
    pub fn unlock_persistence_after_reauth(&self, account: &AccountContext) -> Result<(), AppError> {
        let mut cores = self.lock();
        cores.accounts.validate(account)?;
        let ns = Namespace::from_context(account);
        let seq = self.persist_seq.fetch_add(1, Ordering::Relaxed);
        cores.persist_locked.remove(&ns);
        cores.persist_unlock_pending.insert(ns.clone(), seq);
        let job = PersistJob { ns, seq, rounds: None, compensation_cursor_ms: None,
            logout_lock: false, unlock_before_write: true };
        drop(cores);
        self.enqueue_snapshots(vec![job]);
        Ok(())
    }

    pub fn persistence_failures(&self) -> Vec<(Namespace, AppError)> {
        self.service_persistence();
        self.lock().persist_failed.iter().map(|(ns, error)| (ns.clone(), error.clone())).collect()
    }

    pub fn ensure_persistence_healthy(&self, account: &AccountContext) -> Result<(), AppError> {
        self.service_persistence();
        if let Some(error) = &self.persistence_start_error { return Err(error.clone()); }
        if self.persistence.is_none() {
            return Err(AppError::new("store.unavailable", "local persistence is unavailable"));
        }
        let cores = self.lock();
        cores.accounts.validate(account)?;
        let ns = Namespace::from_context(account);
        if let Some(error) = cores.persist_failed.get(&ns) { return Err(error.clone()); }
        if cores.persist_locked.contains(&ns) || cores.persist_unlock_pending.contains_key(&ns) {
            return Err(AppError::new("store.locked", "local persistence awaits verified reauthentication"));
        }
        Ok(())
    }

    /// Shutdown hook: admission must already be stopped by the caller. A
    /// timeout never claims durability and never waits while holding Cores.
    pub fn flush_persistence(&self, timeout: Duration) -> Result<(), AppError> {
        let deadline = Instant::now() + timeout;
        let Some(queue) = &self.persistence else {
            return self.persistence_start_error.clone().map_or(Ok(()), Err);
        };
        loop {
            self.service_persistence();
            if self.lock().pending_persist.is_empty() { break; }
            if Instant::now() >= deadline {
                return Err(AppError::new("store.flush_timeout", "pending local saves exceeded deadline"));
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        let result = queue.flush(deadline.saturating_duration_since(Instant::now()));
        self.service_persistence();
        result
    }

    /// Loads persisted rounds for `account` into notify as pending
    /// verification. `PendingVerification` is only ever consumed here with
    /// the restore barrier, never turned into a popup directly.
    fn restore_rounds_for(&self, cores: &mut Cores, account: &AccountContext) {
        let Some(store) = cores.store.as_ref() else {
            return;
        };
        let ns = Namespace::from_context(account);
        let pending = match ReminderStateRepo::load_all(store, &ns) {
            Ok(p) => p,
            Err(e) => {
                log::warn!("round restore skipped for {}: {e}", ns.key());
                return;
            }
        };
        // The store's evidence gate is satisfied by notify's own restore
        // barrier plus core-im's reconcile state, which together hold the
        // rounds silent until compensation and list read-back complete.
        let records = match pending.reconcile(core_store::ReconcileEvidence::complete()) {
            Ok(r) => r,
            Err(_) => return,
        };
        let restored: Vec<RestoredRound> = records
            .into_iter()
            .map(|r| RestoredRound {
                round: contracts::WaitingRoundRef {
                    account: account.clone(),
                    gid: r.gid.clone(),
                    round_id: r.round_id,
                    version: r.version,
                },
                label: mask_label(&r.gid),
                start_time_ms: r.start_time_ms,
                start_confirmed: false,
                hidden_version: if r.hidden_version == 0 {
                    None
                } else {
                    Some(r.hidden_version)
                },
                snoozed_until_ms: r.snoozed_until_ms,
            })
            .collect();
        if restored.is_empty() {
            return;
        }
        let now = self.now(cores);
        cores.notify.restore(restored, &now);
    }

    /// Called by the adapter after it re-handshaked a stream.
    pub fn resync_complete(
        &self,
        account: AccountContext,
        stream: &str,
        epoch: u64,
        seq: u64,
    ) -> Result<(), AppError> {
        let mut cores = self.lock();
        cores.accounts.validate(&account)?;
        let stream = StreamId::from_name(stream)
            .ok_or_else(|| AppError::new("im.invalid_fact", "unknown stream"))?;
        if let Some(core) = cores.im.get_mut(&account) {
            core.resync_complete(stream, contracts::StreamCursor::new(epoch, seq));
            if !core.is_reconciling() {
                let key = (account.environment.clone(), account.account_id.clone());
                if let Some(glue) = cores.glue.get_mut(&key) {
                    let gen = glue.reconcile.current_generation();
                    glue.reconcile.complete(gen);
                }
            }
        }
        self.pump_rounds(&mut cores);
        let jobs = self.collect_round_snapshots(&cores);
        drop(cores);
        self.enqueue_snapshots(jobs);
        Ok(())
    }

    // ------------------------------------------------------------ alarm

    pub fn alarm_snapshot(&self) -> AlarmSnapshot {
        let mut cores = self.lock();
        let now = self.now(&mut cores);
        cores.notify.snapshot(&now)
    }

    pub fn alarm_command(
        &self,
        cmd: AlarmCommand,
        source: CommandSource,
    ) -> Result<CommandAck, AppError> {
        let mut cores = self.lock();
        let now = self.now(&mut cores);
        let (ack, effects) = cores.notify.handle_command(cmd, source, &now)?;
        cores.pending_effects.extend(effects);
        Ok(ack)
    }

    pub fn settings(&self) -> ReminderSettings {
        self.lock().notify.settings().clone()
    }

    /// 1 Hz scheduler entry: returns the effects to execute.
    pub fn tick(&self) -> Vec<Effect> {
        self.service_persistence();
        let mut cores = self.lock();
        let now = self.now(&mut cores);
        let mut effects = std::mem::take(&mut cores.pending_effects);
        effects.extend(cores.notify.tick(&now));
        effects.retain(|effect| cores.notify.effect_is_current(effect, &now));
        effects
    }

    /// Called at the execution boundary as pending prefs effects and adapter
    /// inputs can race a scheduler iteration.
    pub fn notification_effect_is_current(&self, effect: &Effect) -> bool {
        let mut cores = self.lock();
        let now = self.now(&mut cores);
        cores.notify.effect_is_current(effect, &now)
    }

    pub fn set_system_state(&self, state: SystemState) {
        let mut cores = self.lock();
        let now = self.now(&mut cores);
        let effects = cores.notify.set_system_state(state, &now);
        cores.pending_effects.extend(effects);
    }

    pub fn set_dnd_hours(&self, hours: u32) {
        let mut cores = self.lock();
        let now = self.now(&mut cores);
        let until_ms = now.server_now_ms + i64::from(hours) * 3_600_000;
        let effects = cores.notify.set_dnd(DndMode::OneHour { until_ms }, &now);
        cores.pending_effects.extend(effects);
    }

    pub fn set_dnd_until_tomorrow(&self) {
        let mut cores = self.lock();
        let now = self.now(&mut cores);
        // Next local 08:00 is computed by the setting UI in a later REL
        // task; until then "until tomorrow" is the next midnight-plus-8h in
        // server time, which is documented as an approximation.
        let day_ms = 86_400_000;
        let until_ms = (now.server_now_ms / day_ms + 1) * day_ms + 8 * 3_600_000;
        let effects = cores
            .notify
            .set_dnd(DndMode::UntilTomorrow { until_ms }, &now);
        cores.pending_effects.extend(effects);
    }

    pub fn clear_dnd(&self) {
        let mut cores = self.lock();
        let now = self.now(&mut cores);
        let effects = cores.notify.set_dnd(DndMode::Off, &now);
        cores.pending_effects.extend(effects);
    }

    // ------------------------------------------------------------ accounts

    pub fn logout(
        &self,
        account_id: &str,
        mode: LogoutMode,
    ) -> Result<core_account::RevokeList, AppError> {
        let mut cores = self.lock();
        let id = AccountId::new(account_id);
        let old_ctx = cores.accounts.current_context(&id);
        let revoke = cores.accounts.logout(&id, mode)?;
        if let Some(old) = old_ctx.as_ref() {
            let now = self.now(&mut cores);
            let effects = cores.notify.set_account_notifications(&old, false, &now);
            cores.pending_effects.extend(effects);
            let new_ctx = cores
                .accounts
                .current_context(&id)
                .unwrap_or_else(|| old.next_generation());
            let _ = cores.im.invalidate_generation(new_ctx);
        }
        self.pump_rounds(&mut cores);
        let mut jobs = self.collect_round_snapshots(&cores);
        if let Some(old) = old_ctx.as_ref() {
            let ns = Namespace::from_context(old);
            if let Some(job) = jobs.iter_mut().find(|job| job.ns == ns) { job.logout_lock = true; }
            else if cores.store.is_some() {
                jobs.push(PersistJob { ns: ns.clone(), seq: self.persist_seq.fetch_add(1, Ordering::Relaxed),
                    rounds: None, compensation_cursor_ms: None, logout_lock: true, unlock_before_write: false });
            }
            cores.persist_unlock_pending.remove(&ns);
            cores.persist_locked.insert(ns);
        }
        drop(cores);
        self.enqueue_snapshots(jobs);
        Ok(revoke)
    }

    // ------------------------------------------------------------ quit

    /// Tray "退出": drains the store (MaintenanceBarrier is a later REL
    /// task; here the cores are pure so there is nothing in flight) and
    /// exits.
    pub fn request_quit(&self, app: &AppHandle) {
        {
            let mut cores = self.lock();
            cores.quit_requested = true;
        }
        app.exit(0);
    }

    pub fn quit_requested(&self) -> bool {
        self.lock().quit_requested
    }
}

fn convert_fact(dto: AdapterFactDto) -> Result<Fact, AppError> {
    Ok(match dto {
        AdapterFactDto::Message { fact } => Fact::Message(fact.try_into()?),
        AdapterFactDto::Conversation { fact } => Fact::Conversation(fact.try_into()?),
        AdapterFactDto::ConversationListSync {
            full,
            last_update_time_ms,
        } => Fact::ConversationListSync {
            full,
            last_update_time_ms,
        },
        AdapterFactDto::CompensationSync {
            last_message_timestamp_ms,
        } => Fact::CompensationSync {
            last_message_timestamp_ms,
        },
        AdapterFactDto::Transport { state } => Fact::Transport(match state.as_str() {
            "connecting" => TransportState::Connecting,
            "connected" => TransportState::Connected,
            "disconnected" => TransportState::Disconnected,
            "reconnecting" => TransportState::Reconnecting,
            other => {
                return Err(AppError::new(
                    "im.invalid_fact",
                    format!("unknown transport state {other:?}"),
                ))
            }
        }),
        AdapterFactDto::AuthInvalid => Fact::AuthInvalid,
    })
}

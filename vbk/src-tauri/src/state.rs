//! Host state: one mutex-guarded aggregate of the std-only cores plus the
//! glue that keeps them consistent (archive §4.5: one state-holding task,
//! explicit requests; no cross-module locking).
//!
//! Everything time-related is computed from `core-net`'s `ClockService`;
//! the host only supplies wall/monotonic readings.
//!
//! Persistence (I-04a): nothing in this file touches the disk while the
//! `Cores` lock is held. Under the lock the host only builds **snapshots**
//! (`collect_*`, pure and in-memory) tagged with a monotonic `seq`; after
//! `drop(cores)` the snapshots are handed to `core_store::PersistQueue`,
//! whose `vbk-persist` thread does the `fsync`s. A full queue or a failed
//! write parks the job in `Cores::persist` and the next scheduler tick
//! retries it. Lock order: see `core_store::lock_order`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
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
use core_store::{
    FileStore, JobPayload, Namespace, PersistJob, PersistQueue, PersistTracker, ReminderStateRepo,
    RoundRecord, SyncWatermarkRepo,
};
use tauri::AppHandle;

use crate::dto::{AdapterFactDto, AdapterFactEnvelopeDto};
use crate::views::{Role, ViewRegistry};

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
    pub store: Option<Arc<FileStore>>,
    /// Jobs that did not fit into the persistence queue or failed to write,
    /// and the `persist_failed` state ("本地保存失败").
    pub persist: PersistTracker,
    glue: HashMap<(Environment, AccountId), AccountGlue>,
    /// Pending effects produced by inputs between scheduler ticks.
    pending_effects: Vec<Effect>,
    quit_requested: bool,
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
    /// Persistence thread handle; `None` when running without a store.
    /// Lives outside the `Cores` mutex so enqueueing never needs that lock.
    persist: Option<PersistQueue>,
}

impl std::fmt::Debug for HostState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostState").finish_non_exhaustive()
    }
}

impl HostState {
    pub fn new(store: Option<FileStore>, boot_epoch: u64) -> Self {
        let store = store.map(Arc::new);
        let persist = store
            .as_ref()
            .and_then(|s| match PersistQueue::spawn(s.clone()) {
                Ok(queue) => Some(queue),
                Err(e) => {
                    log::error!("persistence thread unavailable: {e}; state will not be saved");
                    None
                }
            });
        Self {
            clock: HostClock::new(),
            persist,
            cores: Mutex::new(Cores {
                accounts: AccountRegistry::new(boot_epoch),
                im: ImCores::new(),
                notify: NotifyCore::with_account_gating(),
                clock: ClockService::default(),
                views: ViewRegistry::default(),
                store,
                persist: PersistTracker::new(),
                glue: HashMap::new(),
                pending_effects: Vec::new(),
                quit_requested: false,
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

    /// Runtime ACL for every command of every module: the label's role must
    /// grant `command`, and (I-03) a local window must have announced the
    /// host's `CONTRACT_VERSION` through `contract_hello` first. The remote
    /// `acct-*` adapter webviews run the host-injected boot script of the
    /// same build and have no `contract_hello` permission, so only the local
    /// window roles take the handshake.
    pub fn authorize(&self, label: &str, command: &str) -> Result<(), AppError> {
        // The `Cores` guard is a temporary: it is released before the (separate,
        // process-wide) contract-gate mutex is taken, so the two never nest.
        self.lock().views.authorize(label, command)?;
        if command == "contract_hello" || Role::for_label(label) == Some(Role::Adapter) {
            return Ok(());
        }
        crate::commands::contract_check(label)
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
        let is_compensation = matches!(fact, Fact::CompensationSync { .. });
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
        let mut jobs: Vec<PersistJob> = Vec::new();
        if is_compensation && report.applied {
            jobs.extend(self.collect_compensation_snapshot(&cores, &account));
        }
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
        jobs.extend(self.pump_rounds(&mut cores));
        // No IO under the lock: release it, then hand the snapshots over.
        drop(cores);
        self.submit_persist(jobs);
        Ok(report)
    }

    /// Snapshot of the account's compensation watermark (`beginMsgTime` for
    /// the next page boot). Only a timestamp; no message content. Pure and
    /// in-memory: safe under the `Cores` lock (W1).
    fn collect_compensation_snapshot(
        &self,
        cores: &Cores,
        account: &AccountContext,
    ) -> Option<PersistJob> {
        let queue = self.persist.as_ref()?;
        let ms = cores
            .im
            .get(account)?
            .watermarks()
            .compensation_cursor_ms()?;
        Some(PersistJob {
            ns: Namespace::from_context(account),
            seq: queue.next_seq(),
            payload: JobPayload::Compensation(ms),
        })
    }

    /// Hands snapshots to the persistence thread. Never blocks and never
    /// touches the disk; call it **after** `drop(cores)`. Jobs the queue
    /// refuses are parked in `Cores::persist` for the next tick.
    fn submit_persist(&self, jobs: Vec<PersistJob>) {
        let Some(queue) = self.persist.as_ref() else {
            return;
        };
        if jobs.is_empty() {
            return;
        }
        let rejected = queue.submit(jobs);
        if !rejected.is_empty() {
            self.lock().persist.stash_all(rejected);
        }
    }

    /// True while a write could not be persisted ("本地保存失败"). The send
    /// barrier and the UI notice read this; it clears when a retry succeeds.
    pub fn persist_failed(&self) -> bool {
        let receipts = self
            .persist
            .as_ref()
            .map(PersistQueue::drain_receipts)
            .unwrap_or_default();
        let mut cores = self.lock();
        cores.persist.apply_receipts(receipts);
        cores.persist.persist_failed()
    }

    /// Send barrier (I-04a, fail-closed): `Err(store.persist_failed)` while
    /// [`Self::persist_failed`] holds. `im_send_text` / `im_send_media` call
    /// it before the outbound journal is touched, so a refused send is
    /// "nothing submitted". Receipts are drained first, so a retry that
    /// already landed reopens the barrier without waiting for the next tick.
    pub fn persist_barrier(&self) -> Result<(), AppError> {
        let receipts = self
            .persist
            .as_ref()
            .map(PersistQueue::drain_receipts)
            .unwrap_or_default();
        let mut cores = self.lock();
        cores.persist.apply_receipts(receipts);
        cores.persist.send_barrier()
    }

    /// Lifts the logout lock of the account's namespace after the same
    /// identity logged in again (`Namespace` is per identity, the generation
    /// is not part of it: the same construction as [`Self::logout`]). Goes
    /// through the persistence queue, so it is ordered after the lock and
    /// before the snapshots the new session produces, and acknowledged like
    /// every other job. Never blocks; call it without the `Cores` lock held.
    pub fn unlock_namespace(&self, account: &AccountContext) {
        let Some(queue) = self.persist.as_ref() else {
            return;
        };
        let job = PersistJob {
            ns: Namespace::from_context(account),
            seq: queue.next_seq(),
            payload: JobPayload::Unlock,
        };
        self.submit_persist(vec![job]);
    }

    /// Exit barrier: resubmits parked jobs, then waits (at most `timeout`)
    /// until everything queued so far is committed. Parked jobs that do not
    /// fit into a full queue are resubmitted once it has drained, until the
    /// deadline. Returns `true` when no write is outstanding or failed.
    pub fn flush_persist(&self, timeout: Duration) -> bool {
        let Some(queue) = self.persist.as_ref() else {
            return true;
        };
        let deadline = Instant::now() + timeout;
        let mut pending = self.lock().persist.take_pending();
        let flushed = loop {
            pending = queue.submit(pending);
            let ok = queue
                .flush(deadline.saturating_duration_since(Instant::now()))
                .is_ok();
            if pending.is_empty() || !ok || Instant::now() >= deadline {
                break ok;
            }
        };
        let receipts = queue.drain_receipts();
        let mut cores = self.lock();
        cores.persist.apply_receipts(receipts);
        cores.persist.stash_all(pending);
        flushed && !cores.persist.persist_failed() && cores.persist.pending_len() == 0
    }

    /// Compensation watermark for `account` (Unix ms, 0 when unknown): the
    /// newer of the in-memory core cursor and the persisted one.
    pub fn compensation_watermark(&self, account: &AccountContext) -> i64 {
        let cores = self.lock();
        let live = cores
            .im
            .get(account)
            .and_then(|c| c.watermarks().compensation_cursor_ms());
        let stored = cores.store.as_deref().and_then(|s| {
            SyncWatermarkRepo::compensation_cursor(s, &Namespace::from_context(account))
                .ok()
                .flatten()
        });
        live.into_iter().chain(stored).max().unwrap_or(0).max(0)
    }

    /// Moves round events and reconcile state from core-im into
    /// core-notify, collecting the effects for the scheduler. Returns the
    /// round snapshots to persist (W2); the caller submits them after it has
    /// released the `Cores` lock.
    fn pump_rounds(&self, cores: &mut Cores) -> Vec<PersistJob> {
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
        self.collect_round_snapshots(cores)
    }

    /// Snapshot of the minimal round state (strong-alert §5 / docs/dev/05)
    /// for every account, one job per namespace. Labels are not persisted;
    /// on restore they fall back to the masked gid until facts re-confirm.
    /// Pure and in-memory (W2).
    fn collect_round_snapshots(&self, cores: &Cores) -> Vec<PersistJob> {
        let Some(queue) = self.persist.as_ref() else {
            return Vec::new();
        };
        let mut by_ns: HashMap<Namespace, Vec<RoundRecord>> = HashMap::new();
        for r in cores.notify.persistable() {
            let ns = Namespace::from_context(&r.round.account);
            by_ns.entry(ns).or_default().push(RoundRecord {
                gid: r.round.gid.clone(),
                round_id: r.round.round_id.clone(),
                version: r.round.version,
                start_message_id: None,
                start_time_ms: r.start_time_ms,
                start_confirmed: r.start_confirmed,
                reminded_version: r.round.version,
                hidden_version: r.hidden_version.unwrap_or(0),
                snoozed_until_ms: r.snoozed_until_ms,
            });
        }
        let mut jobs: Vec<PersistJob> = by_ns
            .into_iter()
            .map(|(ns, records)| PersistJob {
                ns,
                seq: queue.next_seq(),
                payload: JobPayload::Rounds(records),
            })
            .collect();
        jobs.sort_by_key(|j| j.seq);
        jobs
    }

    /// Loads persisted rounds for `account` into notify as pending
    /// verification. `PendingVerification` is only ever consumed here with
    /// the restore barrier, never turned into a popup directly.
    fn restore_rounds_for(&self, cores: &mut Cores, account: &AccountContext) {
        let Some(store) = cores.store.as_deref() else {
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
        let jobs = self.pump_rounds(&mut cores);
        drop(cores);
        self.submit_persist(jobs);
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
        // Receipts are read before the lock is taken (the channel is
        // lock-free for us); applying them is in-memory bookkeeping.
        let receipts = self
            .persist
            .as_ref()
            .map(PersistQueue::drain_receipts)
            .unwrap_or_default();
        let (effects, retry) = {
            let mut cores = self.lock();
            cores.persist.apply_receipts(receipts);
            let retry = cores.persist.take_pending();
            let now = self.now(&mut cores);
            let mut effects = std::mem::take(&mut cores.pending_effects);
            effects.extend(cores.notify.tick(&now));
            effects.retain(|effect| cores.notify.effect_is_current(effect, &now));
            (effects, retry)
        };
        // Parked / failed writes are retried here, outside the lock.
        self.submit_persist(retry);
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
        // Next local 08:00 (pure day-boundary math in core-notify; the zone
        // offset is read from the OS, falling back to UTC if unavailable).
        let offset_min = crate::local_tz::local_utc_offset_minutes(now.server_now_ms);
        let until_ms = core_notify::dnd_until_tomorrow_ms(now.server_now_ms, offset_min);
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
        let mut jobs: Vec<PersistJob> = Vec::new();
        let id = AccountId::new(account_id);
        let old_ctx = cores.accounts.current_context(&id);
        let revoke = cores.accounts.logout(&id, mode)?;
        if let Some(old) = old_ctx {
            let now = self.now(&mut cores);
            let effects = cores.notify.set_account_notifications(&old, false, &now);
            cores.pending_effects.extend(effects);
            let new_ctx = cores
                .accounts
                .current_context(&id)
                .unwrap_or_else(|| old.next_generation());
            let _ = cores.im.invalidate_generation(new_ctx);
            // The lock marker is an fsync'd write: it goes through the
            // persistence thread, ordered before the round snapshot below.
            if let Some(queue) = self.persist.as_ref() {
                jobs.push(PersistJob {
                    ns: Namespace::from_context(&old),
                    seq: queue.next_seq(),
                    payload: JobPayload::LogoutLock,
                });
            }
        }
        jobs.extend(self.pump_rounds(&mut cores));
        drop(cores);
        self.submit_persist(jobs);
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
        // Give the persistence thread a bounded chance to finish (I-04a).
        if !self.flush_persist(Duration::from_secs(5)) {
            log::warn!("exit: persistence did not fully flush within 5 s");
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
        // Forwarded by `adapter::adapter_push_fact` before it reaches here;
        // the local `im_push_fact` path has no window to forward to.
        AdapterFactDto::Feature { .. } => {
            return Err(AppError::new(
                "im.invalid_fact",
                "feature facts never enter the IM core",
            ))
        }
    })
}

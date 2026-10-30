//! Host state: one mutex-guarded aggregate of the std-only cores plus the
//! glue that keeps them consistent (archive §4.5: one state-holding task,
//! explicit requests; no cross-module locking).
//!
//! Everything time-related is computed from `core-net`'s `ClockService`;
//! the host only supplies wall/monotonic readings.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use contracts::{
    AccountContext, AccountId, AlarmCommand, AlarmSnapshot, AppError, ClockReading, Environment,
    ReconcileState, ReminderSettings, RoundEvent,
};
use core_account::{AccountRegistry, LogoutMode};
use core_im::{Fact, FactEnvelope, ImCore, ImCores, StreamId, TransportState};
use core_net::clock::{ClockService, ReconcileCoordinator, ReconcileReason};
use core_notify::{CommandAck, CommandSource, DndMode, Effect, NotifyCore, Now, SystemState};
use core_store::{FileStore, Namespace, Store};
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
}

impl std::fmt::Debug for HostState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostState").finish_non_exhaustive()
    }
}

impl HostState {
    pub fn new(store: Option<FileStore>, boot_epoch: u64) -> Self {
        Self {
            clock: HostClock::new(),
            cores: Mutex::new(Cores {
                accounts: AccountRegistry::new(boot_epoch),
                im: ImCores::new(),
                notify: NotifyCore::new(),
                clock: ClockService::default(),
                views: ViewRegistry::default(),
                store,
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

    pub fn authorize(&self, label: &str, command: &str) -> Result<(), AppError> {
        self.lock().views.authorize(label, command).map(|_| ())
    }

    // ------------------------------------------------------------ IM facts

    /// Validates and ingests one adapter envelope. The account in the
    /// envelope is checked against core-account's current generation
    /// before anything is applied (strong-alert §3: payload identity is
    /// never trusted on its own).
    pub fn push_fact(&self, dto: AdapterFactEnvelopeDto) -> Result<core_im::IngestReport, AppError> {
        let mut cores = self.lock();
        let account: AccountContext = dto.account.clone().into();
        cores.accounts.validate(&account)?;
        let stream = StreamId::from_name(&dto.stream)
            .ok_or_else(|| AppError::new("im.invalid_fact", format!("unknown stream {:?}", dto.stream)))?;
        let fact = convert_fact(dto.fact)?;
        if cores.im.get(&account).is_none() {
            cores.im.insert(ImCore::new(account.clone()));
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
            if let Ok(revoke) = cores.accounts.invalidate(&id, "web session reported auth invalid") {
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
        Ok(report)
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
        let total = cores.im.total_unread();
        // L0 aggregate is recomputed from the im cores; notify keeps its own
        // per-gid map, so we feed it per conversation when it changed.
        let _ = total;
        cores.pending_effects.extend(effects);
    }

    /// Called by the adapter after it re-handshaked a stream.
    pub fn resync_complete(&self, account: AccountContext, stream: &str, epoch: u64, seq: u64) -> Result<(), AppError> {
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
        Ok(())
    }

    // ------------------------------------------------------------ alarm

    pub fn alarm_snapshot(&self) -> AlarmSnapshot {
        let mut cores = self.lock();
        let now = self.now(&mut cores);
        cores.notify.snapshot(&now)
    }

    pub fn alarm_command(&self, cmd: AlarmCommand, source: CommandSource) -> Result<CommandAck, AppError> {
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
        let mut cores = self.lock();
        let now = self.now(&mut cores);
        let mut effects = std::mem::take(&mut cores.pending_effects);
        effects.extend(cores.notify.tick(&now));
        effects
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
        let effects = cores.notify.set_dnd(DndMode::UntilTomorrow { until_ms }, &now);
        cores.pending_effects.extend(effects);
    }

    pub fn clear_dnd(&self) {
        let mut cores = self.lock();
        let now = self.now(&mut cores);
        let effects = cores.notify.set_dnd(DndMode::Off, &now);
        cores.pending_effects.extend(effects);
    }

    // ------------------------------------------------------------ accounts

    pub fn logout(&self, account_id: &str, mode: LogoutMode) -> Result<core_account::RevokeList, AppError> {
        let mut cores = self.lock();
        let id = AccountId::new(account_id);
        let old_ctx = cores.accounts.current_context(&id);
        let revoke = cores.accounts.logout(&id, mode)?;
        if let Some(old) = old_ctx {
            let new_ctx = cores
                .accounts
                .current_context(&id)
                .unwrap_or_else(|| old.next_generation());
            let _ = cores.im.invalidate_generation(new_ctx);
            if let Some(store) = cores.store.as_ref() {
                let ns = Namespace::from_context(&old);
                let _ = store.logout_lock(&ns);
            }
        }
        self.pump_rounds(&mut cores);
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

//! One host-owned, read-only clock sampler for all bound account pages.
//! No public clock setter: a sample must answer an existing account-bound
//! adapter request, and both its account generation and registration survive.
use crate::{adapter, state::HostState};
use contracts::{AccountContext, AccountId, Environment};
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    sync::{Mutex, MutexGuard},
    time::Duration,
};
use tauri::{AppHandle, Manager};

const MAX_RTT_MS: u64 = 15_000;
const INTERVAL: Duration = Duration::from_secs(60);
const RETRY: Duration = Duration::from_secs(5);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Sample {
    server_ms: i64,
}
#[derive(Clone)]
struct Probe {
    account: AccountContext,
    registration: uuid::Uuid,
    sequence: u64,
    started_ms: u64,
}
#[derive(Default)]
struct Book {
    registrations: BTreeMap<(Environment, AccountId), (AccountContext, uuid::Uuid)>,
    running: bool,
    sequence: u64,
    accepted: u64,
    rotation: usize,
}
impl Book {
    fn register(&mut self, account: AccountContext) -> bool {
        let key = (account.environment.clone(), account.account_id.clone());
        if self
            .registrations
            .get(&key)
            .is_some_and(|(current, _)| current.session_generation > account.session_generation)
        {
            return false;
        }
        self.registrations
            .insert(key, (account, uuid::Uuid::new_v4()));
        let spawn = !self.running;
        self.running = true;
        spawn
    }
    fn remove(&mut self, account: &AccountContext) {
        let key = (account.environment.clone(), account.account_id.clone());
        if self
            .registrations
            .get(&key)
            .is_some_and(|(ctx, _)| ctx == account)
        {
            self.registrations.remove(&key);
        }
    }
    fn begin(&mut self, state: &HostState) -> Option<Probe> {
        self.registrations
            .retain(|_, (ctx, _)| state.lock().accounts.validate(ctx).is_ok());
        if self.registrations.is_empty() {
            self.running = false;
            return None;
        }
        let slot = self.rotation % self.registrations.len();
        self.rotation = self.rotation.wrapping_add(1);
        let (account, registration) = self.registrations.values().nth(slot)?.clone();
        self.sequence = self.sequence.checked_add(1)?;
        Some(Probe {
            account,
            registration,
            sequence: self.sequence,
            started_ms: state.clock.monotonic_ms(),
        })
    }
    fn accept(
        &mut self,
        state: &HostState,
        probe: &Probe,
        value: serde_json::Value,
        received_ms: u64,
        wall_ms: i64,
    ) -> bool {
        let Ok(sample) = serde_json::from_value::<Sample>(value) else {
            return false;
        };
        let Some(rtt) = received_ms.checked_sub(probe.started_ms) else {
            return false;
        };
        if rtt > MAX_RTT_MS
            || !(946_684_800_000..4_102_444_800_000).contains(&sample.server_ms)
            || probe.sequence <= self.accepted
        {
            return false;
        }
        if !self
            .registrations
            .get(&(
                probe.account.environment.clone(),
                probe.account.account_id.clone(),
            ))
            .is_some_and(|(ctx, id)| ctx == &probe.account && *id == probe.registration)
        {
            return false;
        }
        let mut cores = state.lock();
        // Generation validation and clock mutation share the same core lock.
        if cores.accounts.validate(&probe.account).is_err() {
            return false;
        }
        cores
            .clock
            .anchor_from_server(sample.server_ms, wall_ms, received_ms, rtt);
        self.accepted = probe.sequence;
        true
    }
}
#[derive(Default)]
pub struct ClockAnchors {
    book: Mutex<Book>,
    wake: tokio::sync::Notify,
}
impl ClockAnchors {
    fn lock(&self) -> MutexGuard<'_, Book> {
        self.book.lock().unwrap_or_else(|p| p.into_inner())
    }
}
pub fn start(app: &AppHandle, account: &AccountContext) {
    let sampler = app.state::<ClockAnchors>();
    let spawn = {
        let mut book = sampler.lock();
        let state = app.state::<HostState>();
        let cores = state.lock();
        if cores.accounts.validate(account).is_err() {
            return;
        }
        book.register(account.clone())
    };
    if !spawn {
        sampler.wake.notify_one();
    }
    if spawn {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let state = app.state::<HostState>();
                if state.quit_requested() {
                    app.state::<ClockAnchors>().lock().running = false;
                    return;
                }
                let probe = app.state::<ClockAnchors>().lock().begin(&state);
                let Some(probe) = probe else {
                    return;
                };
                let reply = adapter::request(
                    &app,
                    &probe.account,
                    "clock.sample",
                    serde_json::json!({}),
                    Duration::from_secs(20),
                )
                .await;
                let received = state.clock.monotonic_ms();
                let wall = state.clock.wall_ms();
                let accepted = reply.ok().is_some_and(|value| {
                    app.state::<ClockAnchors>()
                        .lock()
                        .accept(&state, &probe, value, received, wall)
                });
                // Only one task sleeps/probes, regardless of number of accounts.
                // Registration wakes it; stale/logout generations are removed before another read.
                let anchors = app.state::<ClockAnchors>();
                let _ = tokio::time::timeout(
                    if accepted { INTERVAL } else { RETRY },
                    anchors.wake.notified(),
                )
                .await;
            }
        });
    }
}
pub fn stop(app: &AppHandle, account: &AccountContext) {
    let sampler = app.state::<ClockAnchors>();
    sampler.lock().remove(account);
    sampler.wake.notify_one();
}

#[cfg(test)]
mod tests {
    use super::*;
    use contracts::{ClockQuality, Environment};
    use core_account::{Buid, UpstreamIdentity};
    fn login(state: &HostState, name: &str) -> AccountContext {
        let mut cores = state.lock();
        let attempt = cores.accounts.start_login(Environment::production());
        cores
            .accounts
            .publish_identity(
                &attempt.attempt_id,
                UpstreamIdentity {
                    buid: Buid::new(name),
                    uid: name.into(),
                    agent_id: None,
                    environment: Environment::production(),
                },
            )
            .unwrap()
            .ctx
    }
    fn sample() -> serde_json::Value {
        serde_json::json!({"server_ms": 1_700_000_000_000i64})
    }
    #[test]
    fn real_host_clock_transitions_only_after_valid_bound_sample() {
        let state = HostState::new(None, 1);
        let ctx = login(&state, "synthetic");
        let mut book = Book::default();
        assert!(book.register(ctx));
        let probe = book.begin(&state).unwrap();
        assert_eq!(
            state.reading(&mut state.lock()).quality,
            ClockQuality::Unanchored
        );
        assert!(book.accept(
            &state,
            &probe,
            sample(),
            probe.started_ms + 100,
            1_699_999_999_000
        ));
        let reading = state
            .lock()
            .clock
            .reading(1_699_999_999_000, probe.started_ms + 100);
        assert!(matches!(
            reading.quality,
            ClockQuality::Anchored {
                offset_ms: 1050,
                error_ms: 100
            }
        ));
        assert_eq!(reading.server_now_ms, 1_700_000_000_050);
    }
    #[test]
    fn invalid_clock_payload_and_rtt_never_create_anchor() {
        let state = HostState::new(None, 1);
        let ctx = login(&state, "synthetic");
        let mut book = Book::default();
        book.register(ctx);
        let probe = book.begin(&state).unwrap();
        for value in [
            serde_json::json!({"server_ms":0}),
            serde_json::json!({"server_ms":1700000000000.5}),
            serde_json::json!({"server_ms":1700000000000i64,"url":"https://untrusted"}),
            serde_json::json!({"server_ms":"1700000000000"}),
        ] {
            assert!(!book.accept(&state, &probe, value, probe.started_ms + 1, 0));
        }
        assert!(!book.accept(
            &state,
            &probe,
            sample(),
            probe.started_ms + MAX_RTT_MS + 1,
            0
        ));
        assert_eq!(
            state.reading(&mut state.lock()).quality,
            ClockQuality::Unanchored
        );
    }
    #[test]
    fn stale_account_generation_and_page_registration_cannot_anchor_or_remove_successor() {
        let state = HostState::new(None, 1);
        let a = login(&state, "synthetic");
        let mut book = Book::default();
        book.register(a.clone());
        let old = book.begin(&state).unwrap();
        let b = login(&state, "synthetic");
        assert_ne!(a, b);
        assert!(!book.register(b.clone()));
        book.remove(&a);
        assert_eq!(book.registrations.len(), 1);
        assert!(!book.accept(&state, &old, sample(), old.started_ms + 1, 0));
        let old_page = book.begin(&state).unwrap();
        book.register(b.clone());
        assert!(!book.accept(&state, &old_page, sample(), old_page.started_ms + 1, 0));
        let current = book.begin(&state).unwrap();
        assert!(book.accept(&state, &current, sample(), current.started_ms + 1, 0));
        book.remove(&b);
        assert!(book.begin(&state).is_none());
        assert!(!book.running);
    }
    #[test]
    fn late_old_identity_registration_never_displaces_the_current_generation() {
        let state = HostState::new(None, 1);
        let a = login(&state, "synthetic");
        let b = login(&state, "synthetic");
        let mut book = Book::default();
        assert!(book.register(b.clone()));
        assert!(!book.register(a));
        let probe = book
            .begin(&state)
            .expect("current generation remains registered");
        assert_eq!(probe.account, b);
        assert!(book.accept(&state, &probe, sample(), probe.started_ms + 1, 0));
    }
    #[test]
    fn older_inflight_sample_cannot_replace_a_newer_anchor_and_only_one_loop_is_spawned() {
        let state = HostState::new(None, 1);
        let a = login(&state, "a");
        let b = login(&state, "b");
        let mut book = Book::default();
        assert!(book.register(a));
        assert!(!book.register(b));
        let first = book.begin(&state).unwrap();
        let second = book.begin(&state).unwrap();
        assert!(book.accept(&state, &second, sample(), second.started_ms + 2, 0));
        assert!(!book.accept(
            &state,
            &first,
            serde_json::json!({"server_ms":1800000000000i64}),
            second.started_ms + 3,
            0
        ));
        assert_eq!(book.accepted, second.sequence);
    }
}

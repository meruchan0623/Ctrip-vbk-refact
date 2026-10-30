#![allow(dead_code)]

use contracts::{AccountContext, AccountId, Environment, RoundEvent, WaitingRoundRef};
use core_notify::{Effect, NotifyCore, Now, Sound};

pub const T0_SERVER: i64 = 1_700_000_000_000;

pub fn t0() -> Now {
    Now::new(100_000, T0_SERVER, true)
}

pub fn acc(id: &str, generation: u64) -> AccountContext {
    AccountContext::new(AccountId::new(id), Environment::production(), generation)
}

pub fn rref(account: &AccountContext, gid: &str, round_id: &str, version: u64) -> WaitingRoundRef {
    WaitingRoundRef {
        account: account.clone(),
        gid: gid.into(),
        round_id: round_id.into(),
        version,
    }
}

pub fn started(round: WaitingRoundRef, start_time_ms: Option<i64>, confirmed: bool) -> RoundEvent {
    RoundEvent::Started {
        round,
        start_message_id: start_time_ms.map(|_| "m1".to_string()),
        start_time_ms,
        start_confirmed: confirmed,
        label: "c***r".into(),
    }
}

/// Opens a confirmed round for `gid` starting at `now`.
pub fn open_round(core: &mut NotifyCore, account: &AccountContext, gid: &str, now: &Now) -> Vec<Effect> {
    core.apply_round_event(
        started(rref(account, gid, &format!("r-{gid}"), 1), Some(now.server_now_ms), true),
        now,
    )
}

/// Ticks at 1 Hz for seconds `from_s+1 ..= to_s` after `base` and returns
/// every effect in order.
pub fn drive(core: &mut NotifyCore, base: &Now, from_s: u64, to_s: u64) -> Vec<Effect> {
    let mut all = Vec::new();
    for s in (from_s + 1)..=to_s {
        all.extend(core.tick(&base.plus_ms(s * 1000)));
    }
    all
}

pub fn raises(effects: &[Effect]) -> usize {
    effects
        .iter()
        .filter(|e| matches!(e, Effect::ShowAlarm { raise: true }))
        .count()
}

pub fn shows(effects: &[Effect]) -> usize {
    effects
        .iter()
        .filter(|e| matches!(e, Effect::ShowAlarm { .. }))
        .count()
}

pub fn sounds(effects: &[Effect], sound: Sound) -> usize {
    effects
        .iter()
        .filter(|e| **e == Effect::PlaySound(sound))
        .count()
}

pub fn has(effects: &[Effect], wanted: &Effect) -> bool {
    effects.iter().any(|e| e == wanted)
}

pub fn count(effects: &[Effect], wanted: &Effect) -> usize {
    effects.iter().filter(|e| *e == wanted).count()
}

mod common;

use common::*;
use contracts::{AccountContext, Environment, RoundEvent};
use core_notify::{Effect, NotifyCore, Sound, SystemState, ACCOUNT_STATUS_TTL_MS};

fn is_attention(effect: &Effect) -> bool {
    matches!(
        effect,
        Effect::PlaySound(_)
            | Effect::Banner { .. }
            | Effect::SystemToast { .. }
            | Effect::TrayFlash(true)
            | Effect::ShowAlarm { .. }
    )
}

#[test]
fn host_defaults_closed_and_keeps_unread_and_waiting_facts() {
    let mut core = NotifyCore::with_account_gating();
    let now = t0();
    let account = acc("a", 1);
    let mut effects = core.on_unread_changed(&account, "g", 3);
    effects.extend(open_round(&mut core, &account, "g", &now));
    effects.extend(core.on_new_message(&account, "g", true, &now));
    effects.extend(core.tick(&now.plus_ms(120_000)));
    assert!(!effects.iter().any(is_attention));
    assert_eq!(core.unread_total(), 3);
    assert_eq!(core.rounds().len(), 1);
    assert!(core.rounds()[0].start_confirmed);
    assert!(core.snapshot(&now.plus_ms(120_000)).entries.is_empty());
    // Restoring availability presents the existing unanswered round; it
    // never invents a reply or restarts its waiting clock.
    let effects = core.set_account_notifications(&account, true, &now.plus_ms(120_000));
    assert_eq!(raises(&effects), 1);
    assert_eq!(
        core.snapshot(&now.plus_ms(120_000)).entries[0].waited_seconds,
        120
    );
}

#[test]
fn revoking_one_account_does_not_silence_another_or_drop_its_messages() {
    let mut core = NotifyCore::with_account_gating();
    let now = t0();
    let a = acc("a", 1);
    let b = acc("b", 1);
    core.set_account_notifications(&a, true, &now);
    core.set_account_notifications(&b, true, &now);
    open_round(&mut core, &a, "a-g", &now);
    open_round(&mut core, &b, "b-g", &now);
    let later = now.plus_ms(120_000);
    core.set_account_notifications(&a, true, &later);
    core.set_account_notifications(&b, true, &later);
    let effects = core.set_account_notifications(&a, false, &later);
    assert!(!effects.contains(&Effect::HideAlarm));
    assert!(!effects.contains(&Effect::StopSound));
    let entries = core.snapshot(&later).entries;
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].account, b);
    assert_eq!(core.rounds().len(), 2);
    assert!(core.on_new_message(&a, "a-g", true, &later).is_empty());
    let effects = core.on_new_message(&b, "b-g", true, &later);
    assert!(effects
        .iter()
        .any(|e| matches!(e, Effect::Banner { account, .. } if account == &b)));
    assert_eq!(sounds(&effects, Sound::NewMessage), 1);
}

#[test]
fn host_monotonic_expiry_stops_active_alarm_and_rejects_queued_attention() {
    let mut core = NotifyCore::with_account_gating();
    let now = t0();
    let account = acc("a", 1);
    open_round(&mut core, &account, "g", &now);
    let later = now.plus_ms(120_000);
    let queued = core.set_account_notifications(&account, true, &later);
    assert_eq!(raises(&queued), 1);
    assert!(queued
        .iter()
        .filter(|e| is_attention(e))
        .all(|e| core.effect_is_current(e, &later)));
    let expired = later.plus_ms(ACCOUNT_STATUS_TTL_MS);
    assert!(queued
        .iter()
        .filter(|e| is_attention(e))
        .all(|e| !core.effect_is_current(e, &expired)));
    let effects = core.tick(&expired);
    assert!(effects.contains(&Effect::HideAlarm));
    assert!(effects.contains(&Effect::StopSound));
    assert!(effects.contains(&Effect::TrayFlash(false)));
    assert!(!effects.iter().any(is_attention));
    assert_eq!(core.rounds().len(), 1);
}

#[test]
fn expired_or_revoked_locked_banners_never_reappear_on_unlock() {
    for revoke in [false, true] {
        let mut core = NotifyCore::with_account_gating();
        let now = t0();
        let account = acc("a", 1);
        core.set_account_notifications(&account, true, &now);
        core.set_system_state(
            SystemState {
                locked: true,
                ..SystemState::default()
            },
            &now,
        );
        core.on_new_message(&account, "g", true, &now);
        if revoke {
            core.set_account_notifications(&account, false, &now);
        }
        let effects =
            core.set_system_state(SystemState::default(), &now.plus_ms(ACCOUNT_STATUS_TTL_MS));
        assert!(!effects.iter().any(is_attention));
    }
}

#[test]
fn status_expiry_reports_getoff_once_and_never_releases_stale_held_banners() {
    let mut core = NotifyCore::with_account_gating();
    let now = t0();
    let a = acc("a", 1);
    let b = acc("b", 1);
    core.set_account_notifications(&a, true, &now);
    core.set_account_notifications(&b, false, &now);
    core.set_system_state(
        SystemState {
            locked: true,
            ..SystemState::default()
        },
        &now,
    );
    core.on_new_message(&a, "g", true, &now);
    let expired = now.plus_ms(ACCOUNT_STATUS_TTL_MS);
    let mut accounts = core.take_expired_account_statuses(&expired);
    accounts.sort_by_key(|ctx| ctx.account_id.as_str().to_owned());
    assert_eq!(accounts, vec![a.clone(), b]);
    assert!(core.take_expired_account_statuses(&expired).is_empty());
    core.set_account_notifications(&a, true, &expired);
    let effects = core.set_system_state(SystemState::default(), &expired);
    assert!(!effects.iter().any(is_attention));
}

#[test]
fn leases_are_isolated_by_environment_and_generation_and_refresh_independently() {
    let mut core = NotifyCore::with_account_gating();
    let now = t0();
    let a = acc("a", 1);
    let mut other_env: AccountContext = a.clone();
    other_env.environment = Environment::named("test");
    core.set_account_notifications(&a, true, &now);
    assert!(!core.account_notifications_allowed(&other_env, &now));
    let gen2 = acc("a", 2);
    assert!(core.on_new_message(&gen2, "g", true, &now).is_empty());
    core.set_account_notifications(&a, true, &now);
    assert!(!core.account_notifications_allowed(&gen2, &now));
    core.set_account_notifications(&gen2, true, &now.plus_ms(10_000));
    assert!(core.account_notifications_allowed(&gen2, &now.plus_ms(24_999)));
    assert!(!core.account_notifications_allowed(&gen2, &now.plus_ms(25_000)));
    // A generation invalidation revokes the old lease even with no reply.
    core.apply_round_event(
        RoundEvent::Invalidated {
            round: rref(&gen2, "g", "r", 1),
        },
        &now.plus_ms(11_000),
    );
    assert!(!core.account_notifications_allowed(&gen2, &now.plus_ms(11_000)));
}

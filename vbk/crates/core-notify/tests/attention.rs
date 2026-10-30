//! L0 badge, L1 flash and L2 banner / sound throttle.

mod common;

use common::*;
use contracts::ReminderSettings;
use core_notify::{BadgeText, Effect, NotifyCore, Sound, SystemState, BANNER_STAY_MS};

#[test]
fn badge_aggregates_across_accounts_up_to_99_plus() {
    let mut core = NotifyCore::new();
    let a = acc("a", 1);
    let b = acc("b", 1);
    assert_eq!(
        core.on_unread_changed(&a, "g1", 50),
        vec![Effect::Unread {
            total: 50,
            badge: BadgeText::Count(50)
        }]
    );
    assert_eq!(
        core.on_unread_changed(&b, "g2", 49),
        vec![Effect::Unread {
            total: 99,
            badge: BadgeText::Count(99)
        }]
    );
    assert!(core.on_unread_changed(&b, "g2", 49).is_empty(), "unchanged");
    let fx = core.on_unread_changed(&a, "g3", 1);
    assert_eq!(
        fx,
        vec![Effect::Unread {
            total: 100,
            badge: BadgeText::Overflow
        }]
    );
    assert_eq!(BadgeText::Overflow.text().as_deref(), Some("99+"));
    let _ = core.on_unread_changed(&a, "g1", 0);
    let _ = core.on_unread_changed(&a, "g3", 0);
    let fx = core.on_unread_changed(&b, "g2", 0);
    assert_eq!(
        fx,
        vec![Effect::Unread {
            total: 0,
            badge: BadgeText::None
        }]
    );

    // Badge disabled → total still reported, badge cleared.
    let base = t0();
    let fx = core
        .set_settings(
            ReminderSettings {
                taskbar_badge: false,
                ..ReminderSettings::default()
            },
            &base,
        )
        .expect("valid");
    assert_eq!(
        fx,
        vec![Effect::Unread {
            total: 0,
            badge: BadgeText::None
        }]
    );
    assert_eq!(
        core.on_unread_changed(&a, "g1", 7),
        vec![Effect::Unread {
            total: 7,
            badge: BadgeText::None
        }]
    );
}

#[test]
fn l1_flashes_until_main_focus_or_zero_unread() {
    let mut core = NotifyCore::new();
    let a = acc("a", 1);
    let base = t0();
    let fx = core.on_new_message(&a, "g1", false, &base);
    assert_eq!(fx, vec![Effect::TrayFlash(true)], "non-customer message: L1 only");
    assert!(core.on_new_message(&a, "g1", false, &base).is_empty(), "already flashing");
    let fx = core.set_system_state(
        SystemState {
            main_window_focused: true,
            ..SystemState::default()
        },
        &base,
    );
    assert_eq!(fx, vec![Effect::TrayFlash(false)]);
    assert!(core.on_new_message(&a, "g1", false, &base).is_empty(), "focused: no flash");

    let _ = core.set_system_state(SystemState::default(), &base);
    let _ = core.on_unread_changed(&a, "g1", 2);
    assert_eq!(core.on_new_message(&a, "g1", false, &base), vec![Effect::TrayFlash(true)]);
    assert_eq!(
        core.on_unread_changed(&a, "g1", 0),
        vec![
            Effect::Unread {
                total: 0,
                badge: BadgeText::None
            },
            Effect::TrayFlash(false)
        ]
    );

    // tray_flash setting off → never flashes.
    let mut core = NotifyCore::new();
    core.set_settings(
        ReminderSettings {
            tray_flash: false,
            ..ReminderSettings::default()
        },
        &base,
    )
    .expect("valid");
    let fx = core.on_new_message(&a, "g1", true, &base);
    assert!(!fx.iter().any(|e| matches!(e, Effect::TrayFlash(_))));
}

#[test]
fn banners_merge_per_conversation_and_sound_is_throttled() {
    let mut core = NotifyCore::new();
    let a = acc("a", 1);
    let base = t0();
    let banner = |count: u32, gid: &str| Effect::Banner {
        account: a.clone(),
        gid: gid.into(),
        count,
        stay_ms: BANNER_STAY_MS,
    };

    let fx = core.on_new_message(&a, "g1", true, &base);
    assert_eq!(
        fx,
        vec![
            Effect::TrayFlash(true),
            banner(1, "g1"),
            Effect::PlaySound(Sound::NewMessage)
        ]
    );
    let fx = core.on_new_message(&a, "g1", true, &base.plus_ms(1_000));
    assert_eq!(fx, vec![banner(2, "g1")], "merged; sound throttled (1 s < 1.5 s)");
    let fx = core.on_new_message(&a, "g2", true, &base.plus_ms(1_500));
    assert_eq!(fx, vec![banner(1, "g2"), Effect::PlaySound(Sound::NewMessage)]);
    let fx = core.on_new_message(&a, "g1", true, &base.plus_ms(5_000));
    assert_eq!(fx, vec![banner(3, "g1"), Effect::PlaySound(Sound::NewMessage)]);
    // Stay window elapsed since the last g1 bump → count restarts.
    let _ = core.tick(&base.plus_ms(11_000));
    let fx = core.on_new_message(&a, "g1", true, &base.plus_ms(11_000));
    assert_eq!(fx, vec![banner(1, "g1"), Effect::PlaySound(Sound::NewMessage)]);
}

#[test]
fn banner_suppressed_while_viewing_that_conversation_in_focused_main() {
    let mut core = NotifyCore::new();
    let a = acc("a", 1);
    let base = t0();
    let _ = core.set_system_state(
        SystemState {
            main_window_focused: true,
            viewing_gid: Some("g1".into()),
            ..SystemState::default()
        },
        &base,
    );
    assert!(core.on_new_message(&a, "g1", true, &base).is_empty());
    let fx = core.on_new_message(&a, "g2", true, &base);
    assert!(fx.iter().any(|e| matches!(e, Effect::Banner { gid, count: 1, .. } if gid == "g2")));
    assert!(!fx.iter().any(|e| matches!(e, Effect::TrayFlash(_))), "focused: no L1");

    // Viewing g1 but main unfocused: the banner shows.
    let _ = core.set_system_state(
        SystemState {
            main_window_focused: false,
            viewing_gid: Some("g1".into()),
            ..SystemState::default()
        },
        &base,
    );
    let fx = core.on_new_message(&a, "g1", true, &base.plus_ms(10_000));
    assert!(fx.iter().any(|e| matches!(e, Effect::Banner { gid, .. } if gid == "g1")));
}

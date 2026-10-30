//! Q9 — clock: core-net `ClockService` goes stale after validity expiry or
//! a wall-clock jump → core-notify `Now.clock_trusted = false` →
//! `snapshot.clock_trusted = false` (estimate / 待核对 display, never a
//! platform countdown); a re-anchor restores trust (strong-alert §5, plan
//! §3 "ClockService / ReconcileComplete").
#![allow(clippy::unwrap_used)]

mod common;

use common::*;
use contracts::{AlarmLevel, ClockQuality, RoundEvent, WaitingRoundRef};
use core_im::first_t1_deadline;
use core_net::ClockService;
use core_notify::{NotifyCore, Now, Sound};

fn started(start_ms: i64) -> RoundEvent {
    RoundEvent::Started {
        round: WaitingRoundRef {
            account: acc(1),
            gid: GID.into(),
            round_id: format!("{GID}:c1"),
            version: 1,
        },
        start_message_id: Some("c1".into()),
        start_time_ms: Some(start_ms),
        start_confirmed: true,
        label: "gr***01".into(),
    }
}

#[test]
fn validity_expiry_degrades_snapshot_trust_and_reanchor_restores_it() {
    let mut svc = ClockService::new(60_000); // 1 min validity for the test
    let mut n = NotifyCore::new();
    // Server stamp received at wall 1_000, monotonic 0, 100 ms rtt.
    svc.anchor_from_server(T0_SERVER, 1_000, 0, 100);
    let r = svc.reading(1_000, 0);
    assert!(r.trusted());
    n.apply_clock(r);
    let now = Now::from_reading(&r);
    let mut fx = n.apply_round_event(started(T0_SERVER - 40_000), &now); // already overdue
    fx.extend(n.tick(&now));
    assert_eq!(raises(&fx), 1);
    let snap = n.snapshot(&now);
    assert!(snap.clock_trusted);
    assert_eq!(snap.entries[0].level, AlarmLevel::L3);

    // Validity expires: readings turn Stale; estimates keep advancing.
    let stale = svc.reading(1_000 + 61_000, 61_000);
    assert_eq!(stale.quality, ClockQuality::Stale);
    assert_eq!(stale.server_now_ms, T0_SERVER + 50 + 61_000);
    n.apply_clock(stale);
    let now = Now::from_reading(&stale);
    assert!(!now.clock_trusted);
    let snap = n.snapshot(&now);
    assert!(
        !snap.clock_trusted,
        "stale anchor → estimate, not a countdown"
    );
    assert_eq!(snap.entries.len(), 1, "the entry is kept while stale");
    // A round that is *created* while stale is an estimate too.
    n.apply_round_event(
        RoundEvent::Started {
            round: WaitingRoundRef {
                account: acc(1),
                gid: GID2.into(),
                round_id: format!("{GID2}:d1"),
                version: 1,
            },
            start_message_id: Some("d1".into()),
            start_time_ms: Some(stale.server_now_ms - 35_000),
            start_confirmed: true,
            label: "gr***02".into(),
        },
        &now,
    );
    assert!(n.rounds().iter().any(|r| r.estimated));

    // Re-anchor: trusted again; estimated deadlines are re-based.
    svc.anchor_from_server(T0_SERVER + 62_000, 1_000 + 62_000, 62_000, 100);
    let fresh = svc.reading(1_000 + 62_000, 62_000);
    assert!(fresh.trusted());
    n.apply_clock(fresh);
    assert!(n.rounds().iter().all(|r| !r.estimated));
    let now = Now::from_reading(&fresh);
    let snap = n.snapshot(&now);
    assert!(snap.clock_trusted);
    assert_eq!(snap.entries.len(), 2);
}

#[test]
fn wall_clock_jump_and_sleep_mark_stale_until_reanchor() {
    let mut svc = ClockService::default();
    svc.anchor_from_server(T0_SERVER, 10_000, 0, 0);
    assert!(svc.reading(10_100, 100).trusted());
    // Sleep: wall advanced 10 min, monotonic 1 s.
    let r = svc.reading(10_100 + 600_000, 1_100);
    assert_eq!(r.quality, ClockQuality::Stale);
    // Sticky, and the estimate still follows the monotonic clock only.
    let r2 = svc.reading(10_100 + 600_000 + 1_000, 2_100);
    assert_eq!(r2.quality, ClockQuality::Stale);
    assert_eq!(r2.server_now_ms - r.server_now_ms, 1_000);
    let mut n = NotifyCore::new();
    n.apply_clock(r2);
    assert!(!n.snapshot(&Now::from_reading(&r2)).clock_trusted);
    // Backwards wall jump is a jump too.
    let mut s2 = ClockService::default();
    s2.anchor_from_server(T0_SERVER, 10_000, 0, 0);
    assert_eq!(s2.reading(10_000 - 5_000, 100).quality, ClockQuality::Stale);
    // mark_stale (network / time source change reported by the host).
    svc.anchor_from_server(T0_SERVER + 700_000, 710_000, 3_000, 0);
    assert!(svc.reading(710_001, 3_001).trusted());
    svc.mark_stale();
    assert_eq!(svc.reading(710_002, 3_002).quality, ClockQuality::Stale);
}

#[test]
fn unanchored_clock_never_yields_a_trusted_deadline_in_im_or_notify() {
    let mut svc = ClockService::default();
    let r = svc.reading(1_000, 0);
    assert_eq!(r.quality, ClockQuality::Unanchored);
    let round = core_im::Round {
        round_id: format!("{GID}:c1"),
        version: 1,
        start_message_id: Some("c1".into()),
        start_time_ms: Some(0),
        start_confirmed: true,
    };
    let d = first_t1_deadline(&round, 30, &r);
    assert!(!d.trusted);
    assert!(
        d.due_at_monotonic_ms.is_some(),
        "an estimate is still scheduled"
    );
    let mut n = NotifyCore::new();
    n.apply_clock(r);
    let now = Now::from_reading(&r);
    let mut fx = n.apply_round_event(started(-40_000), &now);
    fx.extend(n.tick(&now));
    // Estimates still remind (a missing anchor must not silence reminders)
    // but the snapshot says so.
    assert_eq!(raises(&fx), 1);
    assert_eq!(sounds(&fx, Sound::Timeout), 1);
    let snap = n.snapshot(&now);
    assert!(!snap.clock_trusted);
    assert_eq!(snap.entries[0].level, AlarmLevel::L3);
}

#[test]
fn deadline_is_projected_on_the_monotonic_axis_not_the_wall_clock() {
    // A wall-clock jump after anchoring must not move the T1 deadline.
    let mut svc = ClockService::default();
    svc.anchor_from_server(T0_SERVER, 10_000, 0, 0);
    let r0 = svc.reading(10_000, 0);
    let mut n = NotifyCore::new();
    n.apply_clock(r0);
    n.apply_round_event(started(T0_SERVER - 20_000), &Now::from_reading(&r0)); // 10 s to go
                                                                               // Wall jumps +1 h, monotonic +5 s: still 5 s to go on the monotonic axis.
    let r1 = svc.reading(10_000 + 3_600_000, 5_000);
    assert_eq!(r1.quality, ClockQuality::Stale);
    let fx = n.tick(&Now::from_reading(&r1));
    assert_eq!(raises(&fx), 0, "not due yet on the monotonic axis");
    let r2 = svc.reading(10_000 + 3_600_000 + 5_000, 10_000);
    let fx = n.tick(&Now::from_reading(&r2));
    assert_eq!(raises(&fx), 1);
    assert!(!n.snapshot(&Now::from_reading(&r2)).clock_trusted);
}

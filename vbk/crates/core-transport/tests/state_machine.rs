//! Scenario tests for the supervisor edges (class A: no X11 / real machine needed).

use core_transport::{
    Action, BackoffPolicy, CircuitCounters, CompensationPlan, CountersError, Event, Level, Phase,
    RejectReason, SdkStatus, SendGate, Supervisor, TerminalReason, TransportConfig, ZeroRng,
};

fn cfg() -> TransportConfig {
    TransportConfig {
        backoff: BackoffPolicy {
            base_ms: 5_000,
            cap_ms: 40_000,
            jitter_permille: 0,
        },
        attempts_per_level: 2,
        breaker_threshold: 8,
        ..TransportConfig::default()
    }
}

fn online(now: u64) -> Supervisor<ZeroRng> {
    let mut s = Supervisor::new(cfg(), CircuitCounters::default(), ZeroRng, now).expect("config");
    s.handle(now, Event::SdkStatus(SdkStatus::Connected));
    s
}

fn attempts(actions: &[Action]) -> Vec<(Level, u32, u64)> {
    actions
        .iter()
        .filter_map(|a| match a {
            Action::Attempt {
                level,
                failures_before,
                backoff_ms,
            } => Some((*level, *failures_before, *backoff_ms)),
            _ => None,
        })
        .collect()
}

fn plan_of(actions: &[Action]) -> Option<CompensationPlan> {
    actions.iter().find_map(|a| {
        if let Action::Compensate(p) = a {
            Some(*p)
        } else {
            None
        }
    })
}

#[test]
fn heartbeat_timeout_is_20s_when_connected() {
    let mut s = online(1_000);
    assert!(s.handle(20_999, Event::Tick).is_empty());
    let acts = s.handle(21_000, Event::Tick);
    assert_eq!(attempts(&acts), vec![(Level::InPageCompensation, 0, 0)]);
    assert!(matches!(s.phase(), Phase::Awaiting { .. }));
}

#[test]
fn unconnected_sdk_gets_60s_before_escalation() {
    let mut s = online(0);
    s.handle(1_000, Event::SdkStatus(SdkStatus::Disconnected));
    assert!(s.handle(60_999, Event::Tick).is_empty());
    assert_eq!(attempts(&s.handle(61_000, Event::Tick)).len(), 1);
}

#[test]
fn ladder_escalates_in_page_then_reload_then_rebuild_with_growing_backoff() {
    let mut s = online(0);
    let mut now = 20_000;
    let mut seen = Vec::new();
    for _ in 0..6 {
        let acts = s.handle(now, Event::Tick);
        let a = attempts(&acts);
        assert_eq!(a.len(), 1, "one attempt per wake-up at {now}: {acts:?}");
        seen.push(a[0]);
        // Reload/rebuild levels: run them through to the verify timeout.
        if matches!(s.phase(), Phase::Draining { .. }) {
            s.handle(now, Event::JournalDrained);
            assert!(matches!(s.phase(), Phase::Rebuilding { .. }));
            s.handle(now, Event::PageReady);
        }
        now = s.next_wakeup_ms().expect("deadline");
        s.handle(now, Event::Tick); // verify deadline passes -> fail -> Backoff
        now = s.next_wakeup_ms().expect("backoff");
    }
    let levels: Vec<Level> = seen.iter().map(|x| x.0).collect();
    assert_eq!(
        levels,
        vec![
            Level::InPageCompensation,
            Level::InPageCompensation,
            Level::ReloadPage,
            Level::ReloadPage,
            Level::RebuildWebview,
            Level::RebuildWebview
        ]
    );
    let backoffs: Vec<u64> = seen.iter().map(|x| x.2).collect();
    assert_eq!(
        backoffs,
        vec![0, 5_000, 10_000, 20_000, 40_000, 40_000],
        "doubling, capped, never decreasing"
    );
}

#[test]
fn draining_rebuilding_compensating_online_every_edge() {
    let c = TransportConfig {
        attempts_per_level: 1,
        ..cfg()
    };
    let mut s = Supervisor::new(
        c,
        CircuitCounters {
            failures: 1,
            last_delay_ms: 0,
            trips: 0,
            tripped: false,
        },
        ZeroRng,
        0,
    )
    .expect("config");
    // failures>0 at construction -> Backoff(0), first tick starts the attempt at ReloadPage level.
    let acts = s.handle(0, Event::Tick);
    assert_eq!(attempts(&acts)[0].0, Level::ReloadPage);
    assert!(acts.contains(&Action::BeginDrain));
    assert!(matches!(s.phase(), Phase::Draining { .. }));
    assert_eq!(
        s.send_gate(),
        SendGate::Reject(RejectReason::ChannelRecovering)
    );
    assert_eq!(
        RejectReason::ChannelRecovering.code(),
        "im.channel_recovering"
    );

    // draining -> rebuilding
    let acts = s.handle(2_000, Event::JournalDrained);
    assert_eq!(acts, vec![Action::ReloadPage]);
    assert!(matches!(s.phase(), Phase::Rebuilding { .. }));
    assert_eq!(
        s.send_gate(),
        SendGate::Reject(RejectReason::ChannelRecovering)
    );

    // rebuilding -> compensating
    let acts = s.handle(5_000, Event::PageReady);
    assert!(plan_of(&acts).is_some());
    assert!(matches!(s.phase(), Phase::Compensating { .. }));
    assert_eq!(
        s.send_gate(),
        SendGate::Reject(RejectReason::ChannelRecovering)
    );

    // compensating -> online
    s.handle(6_000, Event::Alive);
    assert_eq!(s.phase(), Phase::Online);
    assert_eq!(s.send_gate(), SendGate::Open);
}

#[test]
fn drain_timeout_marks_inflight_unknown_and_never_replays() {
    let c = TransportConfig {
        attempts_per_level: 1,
        ..cfg()
    };
    let mut s = Supervisor::new(
        c,
        CircuitCounters {
            failures: 2,
            last_delay_ms: 0,
            trips: 0,
            tripped: false,
        },
        ZeroRng,
        0,
    )
    .expect("config");
    let acts = s.handle(0, Event::Tick);
    assert_eq!(attempts(&acts)[0].0, Level::RebuildWebview);
    let acts = s.handle(10_000, Event::Tick);
    assert_eq!(
        acts,
        vec![Action::AbortInflightAsUnknown, Action::RebuildWebview]
    );
    // No action anywhere replays outbound work: the vocabulary has none.
}

#[test]
fn alive_during_drain_cancels_it_and_reopens_sends() {
    let c = TransportConfig {
        attempts_per_level: 1,
        ..cfg()
    };
    let mut s = Supervisor::new(
        c,
        CircuitCounters {
            failures: 1,
            last_delay_ms: 0,
            trips: 0,
            tripped: false,
        },
        ZeroRng,
        0,
    )
    .expect("config");
    s.handle(0, Event::Tick);
    assert!(matches!(s.phase(), Phase::Draining { .. }));
    assert_eq!(s.handle(1_000, Event::Alive), vec![Action::CancelDrain]);
    assert_eq!(s.send_gate(), SendGate::Open);
}

#[test]
fn compensation_starts_two_minutes_back_at_5s_cadence_with_full_list() {
    let mut s = online(0);
    s.handle(1_000_000, Event::SdkStatus(SdkStatus::Disconnected));
    let acts = s.handle(1_500_000, Event::SdkStatus(SdkStatus::Connected));
    let p = plan_of(&acts).expect("reconnect compensates");
    assert_eq!(p.begin_msg_time_ms, 1_500_000 - 120_000);
    assert_eq!(p.interval_ms, 5_000);
    assert!(p.reset_conversation_list_cursor);
    assert_eq!(s.compensation_interval_ms(1_500_001), 5_000);
    assert_eq!(
        s.compensation_interval_ms(1_500_000 + 60_000),
        10_000,
        "after the fast window the normal 10 s cadence returns"
    );
}

#[test]
fn watermark_older_than_two_minutes_wins_so_long_outages_lose_nothing() {
    let mut s = online(0);
    s.set_watermark(Some(1_000_000));
    s.handle(2_000_000, Event::SdkStatus(SdkStatus::Disconnected));
    let acts = s.handle(2_100_000, Event::SdkStatus(SdkStatus::Connected));
    assert_eq!(plan_of(&acts).expect("plan").begin_msg_time_ms, 1_000_000);
}

#[test]
fn wake_and_network_restore_compensate_and_do_not_read_the_gap_as_timeout() {
    let mut s = online(0);
    let acts = s.handle(3_600_000, Event::Resumed);
    assert_eq!(
        plan_of(&acts).expect("plan").begin_msg_time_ms,
        3_600_000 - 120_000
    );
    assert!(s.handle(3_600_001, Event::Tick).is_empty());

    s.handle(3_700_000, Event::Network { online: false });
    s.handle(3_800_000, Event::Network { online: true });
    assert!(s.handle(3_800_001, Event::Tick).is_empty());
}

#[test]
fn offline_freezes_counters_timers_and_actions() {
    let mut s = online(0);
    s.handle(25_000, Event::Tick); // attempt 1 outstanding (failures still 0)
    let before = s.counters();
    s.handle(26_000, Event::Network { online: false });
    assert!(s.frozen());
    for t in (30_000..10_000_000).step_by(37_000) {
        assert!(s.handle(t, Event::Tick).is_empty());
    }
    assert_eq!(s.counters(), before, "no failure was counted while offline");
    assert_eq!(s.next_wakeup_ms(), None);
    s.handle(10_000_000, Event::Network { online: true });
    assert!(!s.frozen());
    // The outstanding deadline moved by the offline duration instead of firing at once.
    assert!(s.handle(10_000_001, Event::Tick).is_empty());
    assert_eq!(s.counters(), before);
}

#[test]
fn terminal_reasons_do_not_count_and_never_reconnect() {
    for reason in TerminalReason::ALL {
        let mut s = online(0);
        s.handle(25_000, Event::Tick);
        s.handle(46_000, Event::Tick); // one real failure so we can tell "unchanged" from "zero"
        let before = s.counters();
        assert_eq!(before.failures, 1);
        let acts = s.handle(50_000, Event::Terminal(reason));
        assert_eq!(acts, vec![Action::NotifyTerminal(reason)]);
        assert_eq!(s.phase(), Phase::Terminal(reason));
        for t in (60_000..5_000_000).step_by(11_000) {
            for ev in [
                Event::Tick,
                Event::SdkStatus(SdkStatus::Disconnected),
                Event::Resumed,
                Event::Alive,
                Event::JournalDrained,
                Event::PageReady,
                Event::ManualRetry,
            ] {
                assert!(s.handle(t, ev).is_empty(), "{reason:?} {ev:?}");
            }
        }
        assert_eq!(s.counters(), before);
        assert_eq!(s.next_wakeup_ms(), None);
        assert!(matches!(
            s.send_gate(),
            SendGate::Reject(RejectReason::Terminal(_))
        ));
    }
}

#[test]
fn terminal_signal_names_are_exact() {
    assert_eq!(
        TerminalReason::from_signal("KICKED_OFFLINE_BY_OTHER_CLIENT"),
        Some(TerminalReason::KickedOfflineByOtherClient)
    );
    assert_eq!(
        TerminalReason::from_signal("Replaced by new connection"),
        Some(TerminalReason::KickedOfflineByOtherClient)
    );
    assert_eq!(
        TerminalReason::from_signal("XMPP_AUTH_FAILED"),
        Some(TerminalReason::XmppAuthFailed)
    );
    assert_eq!(
        TerminalReason::from_signal("CURRENT_TOKEN_UNAVAILABLE"),
        Some(TerminalReason::CurrentTokenUnavailable)
    );
    assert_eq!(
        TerminalReason::from_signal("AccountsMobileRequestFilterException"),
        Some(TerminalReason::AccountsMobileRequestFilterException)
    );
    assert_eq!(TerminalReason::from_signal("xmpp_auth_failed"), None);
    assert_eq!(TerminalReason::from_signal(""), None);
    for r in TerminalReason::ALL {
        assert_eq!(TerminalReason::from_signal(r.as_str()), Some(r));
    }
}

#[test]
fn account_rebound_leaves_terminal_state() {
    let mut s = online(0);
    s.handle(1, Event::Terminal(TerminalReason::XmppAuthFailed));
    assert!(s.handle(2, Event::AccountRebound).is_empty());
    assert_eq!(s.phase(), Phase::Online);
    assert_eq!(s.send_gate(), SendGate::Open);
}

#[test]
fn breaker_opens_then_manual_retry_restarts_and_counters_survive_instances() {
    let mut s = online(0);
    let mut now = 20_000;
    let mut guard = 0;
    while !matches!(s.phase(), Phase::Tripped) {
        guard += 1;
        assert!(guard < 200, "breaker must open");
        let acts = s.handle(now, Event::Tick);
        if acts.contains(&Action::BeginDrain) {
            s.handle(now, Event::JournalDrained);
            s.handle(now, Event::PageReady);
        }
        now = s.next_wakeup_ms().unwrap_or(now + 1);
    }
    let c = s.counters();
    assert!(c.tripped);
    assert_eq!(c.trips, 1);
    assert_eq!(c.failures, 8);
    assert_eq!(
        s.send_gate(),
        SendGate::Reject(RejectReason::ChannelAbnormal)
    );
    assert_eq!(s.next_wakeup_ms(), None);
    assert!(
        s.handle(now + 1_000_000, Event::Tick).is_empty(),
        "open breaker: no automatic attempts"
    );

    // New instance restored from the persisted line stays open: no clean slate.
    let restored = CircuitCounters::decode(&c.encode()).expect("roundtrip");
    assert_eq!(restored, c);
    let mut s2 = Supervisor::new(cfg(), restored, ZeroRng, now).expect("config");
    assert_eq!(s2.phase(), Phase::Tripped);
    assert!(s2.handle(now + 1, Event::Tick).is_empty());

    let acts = s2.handle(now + 10, Event::ManualRetry);
    assert_eq!(acts[0], Action::ClearChannelAbnormal);
    assert_eq!(attempts(&acts), vec![(Level::InPageCompensation, 0, 0)]);
    assert_eq!(s2.counters().trips, 1, "trip history is never erased");
}

#[test]
fn new_instance_keeps_the_backoff_streak() {
    let counters = CircuitCounters {
        failures: 3,
        last_delay_ms: 20_000,
        trips: 0,
        tripped: false,
    };
    let mut s = Supervisor::new(cfg(), counters, ZeroRng, 1_000).expect("config");
    assert_eq!(s.phase(), Phase::Backoff { until_ms: 21_000 });
    assert!(s.handle(20_999, Event::Tick).is_empty());
    let a = attempts(&s.handle(21_000, Event::Tick));
    assert_eq!(a, vec![(Level::ReloadPage, 3, 20_000)]);
}

#[test]
fn flapping_alive_does_not_reset_the_streak_but_a_stable_period_does() {
    let mut s = online(0);
    s.handle(20_000, Event::Tick); // attempt 1
    s.handle(40_000, Event::Tick); // verify deadline -> failure 1
    assert_eq!(s.counters().failures, 1);
    s.handle(41_000, Event::Alive); // flap back
    assert_eq!(s.phase(), Phase::Online);
    assert_eq!(s.counters().failures, 1, "one pong is not stability");
    s.handle(41_000 + 59_999, Event::Alive);
    s.handle(41_000 + 59_999, Event::Tick);
    assert_eq!(s.counters().failures, 1);
    s.handle(41_000 + 60_000, Event::Alive);
    s.handle(41_000 + 60_000, Event::Tick);
    assert_eq!(
        s.counters(),
        CircuitCounters {
            failures: 0,
            last_delay_ms: 0,
            trips: 0,
            tripped: false
        }
    );
}

#[test]
fn counters_codec_is_strict() {
    let c = CircuitCounters {
        failures: 4,
        last_delay_ms: 40_000,
        trips: 2,
        tripped: true,
    };
    assert_eq!(
        c.encode(),
        "v1;failures=4;last_delay_ms=40000;trips=2;tripped=1"
    );
    assert_eq!(CircuitCounters::decode(&c.encode()), Ok(c));
    assert_eq!(
        CircuitCounters::decode("v2;failures=0"),
        Err(CountersError::Version)
    );
    assert!(
        CircuitCounters::decode("v1;failures=1;failures=2;last_delay_ms=0;trips=0;tripped=0")
            .is_err()
    );
    assert!(CircuitCounters::decode("v1;failures=1;last_delay_ms=0;trips=0").is_err());
    assert!(CircuitCounters::decode("v1;failures=x;last_delay_ms=0;trips=0;tripped=0").is_err());
    assert!(CircuitCounters::decode("v1;failures=1;last_delay_ms=0;trips=0;tripped=2").is_err());
    assert!(
        CircuitCounters::decode("v1;failures=1;last_delay_ms=0;trips=0;tripped=0;extra=1").is_err()
    );
}

#[test]
fn invalid_config_is_rejected() {
    let mut c = cfg();
    c.backoff.cap_ms = 1;
    assert!(Supervisor::new(c, CircuitCounters::default(), ZeroRng, 0).is_err());
    let c = TransportConfig {
        attempts_per_level: 0,
        ..cfg()
    };
    assert!(c.validate().is_err());
}

// ------------------------------------------------------------------ adversarial review additions

#[test]
fn coarse_ticks_cannot_erase_the_streak_through_the_stable_window() {
    // failure 1 at 40 s, one flapping pong at 41 s, then silence. A host that
    // ticks once a minute lands exactly on the stable-online boundary: the
    // streak must not be declared "over" by 60 s of silence.
    let mut s = online(0);
    s.handle(20_000, Event::Tick);
    s.handle(40_000, Event::Tick);
    assert_eq!(s.counters().failures, 1);
    s.handle(41_000, Event::Alive);
    assert_eq!(s.phase(), Phase::Online);
    let acts = s.handle(101_000, Event::Tick);
    assert_eq!(
        s.counters().failures,
        1,
        "silence is not stability: {acts:?}"
    );
    for a in &acts {
        if let Action::Attempt {
            failures_before, ..
        } = a
        {
            assert_eq!(*failures_before, 1, "{acts:?}");
        }
    }
}

#[test]
fn resume_during_an_outstanding_attempt_re_arms_the_verify_window_instead_of_failing() {
    let mut s = online(0);
    s.handle(20_000, Event::Tick); // attempt outstanding, verify deadline 40 s
    assert!(matches!(s.phase(), Phase::Awaiting { .. }));
    let acts = s.handle(3_600_000, Event::Resumed);
    assert!(plan_of(&acts).is_some(), "wake compensates");
    assert!(s.handle(3_600_001, Event::Tick).is_empty());
    assert_eq!(
        s.counters().failures,
        0,
        "the sleep gap is not a failed attempt"
    );
    assert!(matches!(s.phase(), Phase::Awaiting { .. }));
    // ... and the re-armed window still expires normally.
    s.handle(3_600_000 + 20_000, Event::Tick);
    assert_eq!(s.counters().failures, 1);

    // Same for the post-rebuild compensation window.
    let c = TransportConfig {
        attempts_per_level: 1,
        ..cfg()
    };
    let mut s = Supervisor::new(
        c,
        CircuitCounters {
            failures: 1,
            last_delay_ms: 0,
            trips: 0,
            tripped: false,
        },
        ZeroRng,
        0,
    )
    .expect("config");
    s.handle(0, Event::Tick);
    s.handle(1, Event::JournalDrained);
    s.handle(2, Event::PageReady);
    assert!(matches!(s.phase(), Phase::Compensating { .. }));
    s.handle(1_000_000, Event::Resumed);
    assert!(s.handle(1_000_001, Event::Tick).is_empty());
    assert_eq!(s.counters().failures, 1);
}

#[test]
fn offline_state_survives_terminal_and_rebound() {
    let mut s = online(0);
    s.handle(1_000, Event::Network { online: false });
    s.handle(2_000, Event::Terminal(TerminalReason::XmppAuthFailed));
    // Still offline when the account is re-logged: no timers may run.
    s.handle(3_000, Event::AccountRebound);
    assert!(
        s.frozen(),
        "rebound must not forget that the network is down"
    );
    assert_eq!(s.next_wakeup_ms(), None);
    assert!(s.handle(500_000, Event::Tick).is_empty());
    assert_eq!(s.counters().failures, 0);
    // Network events during the terminal state are tracked too.
    let mut s = online(0);
    s.handle(
        1_000,
        Event::Terminal(TerminalReason::CurrentTokenUnavailable),
    );
    s.handle(2_000, Event::Network { online: false });
    s.handle(3_000, Event::AccountRebound);
    assert!(s.frozen());
    let mut s = online(0);
    s.handle(1_000, Event::Network { online: false });
    s.handle(
        2_000,
        Event::Terminal(TerminalReason::CurrentTokenUnavailable),
    );
    s.handle(2_500, Event::Network { online: true });
    s.handle(3_000, Event::AccountRebound);
    assert!(!s.frozen());
}

#[test]
fn backoff_at_the_cap_has_no_jitter_left_which_is_a_known_design_limit() {
    // Documented, not fixed: once the un-jittered delay reaches the cap the
    // monotonic floor leaves no room for jitter, so every later wait is exactly `cap`.
    let p = BackoffPolicy {
        base_ms: 5_000,
        cap_ms: 40_000,
        jitter_permille: 1_000,
    };
    let mut r = core_transport::SplitMix64::new(7);
    let mut last = 0;
    for f in 1..12 {
        last = p.next_delay(f, last, &mut r);
    }
    assert_eq!(last, 40_000);
    assert_eq!(p.next_delay(12, last, &mut r), 40_000);
}

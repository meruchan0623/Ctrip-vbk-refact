//! Property tests (I-05b acceptance 5, class A, no X11 needed).
//!
//! No proptest crate is available offline, so sequences come from a seeded
//! SplitMix64: thousands of random fault/time sequences per property, fully
//! reproducible from the printed seed.

use core_transport::{
    Action, BackoffPolicy, CircuitCounters, Event, Phase, RejectReason, Rng, SdkStatus, SendGate,
    SplitMix64, Supervisor, TerminalReason, TransportConfig,
};

const SEQUENCES: u64 = 3_000;
const STEPS: usize = 220;

fn config(seed: u64) -> TransportConfig {
    let mut r = SplitMix64::new(seed ^ 0x00C0_FFEE);
    let base = 1_000 + r.next_u64() % 9_000;
    let backoff = BackoffPolicy {
        base_ms: base,
        cap_ms: base * (2 + r.next_u64() % 40),
        jitter_permille: r.next_u64() % 1_001,
    };
    let attempts_per_level = 1 + (r.next_u64() % 3) as u32;
    let breaker_threshold = 3 * attempts_per_level + (r.next_u64() % 8) as u32;
    TransportConfig {
        backoff,
        attempts_per_level,
        breaker_threshold,
        ..TransportConfig::default()
    }
}

fn random_event(r: &mut SplitMix64) -> Event {
    match r.next_u64() % 100 {
        0..=39 => Event::Tick,
        40..=54 => Event::Alive,
        55..=64 => Event::SdkStatus(
            [
                SdkStatus::Connecting,
                SdkStatus::Connected,
                SdkStatus::Disconnected,
                SdkStatus::Reconnecting,
            ][(r.next_u64() % 4) as usize],
        ),
        65..=72 => Event::Network {
            online: r.next_u64() % 2 == 0,
        },
        73..=74 => Event::Resumed,
        75..=80 => Event::JournalDrained,
        81..=86 => Event::PageReady,
        87..=89 => Event::ManualRetry,
        90 => Event::Terminal(TerminalReason::ALL[(r.next_u64() % 4) as usize]),
        _ => Event::AccountRebound,
    }
}

#[derive(Default)]
struct Streak {
    prev_backoff: u64,
    prev_failures: u32,
    prev_at: u64,
    open: bool,
}

#[test]
fn any_fault_sequence_keeps_intervals_monotonic_bounded_and_counters_sane() {
    for seed in 0..SEQUENCES {
        let cfg = config(seed);
        let cap = cfg.backoff.cap_ms;
        let mut gen = SplitMix64::new(seed);
        let mut now = 1_000_000u64;
        let mut sup = Supervisor::new(
            cfg,
            CircuitCounters::default(),
            SplitMix64::new(seed ^ 0xABCD),
            now,
        )
        .expect("config");
        let mut streak = Streak::default();
        let mut terminal_counters: Option<CircuitCounters> = None;

        for step in 0..STEPS {
            // time: half the steps jump exactly to the next wake-up (the realistic driver), the rest are arbitrary
            now += match (gen.next_u64() % 2, sup.next_wakeup_ms()) {
                (0, Some(w)) if w > now => w - now,
                _ => gen.next_u64() % 45_000,
            };
            let ev = random_event(&mut gen);
            let was_frozen = sup.frozen();
            let was_terminal = matches!(sup.phase(), Phase::Terminal(_));
            let before = sup.counters();
            let acts = sup.handle(now, ev);
            let ctx = format!("seed={seed} step={step} ev={ev:?} acts={acts:?}");

            // --- terminal: counters frozen at entry, zero actions until rebound
            if was_terminal && ev != Event::AccountRebound {
                assert!(acts.is_empty(), "terminal emitted actions: {ctx}");
                assert_eq!(sup.counters(), before, "terminal changed counters: {ctx}");
            }
            if let Phase::Terminal(r) = sup.phase() {
                if !was_terminal {
                    assert_eq!(acts, vec![Action::NotifyTerminal(r)], "{ctx}");
                    assert_eq!(
                        sup.counters(),
                        before,
                        "entering terminal must not count: {ctx}"
                    );
                    terminal_counters = Some(before);
                }
                assert_eq!(Some(sup.counters()), terminal_counters, "{ctx}");
                assert!(
                    matches!(sup.send_gate(), SendGate::Reject(RejectReason::Terminal(_))),
                    "{ctx}"
                );
            } else {
                terminal_counters = None;
            }

            // --- offline freeze: only Terminal / Network can act, counters unchanged
            if was_frozen
                && !was_terminal
                && !matches!(ev, Event::Network { online: true } | Event::Terminal(_))
            {
                assert!(acts.is_empty(), "frozen emitted actions: {ctx}");
                assert_eq!(sup.counters(), before, "frozen counted: {ctx}");
            }

            // --- attempts: level is a function of the counter; delays monotonic within a streak, bounded by cap
            for a in &acts {
                if let Action::Attempt {
                    level,
                    failures_before,
                    backoff_ms,
                } = *a
                {
                    assert_eq!(level, sup.level_for(failures_before), "{ctx}");
                    assert!(backoff_ms <= cap, "backoff above cap: {ctx}");
                    assert!(!was_terminal, "attempt from terminal: {ctx}");
                    if failures_before == 0 {
                        assert_eq!(backoff_ms, 0, "{ctx}");
                        streak = Streak {
                            open: true,
                            prev_at: now,
                            ..Streak::default()
                        };
                    } else if streak.open {
                        assert!(
                            backoff_ms >= streak.prev_backoff,
                            "interval decreased {} -> {backoff_ms}: {ctx}",
                            streak.prev_backoff
                        );
                        assert!(
                            failures_before >= streak.prev_failures,
                            "failure counter went backwards: {ctx}"
                        );
                        assert!(
                            now - streak.prev_at >= backoff_ms,
                            "attempted before backoff elapsed: {ctx}"
                        );
                        streak.prev_backoff = backoff_ms;
                        streak.prev_failures = failures_before;
                        streak.prev_at = now;
                    } else {
                        // streak began in a previous instance/before tracking: adopt it
                        streak = Streak {
                            prev_backoff: backoff_ms,
                            prev_failures: failures_before,
                            prev_at: now,
                            open: true,
                        };
                    }
                }
            }
            // manual retry / stable period reset the streak
            if sup.counters().failures == 0 {
                streak.open = false;
            }

            // --- counter sanity
            let c = sup.counters();
            assert!(c.failures <= cfg.breaker_threshold, "{ctx}");
            assert!(c.last_delay_ms <= cap, "{ctx}");
            assert_eq!(
                matches!(sup.phase(), Phase::Tripped),
                c.tripped && !matches!(sup.phase(), Phase::Terminal(_)),
                "{ctx}"
            );
            if matches!(sup.phase(), Phase::Draining { .. }) {
                assert_eq!(
                    sup.send_gate(),
                    SendGate::Reject(RejectReason::ChannelRecovering),
                    "sends must be rejected while draining: {ctx}"
                );
            }
            assert_eq!(CircuitCounters::decode(&c.encode()), Ok(c), "{ctx}");

            // --- instance replacement keeps the counters and the streak
            if gen.next_u64() % 25 == 0 && !matches!(sup.phase(), Phase::Terminal(_)) {
                let restored =
                    CircuitCounters::decode(&sup.counters().encode()).expect("roundtrip");
                sup = Supervisor::new(cfg, restored, SplitMix64::new(gen.next_u64()), now)
                    .expect("config");
                assert_eq!(sup.counters(), restored, "seed={seed} step={step}");
                if restored.tripped {
                    assert_eq!(sup.phase(), Phase::Tripped);
                }
                streak.prev_at = now; // the new instance starts its own clock; the backoff floor is preserved
            }
        }
    }
}

#[test]
fn backoff_is_monotone_bounded_and_deterministic_for_any_jitter_draws() {
    for seed in 0..SEQUENCES {
        let cfg = config(seed);
        let mut r1 = SplitMix64::new(seed);
        let mut r2 = SplitMix64::new(seed);
        let mut last = 0u64;
        let mut last2 = 0u64;
        let mut prev = 0u64;
        for failures in 1..80u32 {
            let d = cfg.backoff.next_delay(failures, last, &mut r1);
            let d2 = cfg.backoff.next_delay(failures, last2, &mut r2);
            assert_eq!(d, d2, "same seed, same sequence");
            assert!(d >= prev, "seed={seed} failures={failures}: {d} < {prev}");
            assert!(d <= cfg.backoff.cap_ms, "seed={seed} failures={failures}");
            assert!(
                d >= cfg.backoff.base_ms.min(cfg.backoff.cap_ms),
                "never below base"
            );
            prev = d;
            last = d;
            last2 = d2;
        }
        assert_eq!(prev, cfg.backoff.cap_ms, "the sequence reaches the cap");
    }
}

#[test]
fn terminal_means_zero_attempts_for_arbitrarily_long_silence() {
    for reason in TerminalReason::ALL {
        for seed in 0..50u64 {
            let cfg = config(seed);
            let mut gen = SplitMix64::new(seed);
            let mut sup =
                Supervisor::new(cfg, CircuitCounters::default(), SplitMix64::new(seed), 0)
                    .expect("config");
            let mut now = 0u64;
            for _ in 0..(gen.next_u64() % 40) {
                now += gen.next_u64() % 40_000;
                sup.handle(now, random_event_no_terminal(&mut gen));
            }
            let c = sup.counters();
            sup.handle(now, Event::Terminal(reason));
            let mut attempts = 0usize;
            for _ in 0..2_000 {
                now += gen.next_u64() % 600_000;
                let ev = loop {
                    let e = random_event(&mut gen);
                    if e != Event::AccountRebound {
                        break e;
                    }
                };
                attempts += sup
                    .handle(now, ev)
                    .iter()
                    .filter(|a| {
                        matches!(
                            a,
                            Action::Attempt { .. }
                                | Action::ReloadPage
                                | Action::RebuildWebview
                                | Action::Compensate(_)
                        )
                    })
                    .count();
            }
            assert_eq!(attempts, 0);
            assert_eq!(sup.counters(), c, "terminal never touches the breaker");
        }
    }
}

fn random_event_no_terminal(r: &mut SplitMix64) -> Event {
    loop {
        let e = random_event(r);
        if !matches!(e, Event::Terminal(_)) {
            return e;
        }
    }
}

// ------------------------------------------------------------------ adversarial generators

/// Mode-biased sequences: long offline stretches, terminal/offline interleaving,
/// zero and huge time jumps, ticks exactly on the wake-up, bursts of one event kind.
fn hostile_event(r: &mut SplitMix64, mode: u64) -> Event {
    match mode {
        0 => random_event(r),
        1 => match r.next_u64() % 10 {
            // offline-heavy: mostly ticks/alive while frozen, rare restore
            0 => Event::Network { online: true },
            1..=2 => Event::Network { online: false },
            3..=6 => Event::Tick,
            7 => Event::Alive,
            8 => Event::Terminal(TerminalReason::ALL[(r.next_u64() % 4) as usize]),
            _ => Event::AccountRebound,
        },
        2 => match r.next_u64() % 8 {
            // terminal-heavy: terminal, rebound and network flips interleaved
            0..=1 => Event::Terminal(TerminalReason::ALL[(r.next_u64() % 4) as usize]),
            2..=3 => Event::AccountRebound,
            4 => Event::Network {
                online: r.next_u64() % 2 == 0,
            },
            5 => Event::ManualRetry,
            _ => Event::Tick,
        },
        _ => match r.next_u64() % 6 {
            // drain/rebuild-heavy
            0 => Event::JournalDrained,
            1 => Event::PageReady,
            2 => Event::Resumed,
            3 => Event::SdkStatus(SdkStatus::Connected),
            _ => Event::Tick,
        },
    }
}

fn hostile_config(seed: u64) -> TransportConfig {
    let mut r = SplitMix64::new(seed ^ 0xBAD_F00D);
    let mut c = config(seed);
    match r.next_u64() % 4 {
        0 => {
            // extreme values: overflow hunting
            c.backoff.base_ms = 1 + r.next_u64() % 3;
            c.backoff.cap_ms = u64::MAX - r.next_u64() % 1000;
            c.backoff.jitter_permille = 1000;
            c.attempts_per_level = 1;
            c.breaker_threshold = 3 + (r.next_u64() % 60) as u32;
        }
        1 => {
            c.heartbeat_timeout_ms = 1 + r.next_u64() % 50;
            c.unconnected_timeout_ms = 1 + r.next_u64() % 50;
            c.attempt_verify_ms = 1 + r.next_u64() % 50;
            c.drain_timeout_ms = 1 + r.next_u64() % 50;
            c.rebuild_timeout_ms = 1 + r.next_u64() % 50;
            c.stable_online_ms = 1 + r.next_u64() % 50;
        }
        2 => {
            c.stable_online_ms = u64::MAX;
            c.compensation_lookback_ms = u64::MAX;
        }
        _ => {}
    }
    c
}

fn deadline_of(p: Phase) -> Option<u64> {
    match p {
        Phase::Awaiting { deadline_ms }
        | Phase::Draining { deadline_ms, .. }
        | Phase::Rebuilding { deadline_ms, .. }
        | Phase::Compensating { deadline_ms } => Some(deadline_ms),
        Phase::Backoff { until_ms } => Some(until_ms),
        Phase::Online | Phase::Tripped | Phase::Terminal(_) => None,
    }
}

fn is_recovery(a: &Action) -> bool {
    matches!(
        a,
        Action::Attempt { .. }
            | Action::Compensate(_)
            | Action::ReloadPage
            | Action::RebuildWebview
            | Action::BeginDrain
    )
}

#[test]
fn hostile_sequences_keep_every_invariant() {
    for seed in 0..SEQUENCES {
        let cfg = hostile_config(seed);
        cfg.validate().expect("generated config is valid");
        let cap = cfg.backoff.cap_ms;
        let mut gen = SplitMix64::new(seed ^ 0x5EED);
        let mode = gen.next_u64() % 4;
        let mut now = if gen.next_u64() % 8 == 0 {
            u64::MAX - 10_000_000
        } else {
            gen.next_u64() % 1_000_000_000
        };
        let watermark = if gen.next_u64() % 2 == 0 {
            Some(now.saturating_sub(gen.next_u64() % 100_000_000))
        } else {
            None
        };
        let mut sup = Supervisor::new(cfg, CircuitCounters::default(), SplitMix64::new(seed), now)
            .expect("config");
        sup.set_watermark(watermark);
        let mut prev_backoff = 0u64;
        let mut streak_open = false;
        let mut just_restored = false;
        // Deadline that was pending when the network went down, if any: a
        // deadline that had already elapsed before the freeze is a real failure.
        let mut frozen_at = 0u64;
        let mut deadline_at_freeze: Option<u64> = None;

        for step in 0..STEPS {
            // time: exact wake-up, zero, small, or huge jumps
            let wake = sup.next_wakeup_ms();
            now = match (gen.next_u64() % 6, wake) {
                (0 | 1, Some(w)) if w > now => w,
                (2, _) => now,
                (3, _) => now.saturating_add(gen.next_u64() % 100),
                (4, _) => now.saturating_add(gen.next_u64() % 10_000_000_000),
                _ => now.saturating_add(gen.next_u64() % 60_000),
            };
            let ev = hostile_event(&mut gen, mode);
            let was_frozen = sup.frozen();
            let was_terminal = matches!(sup.phase(), Phase::Terminal(_));
            let before = sup.counters();
            let phase_before = sup.phase();
            let acts = sup.handle(now, ev);
            let ctx = format!(
                "seed={seed} mode={mode} step={step} now={now} ev={ev:?} phase_before={phase_before:?} acts={acts:?}"
            );
            if !was_frozen && !was_terminal && ev == (Event::Network { online: false }) {
                frozen_at = now;
                deadline_at_freeze = deadline_of(phase_before);
            }

            // A tick before the announced wake-up changes nothing (timer contract).
            if ev == Event::Tick {
                if let Some(w) = wake {
                    if now < w {
                        assert!(acts.is_empty(), "tick before wake-up acted: {ctx}");
                        assert_eq!(
                            sup.phase(),
                            phase_before,
                            "tick before wake-up moved: {ctx}"
                        );
                        assert_eq!(sup.counters(), before, "{ctx}");
                    }
                }
                if wake.is_none() && !was_terminal && !was_frozen {
                    assert!(matches!(phase_before, Phase::Tripped), "{ctx}");
                }
            }

            // Frozen: no recovery, counters untouched (unless the event itself unfreezes).
            if was_frozen && !matches!(ev, Event::Network { online: true }) {
                assert!(
                    !acts.iter().any(is_recovery),
                    "recovery while offline: {ctx}"
                );
                assert_eq!(sup.counters(), before, "offline counted: {ctx}");
            }
            // Coming back online never counts a failure by itself, and the next
            // tick at the same instant cannot either (deadlines were shifted).
            if was_frozen
                && ev == (Event::Network { online: true })
                && !was_terminal
                && !matches!(deadline_at_freeze, Some(d) if d <= frozen_at)
            {
                assert_eq!(sup.counters(), before, "restore counted: {ctx}");
                let follow = sup.handle(now, Event::Tick);
                // A stable-period reset may legitimately happen here; a new failure may not.
                assert!(
                    sup.counters().failures <= before.failures
                        && sup.counters().trips == before.trips,
                    "tick right after restore counted: {ctx} follow={follow:?} after={:?}",
                    sup.counters()
                );
            }

            // Terminal: nothing, ever, until rebound.
            if was_terminal && ev != Event::AccountRebound {
                assert!(acts.is_empty(), "{ctx}");
                assert_eq!(sup.counters(), before, "{ctx}");
            }
            if let Phase::Terminal(r) = sup.phase() {
                if !was_terminal {
                    assert_eq!(acts, vec![Action::NotifyTerminal(r)], "{ctx}");
                    assert_eq!(sup.counters(), before, "{ctx}");
                }
                assert_eq!(sup.next_wakeup_ms(), None, "{ctx}");
            }

            for a in &acts {
                match *a {
                    Action::Attempt {
                        level,
                        failures_before,
                        backoff_ms,
                    } => {
                        assert_eq!(level, sup.level_for(failures_before), "{ctx}");
                        assert!(backoff_ms <= cap, "{ctx}");
                        if failures_before == 0 {
                            assert_eq!(backoff_ms, 0, "{ctx}");
                            streak_open = true;
                            prev_backoff = 0;
                        } else if streak_open && !just_restored {
                            assert!(backoff_ms >= prev_backoff, "interval decreased: {ctx}");
                            prev_backoff = backoff_ms;
                        } else {
                            streak_open = true;
                            prev_backoff = backoff_ms;
                        }
                        just_restored = false;
                    }
                    Action::Compensate(p) => {
                        assert!(
                            p.begin_msg_time_ms <= now.saturating_sub(cfg.compensation_lookback_ms),
                            "{ctx}"
                        );
                        if let Some(w) = watermark {
                            assert!(p.begin_msg_time_ms <= w, "watermark skipped: {ctx}");
                        }
                        assert_eq!(p.interval_ms, cfg.compensation_fast_interval_ms, "{ctx}");
                        assert!(p.reset_conversation_list_cursor, "{ctx}");
                        assert!(!was_terminal, "{ctx}");
                    }
                    _ => {}
                }
            }
            if sup.counters().failures == 0 {
                streak_open = false;
            }

            let c = sup.counters();
            assert!(c.failures <= cfg.breaker_threshold, "{ctx}");
            assert!(c.last_delay_ms <= cap, "{ctx}");
            assert_eq!(CircuitCounters::decode(&c.encode()), Ok(c), "{ctx}");
            assert_eq!(
                matches!(sup.phase(), Phase::Tripped),
                c.tripped && !matches!(sup.phase(), Phase::Terminal(_)),
                "{ctx}"
            );
            match sup.phase() {
                Phase::Draining { .. } | Phase::Rebuilding { .. } | Phase::Compensating { .. } => {
                    assert_eq!(
                        sup.send_gate(),
                        SendGate::Reject(RejectReason::ChannelRecovering),
                        "{ctx}"
                    );
                    assert_eq!(
                        RejectReason::ChannelRecovering.code(),
                        "im.channel_recovering"
                    );
                }
                Phase::Online | Phase::Awaiting { .. } | Phase::Backoff { .. } => {
                    assert_eq!(sup.send_gate(), SendGate::Open, "{ctx}");
                }
                _ => {}
            }

            // Instance replacement, including while frozen or tripped.
            if gen.next_u64() % 20 == 0 && !matches!(sup.phase(), Phase::Terminal(_)) {
                let restored =
                    CircuitCounters::decode(&sup.counters().encode()).expect("roundtrip");
                let frozen = sup.frozen();
                sup = Supervisor::new(cfg, restored, SplitMix64::new(gen.next_u64()), now)
                    .expect("config");
                sup.set_watermark(watermark);
                assert_eq!(sup.counters(), restored);
                if frozen {
                    // The host must re-feed the current network state to a new instance.
                    deadline_at_freeze = deadline_of(sup.phase());
                    frozen_at = now;
                    sup.handle(now, Event::Network { online: false });
                    assert!(sup.frozen());
                }
                just_restored = true;
            }
        }
    }
}

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

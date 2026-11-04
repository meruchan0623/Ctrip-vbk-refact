//! Differential tests against the original pairwise coverage rule.
#![allow(clippy::unwrap_used)]
use super::*;
use crate::dedup::MessageIndex;
use contracts::{MessageSource, MsgKind, SendDisposition, SenderRole};
use std::cell::Cell;

fn record(id: &str, time: i64, role: SenderRole) -> MessageRecord {
    MessageRecord {
        gid: "g".into(),
        message_id: Some(id.into()),
        local_id: None,
        create_time_ms: time,
        sender_role: role,
        sender_id: "sender".into(),
        kind: MsgKind::Business,
        disposition: None,
        sources: vec![MessageSource::Realtime],
        seen_count: 1,
    }
}

// Deliberately retain the original pairwise rule, independently of the
// aggregate implementation. BTreeMap also matches the original ID placement.
fn pairwise(
    reply: &MessageRecord,
    customer: &MessageRecord,
    positions: &BTreeMap<&str, usize>,
    boundary: Option<&str>,
) -> Coverage {
    let by_time = if customer.create_time_ms < reply.create_time_ms {
        Coverage::Covered
    } else if customer.create_time_ms == reply.create_time_ms {
        Coverage::Ambiguous
    } else {
        Coverage::NotCovered
    };
    let Some(boundary) = boundary else {
        return by_time;
    };
    let (Some(bpos), Some(cpos)) = (
        positions.get(boundary),
        customer
            .message_id
            .as_deref()
            .and_then(|id| positions.get(id)),
    ) else {
        return if by_time == Coverage::NotCovered {
            Coverage::NotCovered
        } else {
            Coverage::Ambiguous
        };
    };
    if cpos > bpos {
        return Coverage::NotCovered;
    }
    match by_time {
        Coverage::Covered | Coverage::Ambiguous => Coverage::Covered,
        Coverage::NotCovered => Coverage::Ambiguous,
    }
}

fn assert_equivalent(ordered: &[&MessageRecord], boundaries: &BTreeMap<String, String>) {
    let boundary = |reply: &MessageRecord| {
        reply
            .local_id
            .as_ref()
            .and_then(|lid| boundaries.get(lid))
            .map(String::as_str)
    };
    let aggregate = DefaultCoverage::new(ordered, boundary);
    let positions: BTreeMap<&str, usize> = ordered
        .iter()
        .enumerate()
        .filter_map(|(i, m)| m.message_id.as_deref().map(|id| (id, i)))
        .collect();
    let oracle = |reply: &MessageRecord, customer: &MessageRecord| {
        pairwise(reply, customer, &positions, boundary(reply))
    };
    let incomplete = HistoryWindow::default();
    let complete = HistoryWindow {
        complete_watermark_ms: Some(0),
        ..incomplete
    };
    for window in [None, Some(&incomplete), Some(&complete)] {
        assert_eq!(
            aggregate.evaluate(ordered, window),
            evaluate(ordered, window, &oracle)
        );
    }
    // Check every individual status: the earliest candidate alone could hide
    // an incorrect later status that matters after an upsert or a late ACK.
    for customer in ordered.iter().filter(|m| m.is_customer_business()) {
        let statuses: Vec<_> = ordered
            .iter()
            .filter(|r| r.is_confirmed_merchant_reply())
            .map(|r| oracle(r, customer))
            .collect();
        let expected = if statuses.contains(&Coverage::Covered) {
            Coverage::Covered
        } else if statuses.contains(&Coverage::Ambiguous) {
            Coverage::Ambiguous
        } else {
            Coverage::NotCovered
        };
        assert_eq!(
            aggregate.status(customer),
            expected,
            "customer {customer:?}"
        );
    }
    for time in [i64::MIN, -1, 0, 1, 3, 9, i64::MAX] {
        let missing = record("missing-start", time, SenderRole::Customer);
        let expected = ordered
            .iter()
            .filter(|r| r.is_confirmed_merchant_reply() && oracle(r, &missing) == Coverage::Covered)
            .map(|r| r.create_time_ms)
            .max();
        assert_eq!(
            aggregate.latest_reply_covering_missing_start(time),
            expected
        );
    }
}

#[test]
fn frozen_boundary_coverage_matches_pairwise_for_all_relative_times_and_positions() {
    for first_time in [-1, 0, 1, i64::MIN, i64::MAX] {
        for second_time in [-1, 0, 1, i64::MIN, i64::MAX] {
            for first_boundary in [None, Some("a"), Some("b"), Some("unloaded")] {
                for second_boundary in [None, Some("a"), Some("b"), Some("unloaded")] {
                    let mut records = vec![
                        record("a", 0, SenderRole::Customer),
                        record("b", 0, SenderRole::Customer),
                        record("r1", first_time, SenderRole::MerchantSelf),
                        record("r2", second_time, SenderRole::MerchantOther),
                    ];
                    records[2].local_id = Some("l1".into());
                    records[3].local_id = Some("l2".into());
                    // Customers without IDs cannot be placed even if the boundary is known.
                    let mut unidentified = record("c", 0, SenderRole::Customer);
                    unidentified.message_id = None;
                    records.push(unidentified);
                    records.sort_by_key(|r| (r.create_time_ms, r.message_id.clone()));
                    let mut boundaries = BTreeMap::new();
                    if let Some(b) = first_boundary {
                        boundaries.insert("l1".into(), b.into());
                    }
                    if let Some(b) = second_boundary {
                        boundaries.insert("l2".into(), b.into());
                    }
                    assert_equivalent(&records.iter().collect::<Vec<_>>(), &boundaries);
                }
            }
        }
    }
}

#[test]
fn aggregate_matches_after_out_of_order_upserts_replay_role_resolution_and_acks() {
    let mut random = 0x123456789abcdef_u64;
    let mut next = || {
        random ^= random << 13;
        random ^= random >> 7;
        random ^= random << 17;
        random
    };
    let roles = [
        SenderRole::Customer,
        SenderRole::MerchantSelf,
        SenderRole::MerchantOther,
        SenderRole::Unknown,
        SenderRole::Robot,
        SenderRole::CtripAgent,
        SenderRole::System,
    ];
    let kinds = [
        MsgKind::Business,
        MsgKind::Recall,
        MsgKind::Typing,
        MsgKind::ReadReceipt,
        MsgKind::Control,
    ];
    let sources = [
        MessageSource::History,
        MessageSource::Init,
        MessageSource::Realtime,
        MessageSource::Compensation,
    ];
    for _ in 0..12 {
        let mut index = MessageIndex::new();
        let boundaries: BTreeMap<_, _> = (0..40)
            .filter(|i| i % 3 != 0)
            .map(|i| (format!("l{i}"), format!("m{}", next() % 50)))
            .collect();
        for _ in 0..180 {
            let id = next() % 40;
            let mut r = record(
                &format!("m{id}"),
                (next() % 10) as i64 - 3,
                roles[(next() % 7) as usize],
            );
            r.kind = kinds[(next() % 5) as usize];
            r.sources = vec![sources[(next() % 4) as usize]];
            r.local_id = Some(format!("l{id}"));
            r.disposition = match next() % 4 {
                0 => Some(SendDisposition::Unknown),
                1 => Some(SendDisposition::Rejected {
                    code: "test".into(),
                    reason: "test".into(),
                }),
                2 => Some(SendDisposition::Confirmed {
                    server_message_id: format!("m{id}"),
                    server_time_ms: r.create_time_ms,
                }),
                _ => None,
            };
            if next() % 4 == 0 {
                r.message_id = None;
            }
            index.merge(&r.to_fact()).unwrap();
            assert_equivalent(&index.ordered("g"), &boundaries);
        }
    }
}

#[test]
fn generic_callback_keeps_non_monotonic_coverage_and_unresolved_time_semantics() {
    let records = [
        record("a", 10, SenderRole::Customer),
        record("b", 11, SenderRole::Customer),
        record("old", 1, SenderRole::MerchantSelf),
        record("new", 20, SenderRole::MerchantOther),
        record("unresolved", 11, SenderRole::Unknown),
    ];
    let ordered = records.iter().collect::<Vec<_>>();
    let outcome = evaluate(&ordered, Some(&HistoryWindow::default()), &|r, c| {
        if r.message_id.as_deref() == Some("old") && c.message_id.as_deref() == Some("a") {
            Coverage::Covered
        } else {
            Coverage::NotCovered
        }
    });
    assert_eq!(
        outcome.outcome,
        EvalOutcome::Ambiguous {
            candidate: StartCandidate {
                message_id: Some("b".into()),
                create_time_ms: 11
            }
        }
    );
    assert!(outcome.live_evidence);
}

#[test]
#[ignore = "manual reproducible release-mode coverage benchmark"]
fn coverage_scaling_benchmark() {
    for size in [1_000, 5_000, 10_000] {
        let records: Vec<_> = (0..size)
            .map(|i| record(&format!("r{i}"), 0, SenderRole::MerchantOther))
            .chain((0..size).map(|i| record(&format!("c{i}"), 1, SenderRole::Customer)))
            .collect();
        let ordered: Vec<_> = records.iter().collect();
        let calls = Cell::new(0_u64);
        let start = std::time::Instant::now();
        let oracle = evaluate(&ordered, None, &|reply, customer| {
            calls.set(calls.get() + 1);
            // Keep the actual pairwise time decision in the timed loop.
            // black_box prevents constant-folding this deliberately uniform fixture.
            let reply_time = std::hint::black_box(reply.create_time_ms);
            let customer_time = std::hint::black_box(customer.create_time_ms);
            if customer_time < reply_time {
                Coverage::Covered
            } else if customer_time == reply_time {
                Coverage::Ambiguous
            } else {
                Coverage::NotCovered
            }
        });
        let pairwise_time = start.elapsed();
        let resolutions = Cell::new(0);
        let start = std::time::Instant::now();
        let aggregate = DefaultCoverage::new(&ordered, |_| {
            resolutions.set(resolutions.get() + 1);
            None
        });
        let actual = aggregate.evaluate(&ordered, None);
        let aggregate_time = start.elapsed();
        assert_eq!(actual, oracle);
        assert_eq!(calls.get(), (size as u64).pow(2));
        assert_eq!(resolutions.get(), size);
        println!("customers={size} replies={size}: pairwise={} calls {:?}; aggregate={} reply resolutions {:?}", calls.get(), pairwise_time, resolutions.get(), aggregate_time);
    }
}

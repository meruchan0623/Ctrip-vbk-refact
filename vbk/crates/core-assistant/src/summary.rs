//! Package quick-view summary: picks the data plan for an identifier from
//! `dataplan-list` and maps `detail` (+ optional `live-detail`) to the
//! fields of `UiPackageInfo` (docs/dev/09-assistant.md "套餐速览").
//!
//! Field names confirmed by the companion source: `card_dataplan_id`,
//! `iccid`, `eiccid`, `status`, `package_status`, `supplier_name`,
//! `channel_name`, `channel_dataplan_name`. The usage / APN keys below are
//! candidates that have NOT been verified against a live response; unknown
//! values render as an empty string and `remain_pct` as 0.

use contracts::json::JsonValue;
use contracts::AppError;

use crate::package::{id_from_json, validate_query_id};
use crate::session::codes;

/// Longest scalar rendered into the summary.
pub const MAX_FIELD_CHARS: usize = 1000;

/// Summary shown in the package quick view (mirrors `UiPackageInfo`
/// without `fetched_at_ms`, which the host stamps).
#[derive(Debug, Clone, PartialEq)]
pub struct PackageSummary {
    pub iccid: String,
    pub plan: String,
    pub status: String,
    /// 0..=100.
    pub remain_pct: f64,
    pub remain: String,
    pub total: String,
    pub supplier: String,
    pub apn: String,
}

/// Renders a string or finite number; anything else (objects, bools, very
/// long strings) is skipped.
fn scalar(v: Option<&JsonValue>) -> Option<String> {
    let s = match v? {
        JsonValue::String(s) => s.trim().to_string(),
        JsonValue::Number { raw, value } if value.is_finite() => raw.clone(),
        _ => return None,
    };
    if s.is_empty() || s.chars().count() > MAX_FIELD_CHARS {
        return None;
    }
    Some(s)
}

fn first_of(sources: &[Option<&JsonValue>], keys: &[&str]) -> Option<String> {
    for src in sources.iter().flatten() {
        for k in keys {
            if let Some(s) = scalar(src.get(k)) {
                return Some(s);
            }
        }
    }
    None
}

fn number_of(sources: &[Option<&JsonValue>], keys: &[&str]) -> Option<f64> {
    for src in sources.iter().flatten() {
        for k in keys {
            match src.get(k) {
                Some(JsonValue::Number { value, .. }) if value.is_finite() => return Some(*value),
                Some(JsonValue::String(s)) => {
                    if let Ok(n) = s.trim().trim_end_matches('%').trim().parse::<f64>() {
                        if n.is_finite() {
                            return Some(n);
                        }
                    }
                }
                _ => {}
            }
        }
    }
    None
}

/// Picks the row of `dataplan-list` for `identifier`: the row whose
/// `iccid` / `eiccid` equals it, else the first row. Returns its validated
/// `card_dataplan_id`.
pub fn pick_dataplan(rows: &[JsonValue], identifier: &str) -> Result<String, AppError> {
    if rows.is_empty() {
        return Err(AppError::new(
            codes::PACKAGE_NOT_FOUND,
            "no data plan for this identifier",
        ));
    }
    let matches = |r: &JsonValue| {
        ["iccid", "eiccid"]
            .iter()
            .any(|k| scalar(r.get(k)).as_deref() == Some(identifier))
    };
    let row = rows.iter().find(|r| matches(r)).unwrap_or(&rows[0]);
    let id = row
        .get("card_dataplan_id")
        .and_then(id_from_json)
        .ok_or_else(|| {
            AppError::new(
                codes::MALFORMED_RESPONSE,
                "tsim package response: missing card_dataplan_id",
            )
        })?;
    validate_query_id(&id)?;
    Ok(id)
}

const REMAIN_KEYS: [&str; 6] = [
    "remain",
    "remaining",
    "remain_data",
    "remaining_data",
    "left_flow",
    "surplus_flow",
];
const TOTAL_KEYS: [&str; 5] = ["total", "total_data", "total_flow", "flow", "data_total"];
const PCT_KEYS: [&str; 3] = ["remain_pct", "remaining_percent", "remain_percent"];

/// Maps `detail` and the optional `live-detail` block to the summary.
/// `live` values take precedence for usage (they are the fresher source).
pub fn summarize(identifier: &str, detail: &JsonValue, live: Option<&JsonValue>) -> PackageSummary {
    let d = Some(detail);
    let usage_sources = [live, d];
    let iccid = first_of(&[d], &["iccid", "eiccid"]).unwrap_or_else(|| identifier.to_string());
    let plan = first_of(
        &[d],
        &["channel_dataplan_name", "dataplan_name", "plan_name"],
    )
    .unwrap_or_default();
    let status = first_of(&[d, live], &["package_status", "status"]).unwrap_or_default();
    let supplier = first_of(&[d], &["supplier_name", "channel_name"]).unwrap_or_default();
    let apn = first_of(&[live, d], &["apn"]).unwrap_or_default();
    let remain = first_of(&usage_sources, &REMAIN_KEYS).unwrap_or_default();
    let total = first_of(&usage_sources, &TOTAL_KEYS).unwrap_or_default();
    let remain_pct = number_of(&usage_sources, &PCT_KEYS)
        .or_else(|| {
            // Only when both are plain numbers in the same (unknown) unit.
            let r = number_of(&usage_sources, &REMAIN_KEYS)?;
            let t = number_of(&usage_sources, &TOTAL_KEYS)?;
            (t > 0.0).then(|| r / t * 100.0)
        })
        .unwrap_or(0.0)
        .clamp(0.0, 100.0);
    PackageSummary {
        iccid,
        plan,
        status,
        remain_pct,
        remain,
        total,
        supplier,
        apn,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn j(s: &str) -> JsonValue {
        JsonValue::parse(s).expect("json")
    }

    #[test]
    fn picks_matching_row_or_first() {
        let rows = j(
            r#"[{"card_dataplan_id":11,"iccid":"8901"},{"card_dataplan_id":"c-2","iccid":"8902"}]"#,
        );
        let rows = rows.as_array().expect("array");
        assert_eq!(pick_dataplan(rows, "8902").expect("pick"), "c-2");
        assert_eq!(pick_dataplan(rows, "nope").expect("first"), "11");
        assert!(pick_dataplan(&[], "x")
            .expect_err("empty")
            .is(codes::PACKAGE_NOT_FOUND));
        let bad = j(r#"[{"card_dataplan_id":"a b"}]"#);
        assert!(pick_dataplan(bad.as_array().expect("a"), "x").is_err());
        let missing = j(r#"[{"iccid":"x"}]"#);
        assert!(pick_dataplan(missing.as_array().expect("a"), "x")
            .expect_err("missing")
            .is(codes::MALFORMED_RESPONSE));
    }

    #[test]
    fn summarizes_known_fields() {
        let detail = j(
            r#"{"iccid":"8986001","channel_dataplan_name":"7天5GB","package_status":"使用中","status":"x","supplier_name":"S","apn":"a.apn","total_flow":"5","nested":{"a":1}}"#,
        );
        let live = j(r#"{"remain":"2.5","status":"y"}"#);
        let s = summarize("q", &detail, Some(&live));
        assert_eq!(s.iccid, "8986001");
        assert_eq!(s.plan, "7天5GB");
        assert_eq!(s.status, "使用中");
        assert_eq!(s.supplier, "S");
        assert_eq!(s.apn, "a.apn");
        assert_eq!(s.remain, "2.5");
        assert_eq!(s.total, "5");
        assert!((s.remain_pct - 50.0).abs() < 1e-9);
    }

    #[test]
    fn unknown_fields_render_empty() {
        let s = summarize("8986", &j(r#"{"status":true,"remain_pct":"250%"}"#), None);
        assert_eq!(s.iccid, "8986");
        assert_eq!(s.status, "");
        assert_eq!(s.plan, "");
        assert_eq!(s.remain_pct, 100.0);
        let long = "x".repeat(MAX_FIELD_CHARS + 1);
        let d = j(&format!(
            r#"{{"supplier_name":"{long}","channel_name":"C"}}"#
        ));
        assert_eq!(summarize("i", &d, None).supplier, "C");
    }
}

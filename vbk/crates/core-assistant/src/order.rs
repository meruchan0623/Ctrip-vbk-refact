//! Read-only order query projections. No credentials, arbitrary JSON or resource URLs escape.
use crate::session::codes;
use crate::{id_from_json, summarize, validate_query_id, PackageSummary};
use contracts::{json::JsonValue, AppError};

pub fn validate_order_id(value: &str) -> Result<&str, AppError> {
    if matches!(value.len(), 10 | 16) && value.bytes().all(|b| b.is_ascii_digit()) {
        Ok(value)
    } else {
        Err(AppError::new(
            codes::INVALID_INPUT,
            "order id must be a complete 10 or 16 digit string",
        ))
    }
}

/// All identifiers from this exact query result, in source order.
pub fn plan_ids(rows: &[JsonValue]) -> Result<Vec<String>, AppError> {
    if rows.is_empty() {
        return Err(AppError::new(
            codes::PACKAGE_NOT_FOUND,
            "no data plans for this order",
        ));
    }
    if rows.len() > 100 {
        return Err(AppError::new(
            codes::MALFORMED_RESPONSE,
            "too many data plans",
        ));
    }
    let mut seen = std::collections::HashSet::new();
    rows.iter()
        .map(|row| {
            let id = row
                .get("card_dataplan_id")
                .and_then(id_from_json)
                .ok_or_else(|| AppError::new(codes::MALFORMED_RESPONSE, "missing card id"))?;
            validate_query_id(&id)?;
            if !seen.insert(id.clone()) {
                return Err(AppError::new(
                    codes::MALFORMED_RESPONSE,
                    "duplicate card id",
                ));
            }
            Ok(id)
        })
        .collect()
}

/// The legacy ICCID parser caps rows for its old contract. Order queries must
/// fail on over-cap responses rather than silently claim a truncated order.
pub fn parse_plan_list(status: u16, body: &str) -> Result<Vec<JsonValue>, AppError> {
    let rows = crate::parse_dataplan_list(status, body)?;
    let value = JsonValue::parse(body)
        .map_err(|_| AppError::new(codes::MALFORMED_RESPONSE, "invalid list JSON"))?;
    if value
        .get("result")
        .and_then(JsonValue::as_array)
        .map(Vec::len)
        != Some(rows.len())
    {
        return Err(AppError::new(
            codes::MALFORMED_RESPONSE,
            "order list exceeds local resource limit",
        ));
    }
    Ok(rows)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Field {
    pub label: String,
    pub value: String,
}
fn scalar(value: Option<&JsonValue>) -> Option<String> {
    let value = match value? {
        JsonValue::String(value) => value.trim().to_owned(),
        JsonValue::Number { raw, value } if value.is_finite() => raw.clone(),
        _ => return None,
    };
    (!value.is_empty() && value.chars().count() <= 1000 && !value.chars().any(|c| c.is_control()))
        .then_some(value)
}
fn fields(value: &JsonValue, schema: &[(&str, &str)]) -> Vec<Field> {
    schema
        .iter()
        .filter_map(|(key, label)| {
            scalar(value.get(key)).map(|value| Field {
                label: label.to_string(),
                value,
            })
        })
        .collect()
}
/// Field names verified in TSim frontend types/package.ts and the installed assistant projector.
pub fn detail_fields(value: &JsonValue) -> Vec<Field> {
    fields(
        value,
        &[
            ("iccid", "ICCID"),
            ("eiccid", "业务流水号"),
            ("channel_dataplan_name", "渠道套餐"),
            ("dataplan_name", "来源套餐"),
            ("supplier_name", "供应商"),
            ("channel_name", "渠道"),
            ("package_status", "套餐状态"),
            ("status", "查询状态"),
            ("support_regions", "支持地区"),
            ("apn", "APN"),
            ("aging_desc", "有效期"),
            ("esim_status", "eSIM状态"),
            ("esim_event_time", "eSIM更新时间"),
            ("esim_eid", "EID"),
            ("device_model", "设备型号"),
            ("data_usage", "累计用量（MB）"),
            ("today_usage", "当日用量（MB）"),
            ("spec_name", "套餐规格"),
        ],
    )
}
pub fn live_fields(value: &JsonValue) -> Vec<Field> {
    let mut result = fields(
        value,
        &[
            ("package_status", "实时状态"),
            ("data_usage", "累计用量（MB）"),
            ("today_usage", "当日用量（MB）"),
            ("volume", "容量（MB）"),
            ("spec_name", "套餐规格"),
            ("apn", "APN"),
            ("esim_status", "eSIM状态"),
            ("esim_eid", "EID"),
            ("device_model", "设备型号"),
        ],
    );
    if let Some(original) = value.get("original_data") {
        result.extend(fields(original, &[("data_usage", "原始累计用量（MB）")]));
    }
    result
}
pub fn cdr_fields(detail: &JsonValue, supplement: Option<&JsonValue>) -> Vec<Vec<Field>> {
    fn records(value: &JsonValue) -> Option<&Vec<JsonValue>> {
        value
            .as_array()
            .or_else(|| value.get("list").and_then(JsonValue::as_array))
    }
    let rows = supplement
        .and_then(records)
        .filter(|r| !r.is_empty())
        .or_else(|| detail.get("cdr_list").and_then(records));
    rows.into_iter()
        .flatten()
        .take(100)
        .map(|row| {
            fields(
                row,
                &[
                    ("start_time", "开始时间"),
                    ("end_time", "结束时间"),
                    ("event_time", "时间"),
                    ("duration", "时长（秒）"),
                    ("country", "国家/地区"),
                    ("region", "地区"),
                    ("operator", "运营商"),
                    ("network", "网络"),
                    ("upload_mb", "上行（MB）"),
                    ("download_mb", "下行（MB）"),
                    ("total_mb", "总用量（MB）"),
                    ("total_usage_kb", "总用量（KB）"),
                    ("total_usage", "总用量（MB）"),
                ],
            )
        })
        .filter(|r| !r.is_empty())
        .collect()
}
pub fn order_summary(detail: &JsonValue, live: Option<&JsonValue>) -> PackageSummary {
    let mut result = summarize("", detail, live);
    // `status`/`query_status` describe the upstream query, not the package.
    result.status = live
        .and_then(|v| scalar(v.get("package_status")))
        .or_else(|| scalar(detail.get("package_status")))
        .unwrap_or_default();
    result.apn = live
        .and_then(|v| scalar(v.get("apn")))
        .or_else(|| scalar(detail.get("apn")))
        .or_else(|| detail.get("operate").and_then(|v| scalar(v.get("apn"))))
        .unwrap_or_default();
    // No evidence for numeric units in the legacy generic keys: derive only from
    // the installed operator contract (MB, 1024 MB = 1 GB), never plan-name guesses.
    let number = |value: Option<&JsonValue>| {
        scalar(value)
            .and_then(|s| s.parse::<f64>().ok())
            .filter(|n| n.is_finite() && *n >= 0.0)
    };
    let truthy = |v: Option<&JsonValue>| {
        matches!(v, Some(JsonValue::Bool(true)))
            || matches!(v, Some(JsonValue::Number { value, .. }) if *value == 1.0)
            || v.and_then(JsonValue::as_str)
                .is_some_and(|s| s == "1" || s == "true")
    };
    let daily = truthy(detail.get("is_daily")) || live.is_some_and(|v| truthy(v.get("is_daily")));
    let quota = if daily {
        None
    } else {
        live.and_then(|v| number(v.get("volume")))
    };
    let usage = live
        .and_then(|v| v.get("original_data"))
        .and_then(|v| number(v.get("data_usage")))
        .or_else(|| live.and_then(|v| number(v.get("data_usage"))))
        .or_else(|| number(detail.get("data_usage")));
    result.remain.clear();
    result.total.clear();
    result.remain_pct = 0.0;
    if let (Some(quota), Some(usage)) = (quota.filter(|n| *n > 0.0), usage) {
        let remaining = (quota - usage).max(0.0);
        result.remain = format_mb(remaining);
        result.total = format_mb(quota);
        result.remain_pct = (remaining / quota * 100.0).clamp(0.0, 100.0);
    }
    result
}
fn format_mb(value: f64) -> String {
    let (amount, unit) = if value >= 1024.0 {
        (value / 1024.0, "GB")
    } else {
        (value, "MB")
    };
    let text = format!("{amount:.2}");
    format!(
        "{} {unit}",
        text.trim_end_matches('0').trim_end_matches('.')
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn j(value: &str) -> JsonValue {
        JsonValue::parse(value).unwrap()
    }
    #[test]
    fn all_plans_and_exact_large_identifiers_are_retained() {
        let rows =
            j(r#"[{"card_dataplan_id":9007199254740993},{"card_dataplan_id":"other-card"}]"#);
        assert_eq!(
            plan_ids(rows.as_array().unwrap()).unwrap(),
            ["9007199254740993", "other-card"]
        );
        assert!(plan_ids(
            j(r#"[{"card_dataplan_id":"a"},{"card_dataplan_id":"a"}]"#)
                .as_array()
                .unwrap()
        )
        .is_err());
        assert!(plan_ids(j(r#"[{"card_dataplan_id":"a"},{}]"#).as_array().unwrap()).is_err());
    }
    #[test]
    fn oversized_order_lists_are_rejected_without_changing_the_legacy_iccid_cap() {
        let rows: Vec<_> = (0..101)
            .map(|i| format!(r#"{{"card_dataplan_id":"c-{i}"}}"#))
            .collect();
        let body = format!(r#"{{"code":1,"result":[{}]}}"#, rows.join(","));
        assert_eq!(crate::parse_dataplan_list(200, &body).unwrap().len(), 100);
        assert!(parse_plan_list(200, &body).is_err());
        assert!(parse_plan_list(401, "{}")
            .unwrap_err()
            .is(codes::SESSION_CLEARED));
    }

    #[test]
    fn order_ids_are_lossless_and_complete() {
        for value in ["0000000001", "0000000000000001"] {
            assert_eq!(validate_order_id(value).unwrap(), value);
        }
        for value in [
            " 0000000001",
            "0000000001\n",
            "123456789",
            "12345678901",
            "12345678901234567",
            "1e9",
            "１２３４５６７８９０",
        ] {
            assert!(validate_order_id(value).is_err());
        }
    }
    #[test]
    fn whitelist_projects_real_detail_live_and_cdr_without_secret_or_activation_material() {
        let detail = j(
            r#"{"channel_dataplan_name":"synthetic plan","iccid":"synthetic iccid","activation_code":"SECRET","access_token":"SECRET","qrcode_url":"SECRET","cdr_list":[{"start_time":"2026-10-31 12:00:00","country":"JP","total_mb":2,"imsi":"SECRET"}]}"#,
        );
        let text = format!(
            "{:?}{:?}",
            detail_fields(&detail),
            cdr_fields(&detail, None)
        );
        assert!(
            text.contains("synthetic plan") && text.contains("2026-10-31") && text.contains("JP")
        );
        assert!(!text.contains("SECRET"));
        let live = j(
            r#"{"volume":2048,"data_usage":1024,"original_data":{"data_usage":512},"access_token":"SECRET"}"#,
        );
        let summary = order_summary(&detail, Some(&live));
        assert_eq!(summary.total, "2 GB");
        assert_eq!(summary.remain, "1.5 GB");
        assert_eq!(summary.remain_pct, 75.0);
        assert!(!format!("{:?}", live_fields(&live)).contains("SECRET"));
        assert!(order_summary(&detail, None).remain.is_empty());
    }
    #[test]
    fn package_state_is_live_first_and_never_query_success_and_zero_usage_requires_a_real_quota() {
        let detail = j(
            r#"{"channel_dataplan_name":"SYNTHETIC 8GB plan","status":"success","query_status":"success","package_status":"not_activated"}"#,
        );
        let live =
            j(r#"{"package_status":"using","data_usage":0,"today_usage":0,"spec_name":"8GB"}"#);
        let unknown = order_summary(&detail, Some(&live));
        assert_eq!(unknown.status, "using");
        assert!(unknown.remain.is_empty() && unknown.total.is_empty());
        let only_query = j(r#"{"status":"success","query_status":"success"}"#);
        assert!(order_summary(&only_query, None).status.is_empty());
        let known = order_summary(
            &detail,
            Some(&j(
                r#"{"package_status":"using","volume":2048,"data_usage":0}"#,
            )),
        );
        assert_eq!(known.remain, "2 GB");
        assert_eq!(known.total, "2 GB");
        assert_eq!(known.remain_pct, 100.0);
        let daily = order_summary(
            &detail,
            Some(&j(r#"{"is_daily":1,"volume":2048,"data_usage":0}"#)),
        );
        assert!(daily.remain.is_empty() && daily.total.is_empty());
    }
}

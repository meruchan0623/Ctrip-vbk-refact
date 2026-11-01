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
    let mut result = fields(
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
    );
    if !daily_usage_available(value, None) {
        result.retain(|field| field.label != "当日用量（MB）");
    }
    result
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
    if !daily_usage_available(value, None) {
        result.retain(|field| field.label != "当日用量（MB）");
    }
    result
}

fn truthy(value: Option<&JsonValue>) -> bool {
    matches!(value, Some(JsonValue::Bool(true)))
        || matches!(value, Some(JsonValue::Number { value, .. }) if *value == 1.0)
        || value
            .and_then(JsonValue::as_str)
            .is_some_and(|s| s == "1" || s == "true")
}

/// Work out the denominator's scope from the supplier's explicit daily flag.
pub fn usage_scope(detail: &JsonValue, live: Option<&JsonValue>) -> &'static str {
    if truthy(detail.get("is_daily")) || live.is_some_and(|v| truthy(v.get("is_daily"))) {
        "daily"
    } else {
        "total"
    }
}

fn amount_mb(value: Option<&JsonValue>) -> Option<f64> {
    if let Some(JsonValue::Number { value, .. }) = value {
        return (value.is_finite() && *value >= 0.0).then_some(*value);
    }
    let text = scalar(value)?;
    let text = text.trim().to_ascii_uppercase();
    let end = text
        .find(|c: char| !c.is_ascii_digit() && c != '.')
        .unwrap_or(text.len());
    let number = &text[..end];
    if number.is_empty()
        || number.starts_with('.')
        || number.ends_with('.')
        || number.matches('.').count() > 1
    {
        return None;
    }
    let raw_unit = text[end..].trim();
    let unit = if raw_unit.starts_with('(') || raw_unit.ends_with(')') {
        raw_unit.strip_prefix('(')?.strip_suffix(')')?.trim()
    } else {
        raw_unit
    };
    let factor = match unit {
        "" | "MB" => 1.0,
        "KB" => 1.0 / 1024.0,
        "GB" => 1024.0,
        "TB" => 1024.0 * 1024.0,
        _ => return None,
    };
    let result = number.parse::<f64>().ok()? * factor;
    (result.is_finite() && result >= 0.0).then_some(result)
}

fn selected_spec(detail: &JsonValue, live: Option<&JsonValue>) -> Option<String> {
    live.and_then(|v| scalar(v.get("spec_name")))
        .or_else(|| scalar(detail.get("spec_name")))
}
fn is_unlimited(spec: &str) -> bool {
    let lower = spec.to_ascii_lowercase();
    ["无限", "無限", "unlimited", "不限量"]
        .iter()
        .any(|word| lower.contains(word))
}

/// Only explicit per-day quantities in the dedicated specification are usable.
/// Product/channel/source titles never supply a guessed denominator.
fn daily_spec_quota(spec: &str) -> Option<f64> {
    if is_unlimited(spec) {
        return None;
    }
    let spec = spec.to_ascii_lowercase();
    let mut quantities = Vec::new();
    for (start, ch) in spec.char_indices() {
        if !ch.is_ascii_digit()
            || spec[..start]
                .chars()
                .next_back()
                .is_some_and(|c| c.is_ascii_alphanumeric() || c == '.')
        {
            continue;
        }
        let tail = &spec[start..];
        let end = tail
            .find(|c: char| !c.is_ascii_digit() && c != '.')
            .unwrap_or(tail.len());
        let after = tail[end..].trim_start();
        let unit = if after.starts_with("gb") {
            "gb"
        } else if after.starts_with("mb") {
            "mb"
        } else {
            continue;
        };
        let suffix = &after[2..];
        if suffix
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic())
        {
            continue;
        }
        let prefix = spec[..start].trim_end();
        let prefix_daily = ["每日", "每天", "daily", "per day"].iter().any(|word| {
            prefix.strip_suffix(word).is_some_and(|rest| {
                !word.is_ascii()
                    || !rest
                        .chars()
                        .next_back()
                        .is_some_and(|c| c.is_ascii_alphanumeric())
            })
        });
        let suffix_daily = suffix
            .trim_start()
            .strip_prefix('/')
            .map(str::trim_start)
            .is_some_and(|s| {
                s.starts_with('天')
                    || s.starts_with('日')
                    || s.strip_prefix("day").is_some_and(|rest| {
                        !rest.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
                    })
            });
        if !prefix_daily && !suffix_daily {
            continue;
        }
        if let Some(value) = amount_mb(Some(&JsonValue::String(format!("{} {unit}", &tail[..end]))))
            .filter(|v| *v > 0.0)
        {
            if !quantities.contains(&value) {
                quantities.push(value);
            }
        }
    }
    (quantities.len() == 1).then(|| quantities[0])
}

fn usage_quota(detail: &JsonValue, live: Option<&JsonValue>) -> Option<f64> {
    if usage_scope(detail, live) == "daily" {
        return selected_spec(detail, live).and_then(|s| daily_spec_quota(&s));
    }
    live.and_then(|v| amount_mb(v.get("volume")))
        .filter(|n| *n > 0.0)
        .or_else(|| {
            let value = detail.get("total_data")?;
            value
                .as_str()
                .filter(|s| s.chars().any(|c| c.is_ascii_alphabetic()))?;
            amount_mb(Some(value)).filter(|n| *n > 0.0)
        })
}

/// Unlimited plans expose their explicit label, without a fabricated percentage.
pub fn unlimited(detail: &JsonValue, live: Option<&JsonValue>) -> bool {
    usage_quota(detail, live).is_none()
        && selected_spec(detail, live).is_some_and(|s| is_unlimited(&s))
}

pub fn daily_usage_available(detail: &JsonValue, live: Option<&JsonValue>) -> bool {
    live.and_then(|v| v.get("can_check_daily_usage"))
        .or_else(|| detail.get("can_check_daily_usage"))
        .map_or(true, |v| truthy(Some(v)))
}

pub fn today_usage_mb(detail: &JsonValue, live: Option<&JsonValue>) -> Option<f64> {
    if !daily_usage_available(detail, live) {
        return None;
    }
    live.and_then(|v| amount_mb(v.get("today_usage")))
        .or_else(|| amount_mb(detail.get("today_usage")))
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
                    ("update_datetime", "更新时间"),
                    ("update_time", "更新时间戳"),
                    ("date", "日期"),
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
    let quota = usage_quota(detail, live);
    let usage = if usage_scope(detail, live) == "daily" {
        today_usage_mb(detail, live)
    } else {
        live.and_then(|v| v.get("original_data"))
            .and_then(|v| amount_mb(v.get("data_usage")))
            .or_else(|| live.and_then(|v| amount_mb(v.get("data_usage"))))
            .or_else(|| amount_mb(detail.get("data_usage")))
    };
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

    #[test]
    fn daily_quota_uses_today_instead_of_cumulative_or_live_volume() {
        for spec in [
            "每日 1GB",
            "每天1GB",
            "Daily 1 GB",
            "1GB/天",
            "1GB / 日",
            "1 GB/day",
            "per day 1024MB",
        ] {
            let detail = j(&format!(
                r#"{{"is_daily":1,"spec_name":"{spec}","today_usage":512}}"#
            ));
            let live = j(
                r#"{"data_usage":8192,"volume":51200,"today_usage":"256 MB","can_check_daily_usage":1}"#,
            );
            assert_eq!(usage_scope(&detail, Some(&live)), "daily");
            let summary = order_summary(&detail, Some(&live));
            assert_eq!(summary.total, "1 GB", "{spec}");
            assert_eq!(summary.remain, "768 MB", "{spec}");
            assert_eq!(summary.remain_pct, 75.0, "{spec}");
        }
    }

    #[test]
    fn unavailable_daily_usage_is_never_a_fabricated_zero() {
        let detail = j(r#"{"is_daily":true,"spec_name":"每日2GB","today_usage":0,"data_usage":0}"#);
        for denied in ["0", "false", "\"0\"", "null"] {
            let live = j(&format!(
                r#"{{"today_usage":0,"can_check_daily_usage":{denied}}}"#
            ));
            assert!(!daily_usage_available(&detail, Some(&live)));
            assert_eq!(today_usage_mb(&detail, Some(&live)), None);
            let summary = order_summary(&detail, Some(&live));
            assert!(summary.remain.is_empty() && summary.total.is_empty());
            assert!(live_fields(&live)
                .iter()
                .all(|field| field.label != "当日用量（MB）"));
        }
        let no_today = j(r#"{"is_daily":1,"spec_name":"每日2GB","data_usage":0}"#);
        assert!(order_summary(&no_today, None).remain.is_empty());
        let enabled = j(r#"{"can_check_daily_usage":true,"today_usage":0}"#);
        assert_eq!(order_summary(&detail, Some(&enabled)).remain, "2 GB");
    }

    #[test]
    fn daily_quotas_reject_total_amounts_product_titles_and_ambiguous_specifications() {
        for spec in [
            "8GB",
            "每日1GB 或 每日2GB",
            "notdaily 1GB",
            "1GB/days",
            "每日0GB",
            "每日1e3GB",
            "每日-1GB",
        ] {
            let detail = j(&format!(
                r#"{{"is_daily":1,"spec_name":"{spec}","dataplan_name":"每日3GB","channel_dataplan_name":"每日3GB","today_usage":0}}"#
            ));
            let summary = order_summary(&detail, None);
            assert!(
                summary.total.is_empty() && summary.remain.is_empty(),
                "{spec}"
            );
        }
    }

    #[test]
    fn unlimited_labels_never_fabricate_a_remaining_gauge() {
        for spec in ["每日无限量", "無限流量", "Unlimited", "不限量"] {
            let detail = j(&format!(r#"{{"spec_name":"{spec}","data_usage":0}}"#));
            assert!(unlimited(&detail, None), "{spec}");
            assert!(order_summary(&detail, None).remain.is_empty());
        }
        let detail = j(r#"{"spec_name":"Unlimited","data_usage":0}"#);
        let numeric = j(r#"{"volume":2048,"data_usage":512}"#);
        assert!(
            !unlimited(&detail, Some(&numeric)),
            "explicit numeric supplier quota wins as in the operator projector"
        );
        let newer = j(r#"{"spec_name":"每日1GB","is_daily":1,"today_usage":0}"#);
        assert!(!unlimited(&detail, Some(&newer)));
    }

    #[test]
    fn units_zero_and_overage_use_the_same_verified_denominator() {
        let total = j(r#"{"total_data":"3 GB","data_usage":"1024(MB)"}"#);
        let summary = order_summary(&total, None);
        assert_eq!(
            (
                summary.total.as_str(),
                summary.remain.as_str(),
                (summary.remain_pct * 100.0).round() / 100.0
            ),
            ("3 GB", "2 GB", 66.67)
        );
        let ambiguous = j(r#"{"total_data":3000,"spec_name":"8GB","data_usage":0}"#);
        assert!(order_summary(&ambiguous, None).remain.is_empty());
        let daily = j(r#"{"is_daily":"true","spec_name":"每日512MB","today_usage":"1 GB"}"#);
        let summary = order_summary(&daily, None);
        assert_eq!(
            (
                summary.total.as_str(),
                summary.remain.as_str(),
                summary.remain_pct
            ),
            ("512 MB", "0 MB", 0.0)
        );
        assert_eq!(amount_mb(Some(&j("1e3"))), Some(1000.0));
        for malformed in ["((GB))", "1 GB)", "1(GB", "-1 MB", "NaN", "1e3 MB"] {
            assert_eq!(amount_mb(Some(&JsonValue::String(malformed.into()))), None);
        }
    }
}

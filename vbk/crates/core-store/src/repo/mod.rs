//! Typed repositories over the generic store. Each is a unit struct with
//! associated functions: reads take `&dyn Store`, writes take `&mut Txn`;
//! read-modify-write helpers take both and add a CAS expectation.

pub mod draft;
pub mod pinned;
pub mod reminder;
pub mod send_intent;
pub mod sync;

use contracts::json::JsonValue;
use contracts::AppError;

use crate::error::{codes, err};

pub(crate) fn decode_err(collection: &str, key: &str, what: &str) -> AppError {
    err(codes::STORE_CORRUPT, format!("{collection}/{key}: {what}"))
}

pub(crate) fn req_str(v: &JsonValue, field: &str, collection: &str, key: &str) -> Result<String, AppError> {
    v.get(field)
        .and_then(JsonValue::as_str)
        .map(str::to_string)
        .ok_or_else(|| decode_err(collection, key, &format!("missing string {field}")))
}

pub(crate) fn req_i64(v: &JsonValue, field: &str, collection: &str, key: &str) -> Result<i64, AppError> {
    v.get(field)
        .and_then(JsonValue::as_i64)
        .ok_or_else(|| decode_err(collection, key, &format!("missing integer {field}")))
}

pub(crate) fn opt_str(v: &JsonValue, field: &str) -> Option<String> {
    v.get(field).and_then(JsonValue::as_str).map(str::to_string)
}

pub(crate) fn opt_i64(v: &JsonValue, field: &str) -> Option<i64> {
    v.get(field).and_then(JsonValue::as_i64)
}

pub(crate) fn opt_bool(v: &JsonValue, field: &str) -> Option<bool> {
    v.get(field).and_then(JsonValue::as_bool)
}

pub(crate) fn json_opt_str(s: &Option<String>) -> JsonValue {
    s.as_deref().map(JsonValue::string).unwrap_or(JsonValue::Null)
}

pub(crate) fn json_opt_i64(n: Option<i64>) -> JsonValue {
    n.map(JsonValue::number_from_i64).unwrap_or(JsonValue::Null)
}

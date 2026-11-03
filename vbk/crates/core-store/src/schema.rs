//! Document schema version and compiled-in migrations (I-25).
//!
//! Every namespace document carries `meta.schema_version`. Migrations are
//! plain functions compiled into the binary: nothing downloaded or
//! hot-updated can alter how a document is rewritten.
//!
//! Rules:
//!
//! * A document **without** `schema_version` is version 1 (the layout that
//!   only had `meta.format = 1`).
//! * A document with a version **greater** than [`CURRENT_SCHEMA_VERSION`]
//!   is refused with `store.schema_too_new`. The file is left untouched (no
//!   quarantine, no rewrite): an older binary must never overwrite data
//!   written by a newer one.
//! * Older documents are migrated step by step in memory; the migrated
//!   document reaches disk with the next commit.

use contracts::json::JsonValue;

/// Version written by this build.
pub const CURRENT_SCHEMA_VERSION: u32 = 2;

/// Why a document could not be brought to the current schema.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SchemaError {
    /// Written by a newer build.
    TooNew { found: u32, supported: u32 },
    /// `meta` missing or `schema_version` not a positive integer.
    Malformed(&'static str),
}

/// Version recorded in a document (1 when absent).
pub fn document_version(doc: &JsonValue) -> Result<u32, SchemaError> {
    let meta = doc
        .get("meta")
        .ok_or(SchemaError::Malformed("missing meta"))?;
    match meta.get("schema_version") {
        None => Ok(1),
        Some(v) => match v.as_i64() {
            Some(n) if (1..=i64::from(u32::MAX)).contains(&n) => Ok(n as u32),
            _ => Err(SchemaError::Malformed("bad schema_version")),
        },
    }
}

/// Migrates `doc` to [`CURRENT_SCHEMA_VERSION`]. Idempotent for documents
/// already current.
pub fn migrate_to_current(doc: JsonValue) -> Result<JsonValue, SchemaError> {
    let mut version = document_version(&doc)?;
    if version > CURRENT_SCHEMA_VERSION {
        return Err(SchemaError::TooNew {
            found: version,
            supported: CURRENT_SCHEMA_VERSION,
        });
    }
    let mut doc = doc;
    while version < CURRENT_SCHEMA_VERSION {
        doc = match version {
            1 => v1_to_v2(doc)?,
            _ => return Err(SchemaError::Malformed("no migration step")),
        };
        version += 1;
    }
    Ok(doc)
}

/// v1 -> v2: introduces `meta.schema_version`. Collections are unchanged.
fn v1_to_v2(mut doc: JsonValue) -> Result<JsonValue, SchemaError> {
    stamp_version(&mut doc, 2)?;
    Ok(doc)
}

fn stamp_version(doc: &mut JsonValue, version: u32) -> Result<(), SchemaError> {
    let JsonValue::Object(top) = doc else {
        return Err(SchemaError::Malformed("document is not an object"));
    };
    let Some(JsonValue::Object(meta)) = top.get_mut("meta") else {
        return Err(SchemaError::Malformed("missing meta"));
    };
    meta.insert(
        "schema_version".to_string(),
        JsonValue::number_from_i64(i64::from(version)),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    fn doc(version: Option<i64>) -> JsonValue {
        let mut meta = JsonValue::object();
        meta.insert("format", JsonValue::number_from_i64(1));
        if let Some(v) = version {
            meta.insert("schema_version", JsonValue::number_from_i64(v));
        }
        let mut d = JsonValue::object();
        d.insert("meta", meta);
        d.insert("collections", JsonValue::object());
        d
    }

    #[test]
    fn legacy_document_is_version_one_and_migrates() {
        let d = doc(None);
        assert_eq!(document_version(&d), Ok(1));
        let m = migrate_to_current(d).unwrap();
        assert_eq!(document_version(&m), Ok(CURRENT_SCHEMA_VERSION));
        // idempotent
        assert_eq!(migrate_to_current(m.clone()).unwrap(), m);
    }

    #[test]
    fn newer_document_is_refused_not_migrated() {
        let d = doc(Some(i64::from(CURRENT_SCHEMA_VERSION) + 1));
        assert_eq!(
            migrate_to_current(d),
            Err(SchemaError::TooNew {
                found: CURRENT_SCHEMA_VERSION + 1,
                supported: CURRENT_SCHEMA_VERSION
            })
        );
    }

    #[test]
    fn malformed_versions_are_rejected() {
        assert!(migrate_to_current(doc(Some(0))).is_err());
        assert!(migrate_to_current(doc(Some(-3))).is_err());
        assert!(migrate_to_current(JsonValue::object()).is_err());
    }
}

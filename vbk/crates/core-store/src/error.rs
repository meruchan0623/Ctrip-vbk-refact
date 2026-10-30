//! `store.*` error codes.

use contracts::AppError;

pub mod codes {
    pub use contracts::codes::{STORE_CORRUPT, STORE_IO};

    /// The namespace is logout-locked: reads work, writes are refused.
    pub const STORE_LOCKED: &str = "store.locked";
    /// Compare-and-set failed: the record changed since it was read.
    pub const STORE_CAS_CONFLICT: &str = "store.cas_conflict";
    /// `PendingVerification` was opened without reconciliation evidence.
    pub const STORE_NOT_RECONCILED: &str = "store.not_reconciled";
    /// A transaction was committed against a different store / namespace
    /// than it was begun on.
    pub const STORE_TXN_MISMATCH: &str = "store.txn_mismatch";
}

pub(crate) fn err(code: &str, message: impl Into<String>) -> AppError {
    AppError::new(code, message)
}

pub(crate) fn io_err(context: &str, e: &std::io::Error) -> AppError {
    AppError::new(codes::STORE_IO, format!("{context}: {}", e.kind())).with_detail(e.to_string())
}

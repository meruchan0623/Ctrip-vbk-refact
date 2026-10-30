//! `account.*` error codes. Cross-module codes come from
//! `contracts::codes`; the ones below are private to this crate but keep the
//! same prefix convention.

use contracts::AppError;

pub mod codes {
    pub use contracts::codes::{
        ACCOUNT_STALE_GENERATION, ACCOUNT_TICKET_EXPIRED, ACCOUNT_UNKNOWN,
    };

    /// The `attempt_id` is unknown (never started, already published or
    /// already cancelled). Late callbacks for it must be dropped.
    pub const ACCOUNT_ATTEMPT_UNKNOWN: &str = "account.attempt_unknown";
    /// The attempt was cancelled by the user; a late identity result must
    /// not be published.
    pub const ACCOUNT_ATTEMPT_CANCELLED: &str = "account.attempt_cancelled";
    /// The attempt's environment and the verified identity's environment
    /// differ.
    pub const ACCOUNT_ENVIRONMENT_MISMATCH: &str = "account.environment_mismatch";
    /// A re-login targeted account X but the verified identity belongs to a
    /// different upstream `buid`. The target is left untouched.
    pub const ACCOUNT_IDENTITY_MISMATCH: &str = "account.identity_mismatch";
    /// The operation is not allowed in the account's current state.
    pub const ACCOUNT_INVALID_STATE: &str = "account.invalid_state";
    /// The context's generation is valid but the account is not online.
    pub const ACCOUNT_NOT_ONLINE: &str = "account.not_online";
    /// A credential update (e.g. a late `Set-Cookie`) claims to be based on a
    /// revision older than the committed one.
    pub const ACCOUNT_STALE_CREDENTIAL_REVISION: &str = "account.stale_credential_revision";
    /// Credential commit operation id unknown or in the wrong stage.
    pub const ACCOUNT_CREDENTIAL_OPERATION: &str = "account.credential_operation";
    /// Secret store refused the entry (too large, unavailable…). Never
    /// degrade to plaintext.
    pub const ACCOUNT_CREDENTIAL_STORE: &str = "account.credential_store";
    /// A persisted registry / ledger document could not be decoded.
    pub const ACCOUNT_RESTORE_CORRUPT: &str = "account.restore_corrupt";
    /// The requested ordering does not contain exactly the known accounts of
    /// that environment.
    pub const ACCOUNT_ORDER_INVALID: &str = "account.order_invalid";
}

pub(crate) fn err(code: &str, message: impl Into<String>) -> AppError {
    AppError::new(code, message)
}

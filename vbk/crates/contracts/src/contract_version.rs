//! Version of the IPC DTO and command contract, mirrored in ipc/contracts.ts.
use crate::AppError;

pub const CONTRACT_VERSION: u64 = 1;
pub const CONTRACT_VERSION_MISMATCH: &str = "contract.version_mismatch";

/// Every invocation must prove compatibility before its command is dispatched.
/// The host maps absent or non-integer JSON values to `None`.
pub fn validate_contract_version(version: Option<u64>) -> Result<(), AppError> {
    if version == Some(CONTRACT_VERSION) {
        Ok(())
    } else {
        Err(AppError::new(
            CONTRACT_VERSION_MISMATCH,
            "IPC contract version is missing or incompatible; reload the window",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_current_version_is_compatible() {
        assert!(validate_contract_version(Some(CONTRACT_VERSION)).is_ok());
        for version in [None, Some(0), Some(CONTRACT_VERSION + 1), Some(u64::MAX)] {
            let error = validate_contract_version(version).expect_err("incompatible version");
            assert_eq!(error.code, CONTRACT_VERSION_MISMATCH);
            assert!(!error.retryable);
        }
    }
}

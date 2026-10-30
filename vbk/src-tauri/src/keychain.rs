//! `SecretStore` backed by the OS credential store (macOS Keychain /
//! Windows Credential Manager) through the `keyring` crate.
//!
//! What goes in here is only the non-password marker the credential ledger
//! needs to know that an account's web profile was committed (profile id,
//! commit time). Cookies stay inside the WebView data store; passwords are
//! never seen by the host. Entry keys are the ledger's opaque refs
//! (`ticket:<env>:<account_id>:r<n>`), never a buid or a login name.

use contracts::AppError;
use core_account::{codes, CredentialRef, Secret, SecretStore, StagedRef};

/// Keychain service name (same as the bundle identifier).
pub const SERVICE: &str = "tech.tsim.vbk.client";

const STAGED_PREFIX: &str = "staged:";

fn store_err(op: &str, e: keyring::Error) -> AppError {
    // The keyring error text never contains the secret itself.
    AppError::new(
        codes::ACCOUNT_CREDENTIAL_STORE,
        format!("credential store {op} failed: {e}"),
    )
}

fn entry(user: &str) -> Result<keyring::Entry, AppError> {
    keyring::Entry::new(SERVICE, user).map_err(|e| store_err("open", e))
}

fn delete_quiet(user: &str) -> Result<(), AppError> {
    match entry(user)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(store_err("delete", e)),
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct KeychainStore;

impl KeychainStore {
    pub fn new() -> Self {
        Self
    }
}

impl SecretStore for KeychainStore {
    fn stage(&mut self, target: &CredentialRef, secret: &Secret) -> Result<StagedRef, AppError> {
        if secret.is_empty() || secret.len() > 2048 {
            return Err(AppError::new(
                codes::ACCOUNT_CREDENTIAL_STORE,
                format!("secret of {} bytes is not storable", secret.len()),
            ));
        }
        let handle = format!("{STAGED_PREFIX}{}", target.key);
        entry(&handle)?
            .set_secret(secret.expose())
            .map_err(|e| store_err("stage", e))?;
        Ok(StagedRef {
            target: target.clone(),
            handle,
        })
    }

    fn commit(&mut self, staged: &StagedRef) -> Result<(), AppError> {
        let staged_entry = entry(&staged.handle)?;
        match staged_entry.get_secret() {
            Ok(bytes) => {
                entry(&staged.target.key)?
                    .set_secret(&bytes)
                    .map_err(|e| store_err("commit", e))?;
                delete_quiet(&staged.handle)
            }
            Err(keyring::Error::NoEntry) if self.contains(&staged.target) => Ok(()),
            Err(keyring::Error::NoEntry) => Err(AppError::new(
                codes::ACCOUNT_CREDENTIAL_STORE,
                "staged entry missing",
            )),
            Err(e) => Err(store_err("read staged", e)),
        }
    }

    fn discard(&mut self, staged: &StagedRef) -> Result<(), AppError> {
        delete_quiet(&staged.handle)?;
        delete_quiet(&staged.target.key)
    }

    fn delete(&mut self, target: &CredentialRef) -> Result<(), AppError> {
        delete_quiet(&target.key)
    }

    fn contains(&self, target: &CredentialRef) -> bool {
        match entry(&target.key) {
            Ok(e) => e.get_secret().is_ok(),
            Err(_) => false,
        }
    }
}

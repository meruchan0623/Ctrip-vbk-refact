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
            Err(keyring::Error::NoEntry) => {
                if self.probe(&staged.target)? { Ok(()) }
                else { Err(AppError::new(codes::ACCOUNT_CREDENTIAL_STORE, "staged entry missing")) }
            },
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
        self.probe(target).unwrap_or(false)
    }

    fn probe(&self, target: &CredentialRef) -> Result<bool, AppError> {
        probe_marker(&target.key)
    }
}

#[cfg(target_os = "macos")]
fn probe_marker(account: &str) -> Result<bool, AppError> {
    use security_framework::item::{ItemClass, ItemSearchOptions};
    use security_framework::os::macos::keychain::{SecKeychain, SecPreferencesDomain};
    if account.is_empty() {
        return Err(AppError::new(codes::ACCOUNT_CREDENTIAL_STORE, "empty marker reference"));
    }
    // Match keyring's default User-domain keychain, never a broader search list.
    let keychain = SecKeychain::default_for_domain(SecPreferencesDomain::User)
        .map_err(|e| AppError::new(codes::ACCOUNT_CREDENTIAL_STORE, format!("marker keychain unavailable ({})", e.code())))?;
    // Existence needs metadata only. Do not read the protected marker bytes or
    // skip authenticated items (which would confuse unavailable with missing).
    let result = ItemSearchOptions::new()
        .keychains(&[keychain])
        .class(ItemClass::generic_password())
        .service(SERVICE)
        .account(account)
        .case_insensitive(Some(false))
        .load_attributes(true)
        .load_data(false)
        .load_refs(false)
        .limit(1)
        .search();
    classify_marker_search(result.map(|items| items.len()).map_err(|e| e.code()))
}

#[cfg(target_os = "macos")]
fn classify_marker_search(result: Result<usize, i32>) -> Result<bool, AppError> {
    match result {
        Ok(0) => Err(AppError::new(codes::ACCOUNT_CREDENTIAL_STORE, "marker metadata returned no result")),
        Ok(_) => Ok(true),
        Err(-25300) => Ok(false),
        Err(code) => Err(AppError::new(codes::ACCOUNT_CREDENTIAL_STORE, format!("marker metadata unavailable ({code})"))),
    }
}

#[cfg(not(target_os = "macos"))]
fn probe_marker(account: &str) -> Result<bool, AppError> {
    match entry(account)?.get_secret() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(store_err("probe", e)),
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::classify_marker_search;

    #[test]
    fn only_explicit_not_found_means_missing_marker() {
        assert_eq!(classify_marker_search(Ok(1)).unwrap(), true);
        assert_eq!(classify_marker_search(Err(-25300)).unwrap(), false);
        assert!(classify_marker_search(Err(-25293)).is_err());
        assert!(classify_marker_search(Ok(0)).is_err());
    }
}

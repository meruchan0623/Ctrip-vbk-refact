//! Two protected slots keep browser-borrowed sessions out of older binaries'
//! owned-session slot. Slot errors never fall back to another identity.
use super::service;
use contracts::{codes, AppError};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Slot {
    Owned,
    Imported,
}
impl Slot {
    fn account(self) -> &'static str {
        match self {
            Self::Owned => "session",
            Self::Imported => "imported-session",
        }
    }
    fn other(self) -> Self {
        match self {
            Self::Owned => Self::Imported,
            Self::Imported => Self::Owned,
        }
    }
}
fn selected(raw: &str) -> Result<Slot, AppError> {
    service::stored_is_borrowed(raw).map(|shared| if shared { Slot::Imported } else { Slot::Owned })
}
pub trait Backend {
    fn read(&self, slot: Slot) -> Result<Option<String>, AppError>;
    fn write(&self, slot: Slot, value: &str) -> Result<(), AppError>;
    fn delete(&self, slot: Slot) -> Result<(), AppError>;
}
pub struct Storage<B>(pub B);
impl<B: Backend> Storage<B> {
    pub fn load(&self) -> Result<Option<String>, AppError> {
        if let Some(value) = self.0.read(Slot::Imported)? {
            if selected(&value)? != Slot::Imported {
                return Err(AppError::new(
                    codes::STORE_CORRUPT,
                    "assistant session slot mismatch",
                ));
            }
            return Ok(Some(value));
        }
        let value = self.0.read(Slot::Owned)?;
        if let Some(value) = value.as_ref() {
            if selected(value)? != Slot::Owned {
                return Err(AppError::new(
                    codes::STORE_CORRUPT,
                    "assistant session slot mismatch",
                ));
            }
        }
        Ok(value)
    }
    pub fn save(&self, value: &str) -> Result<(), AppError> {
        let slot = selected(value)?;
        self.0.delete(slot.other())?;
        self.0.write(slot, value)
    }
    pub fn clear(&self) -> Result<(), AppError> {
        let owned = self.0.delete(Slot::Owned);
        let imported = self.0.delete(Slot::Imported);
        owned.and(imported)
    }
}
pub struct KeyringBackend;
impl KeyringBackend {
    fn entry(slot: Slot) -> Result<keyring::Entry, AppError> {
        keyring::Entry::new(super::KEYRING_SERVICE, slot.account()).map_err(super::keyring_error)
    }
}
impl Backend for KeyringBackend {
    fn read(&self, slot: Slot) -> Result<Option<String>, AppError> {
        match Self::entry(slot)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(super::keyring_error(e)),
        }
    }
    fn write(&self, slot: Slot, value: &str) -> Result<(), AppError> {
        Self::entry(slot)?
            .set_password(value)
            .map_err(super::keyring_error)
    }
    fn delete(&self, slot: Slot) -> Result<(), AppError> {
        match Self::entry(slot)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(super::keyring_error(e)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::BTreeMap,
        sync::{Arc, Mutex},
    };
    #[derive(Clone, Default)]
    struct Memory {
        values: Arc<Mutex<BTreeMap<Slot, String>>>,
        operations: Arc<Mutex<Vec<(&'static str, Slot)>>>,
        fail: Arc<Mutex<Option<(&'static str, Slot)>>>,
    }
    impl Memory {
        fn action(&self, op: &'static str, slot: Slot) -> Result<(), AppError> {
            self.operations.lock().unwrap().push((op, slot));
            if *self.fail.lock().unwrap() == Some((op, slot)) {
                Err(AppError::new(codes::STORE_IO, "synthetic storage failure"))
            } else {
                Ok(())
            }
        }
    }
    impl Backend for Memory {
        fn read(&self, slot: Slot) -> Result<Option<String>, AppError> {
            self.action("read", slot)?;
            Ok(self.values.lock().unwrap().get(&slot).cloned())
        }
        fn write(&self, slot: Slot, value: &str) -> Result<(), AppError> {
            self.action("write", slot)?;
            self.values.lock().unwrap().insert(slot, value.into());
            Ok(())
        }
        fn delete(&self, slot: Slot) -> Result<(), AppError> {
            self.action("delete", slot)?;
            self.values.lock().unwrap().remove(&slot);
            Ok(())
        }
    }
    fn stored(shared: bool) -> String {
        serde_json::json!({"borrowed_session":shared,"user":"synthetic-user","access_token":"SYNTHETIC_TOKEN","session_ref":"synthetic-ref","expires_at_ms":null,"issued_at_ms":1000}).to_string()
    }
    impl crate::assistant::service::Vault for Storage<Memory> {
        fn load(&self) -> Result<Option<String>, AppError> {
            Storage::load(self)
        }
        fn save(&self, value: &str) -> Result<(), AppError> {
            Storage::save(self, value)
        }
        fn clear(&self) -> Result<(), AppError> {
            Storage::clear(self)
        }
    }
    struct NoHttp;
    impl crate::assistant::http::Executor for NoHttp {
        async fn execute(
            &self,
            _: &core_assistant::TsimRequest,
        ) -> Result<crate::assistant::http::HttpResponse, AppError> {
            panic!("restore must not do hidden HTTP");
        }
    }
    #[test]
    fn service_restore_with_damaged_imported_slot_never_reports_the_valid_owned_identity_as_logged_in(
    ) {
        let memory = Memory::default();
        memory
            .values
            .lock()
            .unwrap()
            .insert(Slot::Imported, "damaged-imported-credential".into());
        memory
            .values
            .lock()
            .unwrap()
            .insert(Slot::Owned, stored(false));
        let service = crate::assistant::service::Service::new(
            NoHttp,
            Storage(memory.clone()),
            Box::new(|| 1000),
        );
        service.restore();
        let status = service.status();
        assert!(!status.logged_in && status.user.is_none());
        assert_eq!(
            *memory.operations.lock().unwrap(),
            [("read", Slot::Imported)]
        );
    }

    #[test]
    fn imported_tokens_never_enter_the_old_binary_slot_and_restore_uses_only_the_correct_slot() {
        let memory = Memory::default();
        let storage = Storage(memory.clone());
        memory
            .values
            .lock()
            .unwrap()
            .insert(Slot::Owned, stored(false));
        let value = stored(true);
        storage.save(&value).unwrap();
        assert_eq!(
            *memory.operations.lock().unwrap(),
            [("delete", Slot::Owned), ("write", Slot::Imported)]
        );
        assert!(
            memory.read(Slot::Owned).unwrap().is_none(),
            "an old binary only reads this owned slot"
        );
        memory.operations.lock().unwrap().clear();
        assert_eq!(storage.load().unwrap(), Some(value));
        assert_eq!(
            *memory.operations.lock().unwrap(),
            [("read", Slot::Imported)]
        );
        assert_ne!(Slot::Owned.account(), Slot::Imported.account());
    }
    #[test]
    fn damaged_or_mislabelled_imported_credentials_never_fall_back_to_an_owned_identity() {
        for damaged in ["not-json".to_string(), stored(false)] {
            let memory = Memory::default();
            memory
                .values
                .lock()
                .unwrap()
                .insert(Slot::Imported, damaged);
            memory
                .values
                .lock()
                .unwrap()
                .insert(Slot::Owned, stored(false));
            assert!(Storage(memory.clone()).load().is_err());
            assert_eq!(
                *memory.operations.lock().unwrap(),
                [("read", Slot::Imported)]
            );
        }
        let memory = Memory::default();
        memory
            .values
            .lock()
            .unwrap()
            .insert(Slot::Owned, stored(true));
        assert!(Storage(memory).load().is_err());
    }
    #[test]
    fn slot_io_failures_are_visible_and_both_clear_attempts_run_without_silent_switching() {
        let memory = Memory::default();
        *memory.fail.lock().unwrap() = Some(("delete", Slot::Owned));
        let storage = Storage(memory.clone());
        assert!(storage.save(&stored(true)).is_err());
        assert_eq!(
            *memory.operations.lock().unwrap(),
            [("delete", Slot::Owned)]
        );
        memory
            .values
            .lock()
            .unwrap()
            .insert(Slot::Imported, stored(true));
        memory.operations.lock().unwrap().clear();
        assert!(storage.clear().is_err());
        assert!(!memory.values.lock().unwrap().contains_key(&Slot::Imported));
        assert_eq!(
            *memory.operations.lock().unwrap(),
            [("delete", Slot::Owned), ("delete", Slot::Imported)]
        );
        *memory.fail.lock().unwrap() = Some(("write", Slot::Imported));
        memory.operations.lock().unwrap().clear();
        assert!(storage.save(&stored(true)).is_err());
        assert!(memory.values.lock().unwrap().is_empty());
    }
}

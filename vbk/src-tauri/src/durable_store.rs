//! Host stores share the no-follow namespace backend without changing layout.
//! The root itself is trusted application storage; this is not an inode-lock
//! protocol against a same-user actor replacing arbitrary regular root entries.
use std::{path::PathBuf, sync::Arc};

use contracts::AppError;
use core_store::FileStore;

pub(crate) struct BoundStore {
    pub(crate) store: FileStore,
    pub(crate) namespace_io: Arc<crate::attachment_leases::SafeNamespaceIo>,
}

pub(crate) fn open(root: impl Into<PathBuf>) -> Result<BoundStore, AppError> {
    let store = FileStore::open(root)?;
    let namespace_io = Arc::new(crate::attachment_leases::SafeNamespaceIo::new(
        store.root(),
    )?);
    Ok(BoundStore {
        store: store.with_namespace_io(namespace_io.clone()),
        namespace_io,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use contracts::{json::JsonValue, AccountId, Environment};
    use core_store::{Namespace, Store};
    use std::fs;

    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("vbk-bound-store-{}", uuid::Uuid::new_v4())))
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn ns() -> Namespace {
        Namespace::new(Environment::named("test"), AccountId::new("legacy-account"))
    }
    fn put(store: &FileStore, value: &str) {
        let mut txn = store.begin(&ns()).unwrap();
        txn.put("drafts", "kept", JsonValue::string(value));
        store.commit(txn).unwrap();
    }
    #[test]
    fn existing_layout_and_logout_marker_are_readable_without_migration() {
        let root = Temp::new();
        let legacy = FileStore::open(&root.0).unwrap();
        put(&legacy, "old draft");
        legacy.logout_lock(&ns()).unwrap();
        let path = legacy.namespace_dir(&ns()).join("state.json");
        let original = fs::read(&path).unwrap();
        drop(legacy);
        let bound = open(&root.0).unwrap();
        assert_eq!(fs::read(&path).unwrap(), original);
        assert!(bound.store.is_locked(&ns()).unwrap());
        assert!(bound.store.begin(&ns()).is_err());
        assert_eq!(
            bound.store.get(&ns(), "drafts", "kept").unwrap(),
            Some(JsonValue::string("old draft"))
        );
        bound.store.unlock_after_reauth(&ns()).unwrap();
        put(&bound.store, "new draft");
        bound.store.logout_lock(&ns()).unwrap();
        assert!(bound.store.begin(&ns()).is_err());
        bound.store.unlock_after_reauth(&ns()).unwrap();
        let legacy_reader = FileStore::open(&root.0).unwrap();
        assert_eq!(
            legacy_reader.get(&ns(), "drafts", "kept").unwrap(),
            Some(JsonValue::string("new draft"))
        );
    }
    #[test]
    fn corruption_is_quarantined_and_acknowledgement_keeps_original_evidence() {
        let root = Temp::new();
        let bound = open(&root.0).unwrap();
        put(&bound.store, "old draft");
        let damaged = b"{partial document";
        fs::write(bound.store.namespace_dir(&ns()).join("state.json"), damaged).unwrap();
        assert!(bound.store.get(&ns(), "drafts", "kept").is_err());
        let evidence = bound.store.quarantined_files(&ns()).unwrap();
        assert_eq!(evidence.len(), 1);
        assert_eq!(fs::read(&evidence[0]).unwrap(), damaged);
        drop(bound);
        let reopened = open(&root.0).unwrap();
        assert!(reopened.store.begin(&ns()).is_err());
        assert_eq!(
            reopened.store.acknowledge_corruption(&ns()).unwrap(),
            evidence
        );
        assert_eq!(fs::read(&evidence[0]).unwrap(), damaged);
        put(&reopened.store, "after acknowledgement");
        assert_eq!(fs::read(&evidence[0]).unwrap(), damaged);
    }
    #[cfg(unix)]
    #[test]
    fn redirected_namespace_state_and_quarantine_are_rejected_without_touching_targets() {
        use std::os::unix::fs::symlink;
        for kind in ["namespace", "state", "quarantine"] {
            let root = Temp::new();
            let outside = Temp::new();
            fs::create_dir_all(&outside.0).unwrap();
            let target = outside.0.join("state.json");
            let sentinel = b"external evidence";
            fs::write(&target, sentinel).unwrap();
            let bound = open(&root.0).unwrap();
            let dir = bound.store.namespace_dir(&ns());
            if kind == "namespace" {
                fs::create_dir_all(dir.parent().unwrap()).unwrap();
                symlink(&outside.0, &dir).unwrap();
            } else {
                put(&bound.store, "initial");
                if kind == "state" {
                    fs::remove_file(dir.join("state.json")).unwrap();
                    symlink(&target, dir.join("state.json")).unwrap();
                } else {
                    fs::write(dir.join("state.json"), b"{damaged").unwrap();
                    symlink(&outside.0, dir.join("quarantine")).unwrap();
                }
            }
            assert!(bound.store.get(&ns(), "drafts", "kept").is_err(), "{kind}");
            assert!(bound.store.begin(&ns()).is_err(), "{kind}");
            if kind == "namespace" {
                assert!(bound.store.logout_lock(&ns()).is_err());
                assert!(bound.store.unlock_after_reauth(&ns()).is_err());
            }
            if kind == "quarantine" {
                assert!(bound.store.acknowledge_corruption(&ns()).is_err());
                assert_eq!(fs::read(dir.join("state.json")).unwrap(), b"{damaged");
            }
            assert_eq!(fs::read(&target).unwrap(), sentinel);
            assert_eq!(fs::read_dir(&outside.0).unwrap().count(), 1);
        }
    }
    #[cfg(unix)]
    #[test]
    fn new_state_logout_and_ack_files_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let root = Temp::new();
        let bound = open(&root.0).unwrap();
        put(&bound.store, "private");
        bound.store.logout_lock(&ns()).unwrap();
        let dir = bound.store.namespace_dir(&ns());
        for name in ["state.json", "logout.lock"] {
            assert_eq!(
                fs::metadata(dir.join(name)).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        bound.store.unlock_after_reauth(&ns()).unwrap();
        fs::write(dir.join("state.json"), b"{broken").unwrap();
        assert!(bound.store.get(&ns(), "drafts", "kept").is_err());
        bound.store.acknowledge_corruption(&ns()).unwrap();
        assert_eq!(
            fs::metadata(dir.join("corrupt.acknowledged"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        for evidence in bound.store.quarantined_files(&ns()).unwrap() {
            assert_eq!(
                fs::metadata(evidence).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
}

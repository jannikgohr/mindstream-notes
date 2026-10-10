use super::*;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey};

fn material(username: &str, seed: u8) -> Material {
    let key = p256::SecretKey::from_slice(&[seed; 32]).unwrap();
    Material {
        username: username.into(),
        public_key_b64: STANDARD.encode(key.public_key().to_public_key_der().unwrap().as_bytes()),
        private_key_pkcs8_b64: STANDARD.encode(key.to_pkcs8_der().unwrap().as_bytes()),
    }
}
fn entry() -> Entry {
    Entry::new_with_credential(std::sync::Arc::new(keyring_core::mock::Cred {
        specifiers: (
            "disposable-test-service".into(),
            "disposable-test-vault".into(),
        ),
        inner: Mutex::new(std::cell::RefCell::new(Default::default())),
    }))
}
fn root() -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!("ms-signing-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    root
}

#[test]
fn webcrypto_pkcs8_material_is_imported_without_changing_the_signing_identity() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("webcrypto-fixture.json")).unwrap();
    let material: Material = serde_json::from_value(fixture["material"].clone()).unwrap();
    material.validate().unwrap();
    let expected_public = material.public_key_b64.clone();
    let expected_private = material.private_key_pkcs8_b64.clone();
    let username = material.username.clone();
    let root = root();
    let path = root.join(FILE_NAME);
    let entry = entry();
    let aad = associated_data("test", "webcrypto-vault");
    access_file(
        &path,
        &entry,
        &aad,
        "https://disposable.example/",
        &username,
        Some(material),
    )
    .unwrap();
    let restored = access_file(
        &path,
        &entry,
        &aad,
        "https://disposable.example/",
        &username,
        None,
    )
    .unwrap()
    .unwrap();
    assert_eq!(restored.public_key_b64, expected_public);
    assert_eq!(restored.private_key_pkcs8_b64, expected_private);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn encrypted_material_round_trips_and_rejects_other_vault_environment_or_key() {
    let material = material("alice", 7);
    let private = material.private_key_pkcs8_b64.clone();
    let mut materials = Materials::new();
    let id = account_id("https://one/", "alice");
    materials.insert(id.clone(), material);
    let aad = associated_data("release", "one");
    let raw = encrypt(&materials, &[9; 32], &aad).unwrap();
    assert!(!String::from_utf8(raw.clone()).unwrap().contains(&private));
    assert_eq!(
        decrypt(&raw, &[9; 32], &aad).unwrap()[&id].private_key_pkcs8_b64,
        private
    );
    assert!(decrypt(&raw, &[8; 32], &aad).is_err());
    assert!(decrypt(&raw, &[9; 32], &associated_data("release", "two")).is_err());
    assert!(decrypt(&raw, &[9; 32], &associated_data("dev", "one")).is_err());
    let mut envelope: Envelope = serde_json::from_slice(&raw).unwrap();
    let mut ciphertext = STANDARD.decode(&envelope.ciphertext).unwrap();
    ciphertext[0] ^= 1;
    envelope.ciphertext = STANDARD.encode(ciphertext);
    assert!(decrypt(&serde_json::to_vec(&envelope).unwrap(), &[9; 32], &aad).is_err());
}

#[test]
fn keypair_and_account_identity_validation_prevent_mixed_material() {
    let mut mixed = material("alice", 3);
    mixed.private_key_pkcs8_b64 = material("alice", 4).private_key_pkcs8_b64.clone();
    assert!(mixed.validate().is_err());
    assert_ne!(
        account_id("https://one/", "alice"),
        account_id("https://two/", "alice")
    );
    assert_ne!(
        account_id("https://one/", "alice"),
        account_id("https://one/", "bob")
    );
    assert_ne!(account_id("a", "bc"), account_id("ab", "c"));
    assert_ne!(keyring_account("one"), keyring_account("two"));
}

#[test]
fn racing_note_windows_keep_one_identity_and_account_keys_are_separate() {
    let root = root();
    let path = root.join(FILE_NAME);
    let entry = entry();
    let aad = associated_data("test", "vault");
    let (first, second) = std::thread::scope(|scope| {
        let first = scope.spawn(|| {
            access_file(
                &path,
                &entry,
                &aad,
                "https://one/",
                "alice",
                Some(material("alice", 3)),
            )
            .unwrap()
            .unwrap()
        });
        let second = scope.spawn(|| {
            access_file(
                &path,
                &entry,
                &aad,
                "https://one/",
                "alice",
                Some(material("alice", 4)),
            )
            .unwrap()
            .unwrap()
        });
        (first.join().unwrap(), second.join().unwrap())
    });
    assert_eq!(first.public_key_b64, second.public_key_b64);
    let master = entry.get_password().unwrap();
    let bob = access_file(
        &path,
        &entry,
        &aad,
        "https://one/",
        "bob",
        Some(material("bob", 5)),
    )
    .unwrap()
    .unwrap();
    let elsewhere = access_file(
        &path,
        &entry,
        &aad,
        "https://two/",
        "alice",
        Some(material("alice", 6)),
    )
    .unwrap()
    .unwrap();
    assert_ne!(first.public_key_b64, bob.public_key_b64);
    assert_ne!(first.public_key_b64, elsewhere.public_key_b64);
    assert_eq!(entry.get_password().unwrap(), master);
    assert_eq!(
        access_file(&path, &entry, &aad, "https://one/", "alice", None)
            .unwrap()
            .unwrap()
            .public_key_b64,
        first.public_key_b64
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn missing_keystore_key_and_corrupt_files_never_regenerate_identity() {
    let root = root();
    let path = root.join(FILE_NAME);
    let entry = entry();
    let aad = associated_data("test", "vault");
    access_file(
        &path,
        &entry,
        &aad,
        "https://one/",
        "alice",
        Some(material("alice", 3)),
    )
    .unwrap();
    let raw = fs::read(&path).unwrap();
    entry.delete_credential().unwrap();
    assert!(access_file(
        &path,
        &entry,
        &aad,
        "https://one/",
        "alice",
        Some(material("alice", 4))
    )
    .is_err());
    assert!(matches!(
        entry.get_password(),
        Err(keyring_core::Error::NoEntry)
    ));
    assert_eq!(fs::read(&path).unwrap(), raw);
    entry.set_password(&STANDARD.encode([9; 32])).unwrap();
    fs::write(&path, b"corrupt credential envelope").unwrap();
    assert!(access_file(
        &path,
        &entry,
        &aad,
        "https://one/",
        "alice",
        Some(material("alice", 4))
    )
    .is_err());
    assert_eq!(fs::read(&path).unwrap(), b"corrupt credential envelope");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn failed_keystore_access_does_not_create_files_or_replace_migration_inputs() {
    let root = root();
    let path = root.join(FILE_NAME);
    let entry = entry();
    let mock = entry
        .as_any()
        .downcast_ref::<keyring_core::mock::Cred>()
        .unwrap();
    mock.set_error(keyring_core::Error::Invalid(
        "test".into(),
        "unavailable".into(),
    ));
    assert!(access_file(
        &path,
        &entry,
        b"test",
        "https://one/",
        "alice",
        Some(material("alice", 3))
    )
    .is_err());
    assert!(!path.exists());
    assert!(matches!(
        entry.get_password(),
        Err(keyring_core::Error::NoEntry)
    ));
    fs::remove_dir_all(root).unwrap();
}

#[cfg(target_os = "windows")]
#[test]
#[ignore = "uses disposable Windows Credential Manager entries; run explicitly on a desktop"]
fn native_windows_keystore_retains_identity_across_store_reopen_and_isolates_vaults() {
    use keyring_core::api::CredentialStoreApi;
    struct Cleanup(Entry);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = self.0.delete_credential();
        }
    }
    let root = root();
    let service = format!("mindstream-notes-Test-{}", uuid::Uuid::new_v4());
    let store = windows_native_keyring_store::Store::new().unwrap();
    let first = Cleanup(
        store
            .build(&service, &keyring_account("one"), None)
            .unwrap(),
    );
    let second = Cleanup(
        store
            .build(&service, &keyring_account("two"), None)
            .unwrap(),
    );
    let first_path = root.join("one.json");
    let second_path = root.join("two.json");
    let first_aad = associated_data(&service, "one");
    let second_aad = associated_data(&service, "two");
    let first_material = access_file(
        &first_path,
        &first.0,
        &first_aad,
        "https://disposable.example/",
        "test-user",
        Some(material("test-user", 3)),
    )
    .unwrap()
    .unwrap();
    let second_material = access_file(
        &second_path,
        &second.0,
        &second_aad,
        "https://disposable.example/",
        "test-user",
        Some(material("test-user", 4)),
    )
    .unwrap()
    .unwrap();
    assert_ne!(
        first_material.public_key_b64,
        second_material.public_key_b64
    );
    let reopened_store = windows_native_keyring_store::Store::new().unwrap();
    let reopened = reopened_store
        .build(&service, &keyring_account("one"), None)
        .unwrap();
    assert_eq!(
        access_file(
            &first_path,
            &reopened,
            &first_aad,
            "https://disposable.example/",
            "test-user",
            None
        )
        .unwrap()
        .unwrap()
        .public_key_b64,
        first_material.public_key_b64
    );
    assert!(access_file(
        &first_path,
        &second.0,
        &second_aad,
        "https://disposable.example/",
        "test-user",
        None
    )
    .is_err());
    drop(reopened);
    drop(first);
    drop(second);
    fs::remove_dir_all(root).unwrap();
}

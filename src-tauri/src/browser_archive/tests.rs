use super::*;
use std::cell::RefCell;
use std::sync::Mutex;

const ORIGIN: &str = "http://localhost:1420";
struct Fixture {
    root: std::path::PathBuf,
    entry: Entry,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("ms-browser-export-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let entry = Entry::new_with_credential(std::sync::Arc::new(keyring_core::mock::Cred {
            specifiers: ("disposable-service".into(), "disposable-export".into()),
            inner: Mutex::new(RefCell::new(Default::default())),
        }));
        Self { root, entry }
    }
    fn capture(&self, origin: &str, values: Values) -> AppResult<Status> {
        capture_file(
            &self.root,
            &self.entry,
            b"test environment and canonical root",
            origin,
            "default",
            values,
        )
    }
    fn seal(&self, origin: &str, checksum: &str) -> AppResult<Status> {
        seal_file(
            &self.root,
            &self.entry,
            b"test environment and canonical root",
            origin,
            checksum,
        )
    }
    fn load(&self, origin: &str) -> AppResult<Option<Snapshot>> {
        load_file(
            &self.root,
            &self.entry,
            b"test environment and canonical root",
            origin,
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn values() -> Values {
    BTreeMap::from([
        (
            "mindstream:collab-signing-key:v1:unopened-account".into(),
            "synthetic-private-credential".into(),
        ),
        (
            "notes-app:settings:v1:vault:other".into(),
            "malformed raw JSON retained exactly".into(),
        ),
        (
            "unknown.plugin.store".into(),
            "unclassified evidence".into(),
        ),
    ])
}

#[test]
fn startup_seals_the_saved_capture_after_interruption_and_never_recaptures() {
    let fixture = Fixture::new();
    let aad = b"test environment and canonical root";
    assert!(!resume_export_file(&fixture.root, &fixture.entry, aad, ORIGIN).unwrap());
    let raw = values();
    fixture.capture(ORIGIN, raw.clone()).unwrap();
    assert!(fixture.load(ORIGIN).is_err());
    assert!(resume_export_file(&fixture.root, &fixture.entry, aad, ORIGIN).unwrap());
    assert_eq!(fixture.load(ORIGIN).unwrap().unwrap().values, raw);
    assert!(fixture.capture(ORIGIN, Values::new()).is_err());
    assert!(resume_export_file(&fixture.root, &fixture.entry, aad, ORIGIN).unwrap());
    assert!(
        !resume_export_file(&fixture.root, &fixture.entry, aad, "http://tauri.localhost").unwrap()
    );
}

#[test]
fn preserves_raw_unknown_credentials_and_origin_then_seals_against_changes() {
    let fixture = Fixture::new();
    let status = fixture.capture(ORIGIN, values()).unwrap();
    assert_eq!(status.revision, 1);
    assert!(!status.sealed);
    let raw = fs::read(fixture.root.join(FILE)).unwrap();
    let text = String::from_utf8(raw.clone()).unwrap();
    for value in values().values() {
        assert!(!text.contains(value));
    }
    assert!(fixture.load(ORIGIN).is_err());
    fixture.seal(ORIGIN, &status.checksum).unwrap();
    let snapshot = fixture.load(ORIGIN).unwrap().unwrap();
    assert_eq!(snapshot.values, values());
    assert_eq!(snapshot.origin, ORIGIN);
    assert_eq!(snapshot.vault_id, "default");
    assert!(fixture.capture(ORIGIN, Values::new()).is_err());
    assert_eq!(fs::read(fixture.root.join(FILE)).unwrap(), raw);
    let retry = fixture.capture(ORIGIN, values()).unwrap();
    assert!(retry.sealed);
    assert_eq!(retry.revision, 1);
    assert_eq!(fixture.seal(ORIGIN, &status.checksum).unwrap().revision, 1);
}

#[test]
fn pre_export_key_and_unsealed_capture_resume_without_regeneration() {
    let fixture = Fixture::new();
    let before = master(&fixture.entry, true).unwrap();
    let initial = fixture.capture(ORIGIN, Values::new()).unwrap();
    let final_capture = fixture.capture(ORIGIN, values()).unwrap();
    assert_eq!(final_capture.revision, initial.revision + 1);
    assert_eq!(
        before.as_slice(),
        master(&fixture.entry, false).unwrap().as_slice()
    );
    assert!(fixture.seal(ORIGIN, &initial.checksum).is_err());
    fixture.seal(ORIGIN, &final_capture.checksum).unwrap();
    assert_eq!(fixture.load(ORIGIN).unwrap().unwrap().values, values());
}

#[test]
fn separate_origins_survive_other_exports_and_cannot_change_owner() {
    let fixture = Fixture::new();
    let dev = fixture.capture(ORIGIN, values()).unwrap();
    fixture.seal(ORIGIN, &dev.checksum).unwrap();
    let release_values = BTreeMap::from([("source".into(), "packaged origin".into())]);
    let release = fixture
        .capture("http://tauri.localhost", release_values.clone())
        .unwrap();
    fixture
        .seal("http://tauri.localhost", &release.checksum)
        .unwrap();
    assert_eq!(fixture.load(ORIGIN).unwrap().unwrap().values, values());
    assert_eq!(
        fixture
            .load("http://tauri.localhost")
            .unwrap()
            .unwrap()
            .values,
        release_values
    );
    assert!(capture_file(
        &fixture.root,
        &fixture.entry,
        b"test environment and canonical root",
        ORIGIN,
        "other",
        values()
    )
    .is_err());
    assert!(fixture.load("https://tauri.localhost").unwrap().is_none());
}

#[test]
fn encrypted_payload_rejects_wrong_key_environment_root_and_tampering() {
    let fixture = Fixture::new();
    fixture.capture(ORIGIN, values()).unwrap();
    let key = master(&fixture.entry, false).unwrap();
    let raw = fs::read(fixture.root.join(FILE)).unwrap();
    assert!(decrypt(
        &raw,
        &[1; 32],
        b"test environment and canonical root",
        &BTreeMap::new()
    )
    .is_err());
    assert!(decrypt(
        &raw,
        &key,
        b"different environment or canonical root",
        &BTreeMap::new()
    )
    .is_err());
    let mut envelope: Envelope = serde_json::from_slice(&raw).unwrap();
    let mut bytes = STANDARD.decode(&envelope.ciphertext).unwrap();
    bytes[0] ^= 1;
    envelope.ciphertext = STANDARD.encode(bytes);
    let changed = serde_json::to_vec(&envelope).unwrap();
    assert!(decrypt(
        &changed,
        &key,
        b"test environment and canonical root",
        &BTreeMap::new()
    )
    .is_err());
}

#[test]
fn missing_key_or_archive_after_sealing_cannot_be_recreated_from_browser() {
    let fixture = Fixture::new();
    assert!(fixture.load(ORIGIN).unwrap().is_none());
    assert!(matches!(
        fixture.entry.get_password(),
        Err(keyring_core::Error::NoEntry)
    ));
    let status = fixture.capture(ORIGIN, values()).unwrap();
    fixture.seal(ORIGIN, &status.checksum).unwrap();
    let raw = fs::read(fixture.root.join(FILE)).unwrap();
    fixture.entry.delete_credential().unwrap();
    assert!(fixture.load(ORIGIN).is_err());
    assert!(fixture.capture(ORIGIN, Values::new()).is_err());
    assert!(matches!(
        fixture.entry.get_password(),
        Err(keyring_core::Error::NoEntry)
    ));
    assert_eq!(fs::read(fixture.root.join(FILE)).unwrap(), raw);
    fs::remove_file(fixture.root.join(FILE)).unwrap();
    assert!(fixture.capture(ORIGIN, values()).is_err());
    assert!(fixture.load(ORIGIN).is_err());
}

#[test]
fn recovery_copy_must_contain_every_sealed_capture() {
    let fixture = Fixture::new();
    let first = fixture.capture(ORIGIN, values()).unwrap();
    fixture.seal(ORIGIN, &first.checksum).unwrap();
    fixture
        .capture("http://tauri.localhost", Values::new())
        .unwrap();
    // Previous bytes still contain the sealed origin, so recovery is safe.
    fs::write(fixture.root.join(FILE), b"corrupt ciphertext retained").unwrap();
    assert_eq!(fixture.load(ORIGIN).unwrap().unwrap().values, values());
    assert!(fs::read_dir(&fixture.root).unwrap().any(|entry| entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .contains(".corrupt-")));
    let next = fixture
        .capture("http://tauri.localhost", Values::new())
        .unwrap();
    fixture
        .seal("http://tauri.localhost", &next.checksum)
        .unwrap();
    // Its previous copy lacks the newly sealed origin. It must be refused,
    // leaving corrupt current bytes untouched rather than reseeding from defaults.
    fs::write(fixture.root.join(FILE), b"second corruption").unwrap();
    assert!(fixture.load(ORIGIN).is_err());
    assert_eq!(
        fs::read(fixture.root.join(FILE)).unwrap(),
        b"second corruption"
    );
}

#[test]
fn invalid_capture_and_receipt_are_retained_without_publishing_defaults() {
    let fixture = Fixture::new();
    assert!(fixture
        .capture("https://third-party.example", values())
        .is_err());
    assert!(!fixture.root.join(FILE).exists());
    let status = fixture.capture(ORIGIN, values()).unwrap();
    fixture.seal(ORIGIN, &status.checksum).unwrap();
    fs::write(
        seal_path(&fixture.root, ORIGIN),
        b"invalid completion receipt",
    )
    .unwrap();
    assert!(fixture.load(ORIGIN).is_err());
    assert!(fixture.capture(ORIGIN, Values::new()).is_err());
    assert_eq!(
        fs::read(seal_path(&fixture.root, ORIGIN)).unwrap(),
        b"invalid completion receipt"
    );
}

#[cfg(target_os = "windows")]
#[test]
#[ignore = "writes disposable entries to Windows Credential Manager"]
fn native_keystore_export_reopens_without_exposing_credentials() {
    use keyring_core::api::CredentialStoreApi;
    struct Cleanup(Entry);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = self.0.delete_credential();
        }
    }
    let fixture = Fixture::new();
    let service = format!(
        "mindstream-disposable-browser-export-{}",
        uuid::Uuid::new_v4()
    );
    let store = windows_native_keyring_store::Store::new().unwrap();
    let entry = Cleanup(store.build(&service, "archive", None).unwrap());
    let status = capture_file(
        &fixture.root,
        &entry.0,
        service.as_bytes(),
        ORIGIN,
        "default",
        values(),
    )
    .unwrap();
    seal_file(
        &fixture.root,
        &entry.0,
        service.as_bytes(),
        ORIGIN,
        &status.checksum,
    )
    .unwrap();
    let reopened_store = windows_native_keyring_store::Store::new().unwrap();
    let reopened = reopened_store.build(&service, "archive", None).unwrap();
    assert_eq!(
        load_file(&fixture.root, &reopened, service.as_bytes(), ORIGIN)
            .unwrap()
            .unwrap()
            .values,
        values()
    );
    let ciphertext = String::from_utf8(fs::read(fixture.root.join(FILE)).unwrap()).unwrap();
    assert!(!ciphertext.contains("synthetic-private-credential"));
}

#[test]
fn development_origins_allow_configured_loopback_ports_without_remote_or_credential_origins() {
    for origin in [
        "http://localhost:1420",
        "http://127.0.0.1:1421",
        "http://[::1]:1430",
    ] {
        assert!(super::valid_origin(origin), "{origin}");
    }
    for origin in [
        "http://localhost",
        "http://localhost:0",
        "https://localhost:1420",
        "http://example.com:1420",
        "http://localhost.example.com:1420",
        "http://user@localhost:1420",
        "http://localhost:1420/notes",
        "http://localhost:1420?secret=1",
        "http://localhost:1420#fragment",
    ] {
        assert!(!super::valid_origin(origin), "{origin}");
    }
}

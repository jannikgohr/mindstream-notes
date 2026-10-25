use super::restore::{
    apply_pending_restore_with_root, restore_file_hash, stage_restore_at, RestoreOperation,
    RestorePhase,
};
use super::staging::stage_import_at;
use super::*;
use crate::storage_locks::RootLock;
use serde_json::json;

const ID: &str = "com.test.portable";
struct Fixture {
    directory: PathBuf,
    root: PathBuf,
    vault: PathBuf,
    zip: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!("ms-portable-{}", uuid::Uuid::new_v4()));
        let root = directory.join("source-device");
        let vault = root.join("profiles/source");
        fs::create_dir_all(&vault).unwrap();
        let fixture = Self {
            zip: directory.join("backup.zip"),
            directory,
            root,
            vault,
        };
        fixture.package(&fixture.directory.join("incoming"), "source");
        crate::plugins::packages::install(&fixture.root, &fixture.directory.join("incoming"))
            .unwrap();
        crate::plugins::settings::prepare(&fixture.root, &fixture.vault).unwrap();
        let mut conn = fixture.database(&fixture.vault);
        crate::notes::create(
            &conn,
            crate::notes::CreateNote {
                title: Some("Portable note".into()),
                body: Some("Backup body".into()),
                parent_collection_id: None,
                note_kind: None,
            },
        )
        .unwrap();
        conn.execute("INSERT INTO sync_state(kind, etebase_collection_uid, stoken) VALUES ('notes', 'source-notes', 'n'), ('folders', 'source-folders', 'f')", []).unwrap();
        let plugin = crate::plugins::packages::discover(&fixture.root.join("plugins"), Some(ID))
            .unwrap()
            .pop()
            .unwrap();
        let hash = plugin.checksum.clone();
        crate::plugins::reconcile(&conn, vec![plugin]).unwrap();
        crate::plugins::approve(&conn, ID, &hash, &[], None, "unsigned").unwrap();
        crate::plugins::settings::set(&conn, ID, "vault", &json!("source vault")).unwrap();
        crate::plugins::settings::set(&conn, ID, "device", &json!("legacy device")).unwrap();
        let data = fixture.vault.join("plugin-data").join(ID);
        fs::create_dir_all(data.join("empty")).unwrap();
        fs::write(data.join("state.json"), b"{\"counter\":9}").unwrap();
        fs::write(fixture.vault.join("session.json"), b"secret session").unwrap();
        let lock = RootLock::acquire(&fixture.root).unwrap();
        crate::ui_settings::restore_backup_values(
            &fixture.vault,
            &[("appearance.editorFontSize".into(), json!(19))].into(),
            false,
        )
        .unwrap();
        crate::ui_settings::restore_backup_values(
            &fixture.root,
            &[
                ("appearance.uiFontSize".into(), json!(13)),
                ("appearance.preset".into(), json!("portable-theme")),
            ]
            .into(),
            true,
        )
        .unwrap();
        crate::desktop_settings::restore_backup_values(
            &fixture.root,
            &json!({"language_code":"de","theme_mode":"dark"}),
        )
        .unwrap();
        let mut preset = serde_json::from_str::<serde_json::Value>(include_str!(
            "../../../src/lib/settings/theme-presets.json"
        ))
        .unwrap()[0]
            .clone();
        preset["id"] = json!("portable-theme");
        preset["name"] = json!("Portable theme");
        crate::theme_presets::restore_backup_presets(
            &fixture.root,
            &[serde_json::from_value(preset).unwrap()],
        )
        .unwrap();
        drop(lock);
        export::run_backup_at(&fixture.root, &fixture.vault, &mut conn, &fixture.zip, None)
            .unwrap();
        fixture
    }
    fn package(&self, path: &Path, script: &str) {
        fs::create_dir_all(path).unwrap();
        fs::write(path.join("manifest.json"), json!({"manifestVersion":2,"id":ID,"name":"Portable QA","version":"1.0.0","runtime":"wasm","entry":"plugin.wasm","permissions":[],"contributes":{"settings":[{"sectionId":"qa","titleKey":"qa","settings":[{"id":"device","scope":"D","type":"text","labelKey":"device","default":"default"},{"id":"vault","scope":"V","type":"text","labelKey":"vault","default":"default"}]}]}}).to_string()).unwrap();
        fs::write(
            path.join("plugin.wasm"),
            format!("return {{ label = '{script}' }}"),
        )
        .unwrap();
    }
    fn database(&self, vault: &Path) -> Connection {
        fs::create_dir_all(vault).unwrap();
        let mut conn = Connection::open(vault.join("mindstream.db")).unwrap();
        migrations::run(&mut conn).unwrap();
        conn
    }
    fn target(&self) -> (PathBuf, PathBuf, Connection) {
        let root = self.directory.join("target-device");
        let vault = root.join("profiles/target");
        let conn = self.database(&vault);
        crate::plugins::packages::prepare(&root, &vault).unwrap();
        crate::plugins::settings::prepare(&root, &vault).unwrap();
        (root, vault, conn)
    }
    fn stage(&self, vault: &Path, conn: &Connection, device: bool) {
        let preview = stage_import_at(vault, &self.zip, conn, None).unwrap();
        assert!(preview.portable);
        assert_eq!(preview.plugin_packages, 1);
        assert_eq!(preview.plugin_data_bytes, 13);
        let dir = vault.join("imports/.staging").join(preview.token);
        assert!(
            stage_restore_at(vault, &dir, conn, true, device)
                .unwrap()
                .sanitized
        );
    }
    fn apply(&self, root: &Path, vault: &Path) {
        apply_pending_restore_with_root(
            root,
            vault,
            &vault.join(PENDING_DB_FILE),
            &vault.join(SENTINEL_FILE),
        )
        .unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

#[test]
fn portable_round_trip_restores_values_data_and_gates_packages_on_another_device() {
    let fixture = Fixture::new();
    let (root, vault, conn) = fixture.target();
    fixture.stage(&vault, &conn, true);
    drop(conn);
    fixture.apply(&root, &vault);
    let conn = Connection::open(vault.join("mindstream.db")).unwrap();
    assert_eq!(
        conn.query_row("SELECT title FROM notes", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "Portable note"
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM sync_state", [], |row| row
            .get::<_, u32>(0))
            .unwrap(),
        0
    );
    let plugin = crate::plugins::packages::discover(&root.join("plugins"), Some(ID))
        .unwrap()
        .pop()
        .unwrap();
    crate::plugins::reconcile(&conn, vec![plugin]).unwrap();
    let plugin = crate::plugins::packages::discover(&root.join("plugins"), Some(ID))
        .unwrap()
        .pop()
        .unwrap();
    let record = crate::plugins::list(&conn)
        .unwrap()
        .into_iter()
        .find(|record| record.id == ID)
        .unwrap();
    assert!(!record.enabled);
    assert!(record.accepted_hash.is_empty());
    assert_eq!(
        crate::plugins::settings::effective(&root, &vault, &conn, &plugin).unwrap(),
        [
            ("device".into(), json!("legacy device")),
            ("vault".into(), json!("source vault"))
        ]
        .into()
    );
    assert_eq!(
        fs::read(vault.join("plugin-data").join(ID).join("state.json")).unwrap(),
        b"{\"counter\":9}"
    );
    assert!(vault.join("plugin-data").join(ID).join("empty").is_dir());
    assert!(!vault.join("session.json").exists());
    let _lock = RootLock::acquire(&root).unwrap();
    assert_eq!(
        crate::ui_settings::backup_values(&vault, false).unwrap()["appearance.editorFontSize"],
        json!(19)
    );
    assert_eq!(
        crate::ui_settings::backup_values(&root, true).unwrap()["appearance.uiFontSize"],
        json!(13)
    );
    assert_eq!(
        crate::desktop_settings::backup_values(&root).unwrap()["theme_mode"],
        json!("dark")
    );
    assert_eq!(
        crate::theme_presets::backup_presets(&root).unwrap()[0].id,
        "portable-theme"
    );
}

#[test]
fn vault_only_restore_leaves_the_device_and_other_vault_untouched() {
    let fixture = Fixture::new();
    let (root, vault, conn) = fixture.target();
    let other = root.join("profiles/other");
    fs::create_dir_all(&other).unwrap();
    fs::write(other.join("keep"), b"other vault").unwrap();
    {
        let _lock = RootLock::acquire(&root).unwrap();
        crate::ui_settings::restore_backup_values(
            &root,
            &[("appearance.uiFontSize".into(), json!(17))].into(),
            true,
        )
        .unwrap();
    }
    let before = fs::read(root.join("ui-settings.json")).unwrap();
    fixture.stage(&vault, &conn, false);
    drop(conn);
    fixture.apply(&root, &vault);
    assert_eq!(fs::read(root.join("ui-settings.json")).unwrap(), before);
    assert!(
        crate::plugins::packages::discover(&root.join("plugins"), None)
            .unwrap()
            .is_empty()
    );
    assert!(!root.join("theme-presets.json").exists());
    assert_eq!(fs::read(other.join("keep")).unwrap(), b"other vault");
    assert!(vault
        .join("plugin-data")
        .join(ID)
        .join("state.json")
        .is_file());
}

#[test]
fn device_import_keeps_conflicting_values_packages_and_uninstall_receipts() {
    for removed in [false, true] {
        let fixture = Fixture::new();
        let (root, vault, conn) = fixture.target();
        let incoming = fixture.directory.join("target-package");
        fixture.package(&incoming, "target");
        crate::plugins::packages::install(&root, &incoming).unwrap();
        if removed {
            crate::plugins::packages::uninstall(&root, ID).unwrap();
        }
        {
            let _lock = RootLock::acquire(&root).unwrap();
            crate::ui_settings::restore_backup_values(
                &root,
                &[("appearance.uiFontSize".into(), json!(17))].into(),
                true,
            )
            .unwrap();
        }
        fixture.stage(&vault, &conn, true);
        drop(conn);
        fixture.apply(&root, &vault);
        let plugins = crate::plugins::packages::discover(&root.join("plugins"), None).unwrap();
        if removed {
            assert!(plugins.is_empty());
        } else {
            assert!(plugins[0]
                .files
                .read_text("plugin.wasm")
                .unwrap()
                .unwrap()
                .contains("target"));
        }
        let _lock = RootLock::acquire(&root).unwrap();
        assert_eq!(
            crate::ui_settings::backup_values(&root, true).unwrap()["appearance.uiFontSize"],
            json!(17)
        );
    }
}

#[test]
fn changed_pending_resource_stops_before_the_live_database_moves() {
    let fixture = Fixture::new();
    let (root, vault, conn) = fixture.target();
    fixture.stage(&vault, &conn, true);
    drop(conn);
    let before = restore_file_hash(&vault.join("mindstream.db")).unwrap();
    fs::write(
        vault
            .join(portable::PENDING)
            .join("portable/plugin-data")
            .join(ID)
            .join("state.json"),
        b"tampered",
    )
    .unwrap();
    assert!(apply_pending_restore_with_root(
        &root,
        &vault,
        &vault.join(PENDING_DB_FILE),
        &vault.join(SENTINEL_FILE)
    )
    .is_err());
    assert_eq!(
        restore_file_hash(&vault.join("mindstream.db")).unwrap(),
        before
    );
    assert!(vault.join(SENTINEL_FILE).exists());
    assert!(vault.join(PENDING_DB_FILE).exists());
}

#[test]
fn resource_restore_resumes_after_preservation_installation_and_device_publication() {
    for boundary in 0..3 {
        let fixture = Fixture::new();
        let (root, vault, conn) = fixture.target();
        fs::create_dir_all(vault.join("plugin-data")).unwrap();
        fs::write(vault.join("plugin-data/old"), b"previous data").unwrap();
        {
            let _lock = RootLock::acquire(&root).unwrap();
            crate::ui_settings::restore_backup_values(
                &vault,
                &[("appearance.editorFontSize".into(), json!(12))].into(),
                false,
            )
            .unwrap();
        }
        fixture.stage(&vault, &conn, true);
        drop(conn);
        let operation: RestoreOperation =
            serde_json::from_slice(&fs::read(vault.join(SENTINEL_FILE)).unwrap()).unwrap();
        let hash = operation.portable_sha256.as_ref().unwrap().clone();
        let safety = vault
            .join("backups")
            .join(format!("pre-restore-files-{hash}"));
        if boundary == 0 {
            fs::create_dir_all(&safety).unwrap();
            fs::rename(vault.join("plugin-data"), safety.join("plugin-data")).unwrap();
        } else {
            portable::apply(&root, &vault, &hash, true).unwrap();
            if boundary == 2 {
                fs::rename(
                    vault.join("mindstream.db"),
                    vault.join(operation.safety_filename.as_ref().unwrap()),
                )
                .unwrap();
                fs::rename(vault.join(PENDING_DB_FILE), vault.join("mindstream.db")).unwrap();
                RestoreOperation {
                    phase: RestorePhase::Installed,
                    ..operation
                }
                .save(&vault.join(SENTINEL_FILE))
                .unwrap();
            }
        }
        fixture.apply(&root, &vault);
        assert_eq!(
            fs::read(safety.join("plugin-data/old")).unwrap(),
            b"previous data"
        );
        let old: serde_json::Value =
            serde_json::from_slice(&fs::read(safety.join("content-settings.json")).unwrap())
                .unwrap();
        assert_eq!(old["values"]["appearance.editorFontSize"], json!(12));
        assert!(vault
            .join("plugin-data")
            .join(ID)
            .join("state.json")
            .is_file());
        assert!(safety.join("restored-resources").is_dir());
        assert!(!vault.join(SENTINEL_FILE).exists());
    }
}

#[test]
fn legacy_zip_restore_does_not_replace_vault_files() {
    let fixture = Fixture::new();
    let (root, vault, conn) = fixture.target();
    fs::create_dir_all(vault.join("plugin-data")).unwrap();
    fs::write(vault.join("plugin-data/keep"), b"legacy keeps files").unwrap();
    let manifest = Manifest {
        format_version: 1,
        app_version: "legacy".into(),
        schema_version: 28,
        created_at: "2026-10-13T00:00:00Z".into(),
        account_present_at_export: false,
        account: None,
        contents: Contents {
            db_filename: DB_ENTRY_NAME.into(),
            counts: Counts {
                notes: 0,
                folders: 0,
                assets_bytes: 0,
            },
        },
        portable: None,
        data_db_sha256: None,
    };
    export::write_zip(
        &fixture.zip,
        &manifest,
        &fixture.vault.join("mindstream.db"),
    )
    .unwrap();
    let preview = stage_import_at(&vault, &fixture.zip, &conn, None).unwrap();
    assert!(!preview.portable);
    let dir = vault.join("imports/.staging").join(preview.token);
    stage_restore_at(&vault, &dir, &conn, false, true).unwrap();
    drop(conn);
    fixture.apply(&root, &vault);
    assert_eq!(
        fs::read(vault.join("plugin-data/keep")).unwrap(),
        b"legacy keeps files"
    );
    crate::plugins::packages::install(&root, &fixture.directory.join("incoming")).unwrap();
    let conn = Connection::open(vault.join("mindstream.db")).unwrap();
    let plugin = crate::plugins::packages::discover(&root.join("plugins"), Some(ID))
        .unwrap()
        .pop()
        .unwrap();
    let settings = crate::plugins::settings::effective(&root, &vault, &conn, &plugin).unwrap();
    assert!(
        !settings.contains_key("device"),
        "legacy rows cannot implicitly change shared preferences"
    );
    assert_eq!(settings["vault"], json!("source vault"));
}

#[test]
fn backup_cannot_overwrite_live_storage_and_repeated_exports_replace_a_complete_archive() {
    let fixture = Fixture::new();
    let live = fixture.vault.join("mindstream.db");
    let before = restore_file_hash(&live).unwrap();
    let mut conn = Connection::open(&live).unwrap();
    assert!(export::run_backup_at(&fixture.root, &fixture.vault, &mut conn, &live, None).is_err());
    assert_eq!(restore_file_hash(&live).unwrap(), before);
    export::run_backup_at(
        &fixture.root,
        &fixture.vault,
        &mut conn,
        &fixture.vault.join("backups/default.zip"),
        None,
    )
    .unwrap();
    export::run_backup_at(&fixture.root, &fixture.vault, &mut conn, &fixture.zip, None).unwrap();
    let (_, target, connection) = fixture.target();
    assert!(
        stage_import_at(&target, &fixture.zip, &connection, None)
            .unwrap()
            .portable
    );
}

#[test]
fn device_import_preserves_an_explicit_plugin_setting_reset() {
    let fixture = Fixture::new();
    let (root, vault, conn) = fixture.target();
    crate::plugins::packages::install(&root, &fixture.directory.join("incoming")).unwrap();
    let plugin = crate::plugins::packages::discover(&root.join("plugins"), Some(ID))
        .unwrap()
        .pop()
        .unwrap();
    crate::plugins::settings::set_scoped(&root, &conn, &plugin, "device", None).unwrap();
    drop(plugin);
    fixture.stage(&vault, &conn, true);
    drop(conn);
    fixture.apply(&root, &vault);
    let conn = Connection::open(vault.join("mindstream.db")).unwrap();
    let plugin = crate::plugins::packages::discover(&root.join("plugins"), Some(ID))
        .unwrap()
        .pop()
        .unwrap();
    assert!(
        !crate::plugins::settings::effective(&root, &vault, &conn, &plugin)
            .unwrap()
            .contains_key("device")
    );
}

/// Used by supervised-backup-check.py before it launches the owned native app.
#[test]
#[ignore = "native fixture producer; requires MINDSTREAM_BACKUP_FIXTURE_ROOT"]
fn produce_native_restore_fixture() {
    let root = PathBuf::from(
        std::env::var("MINDSTREAM_BACKUP_FIXTURE_ROOT").expect("fixture root required"),
    )
    .canonicalize()
    .unwrap();
    assert!(root.join("profiles.json").is_file());
    let fixture = Fixture::new();
    let vault = root.join("profiles/source");
    let peer = root.join("profiles/target");
    assert!(!vault.join("mindstream.db").exists());
    let conn = fixture.database(&vault);
    let other = fixture.database(&peer);
    crate::notes::create(
        &other,
        crate::notes::CreateNote {
            title: Some("Other vault unchanged".into()),
            body: Some("Peer body".into()),
            parent_collection_id: None,
            note_kind: None,
        },
    )
    .unwrap();
    drop(other);
    crate::plugins::packages::prepare(&root, &vault).unwrap();
    crate::plugins::settings::prepare(&root, &vault).unwrap();
    {
        let _lock = RootLock::acquire(&root).unwrap();
        crate::ui_settings::restore_backup_values(
            &root,
            &[("appearance.uiFontSize".into(), json!(17))].into(),
            true,
        )
        .unwrap();
        crate::ui_settings::restore_backup_values(
            &vault,
            &[("appearance.editorFontSize".into(), json!(12))].into(),
            false,
        )
        .unwrap();
    }
    fs::create_dir_all(vault.join("plugin-data")).unwrap();
    fs::write(vault.join("plugin-data/before"), b"old native data").unwrap();
    fixture.stage(&vault, &conn, true);
    fs::copy(&fixture.zip, root.parent().unwrap().join("portable.zip")).unwrap();
    drop(conn);
    // Persist selected interrupted states for an external, whole-VM reset.
    // No production fault hooks are enabled by these test-only preparations.
    if let Ok(boundary) = std::env::var("MINDSTREAM_BACKUP_FIXTURE_BOUNDARY") {
        let operation: RestoreOperation =
            serde_json::from_slice(&fs::read(vault.join(SENTINEL_FILE)).unwrap()).unwrap();
        let hash = operation.portable_sha256.as_ref().unwrap();
        match boundary.as_str() {
            "files-preserved" => {
                let safety = vault
                    .join("backups")
                    .join(format!("pre-restore-files-{hash}"));
                fs::create_dir_all(&safety).unwrap();
                fs::rename(vault.join("plugin-data"), safety.join("plugin-data")).unwrap();
                crate::atomic_file::sync_directory(&safety).unwrap();
                crate::atomic_file::sync_directory(&vault).unwrap();
                crate::atomic_file::sync_directory(&vault.join("backups")).unwrap();
            }
            "resources-published" => portable::apply(&root, &vault, hash, true).unwrap(),
            "database-installed" => {
                portable::apply(&root, &vault, hash, true).unwrap();
                fs::rename(
                    vault.join("mindstream.db"),
                    vault.join(operation.safety_filename.as_ref().unwrap()),
                )
                .unwrap();
                fs::rename(vault.join(PENDING_DB_FILE), vault.join("mindstream.db")).unwrap();
                crate::atomic_file::sync_directory(&vault).unwrap();
                RestoreOperation {
                    phase: RestorePhase::Installed,
                    ..operation
                }
                .save(&vault.join(SENTINEL_FILE))
                .unwrap();
            }
            _ => panic!("unknown VM restore checkpoint"),
        }
    }
}

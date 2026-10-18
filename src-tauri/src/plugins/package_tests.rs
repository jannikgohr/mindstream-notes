use super::packages::*;
use crate::db::open_memory_for_tests;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

const ID: &str = "com.test.global";
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("ms-global-plugins-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("profiles/source")).unwrap();
        fs::create_dir_all(root.join("profiles/target")).unwrap();
        Self(root)
    }
    fn source(&self) -> PathBuf {
        self.0.join("profiles/source")
    }
    fn target(&self) -> PathBuf {
        self.0.join("profiles/target")
    }
    fn package(&self, path: &Path, text: &str) {
        fs::create_dir_all(path).unwrap();
        let manifest = serde_json::json!({
            "manifestVersion": 1, "id": ID, "name": "Global QA", "version": "1.0.0",
            "runtime": "luau", "entry": "main.luau", "permissions": [],
            "contributes": { "settings": [{"sectionId":"qa", "titleKey":"qa", "settings":[
                {"id":"device","scope":"D","type":"text","labelKey":"device","default":"default"},
                {"id":"vault","scope":"V","type":"text","labelKey":"vault","default":"default"}
            ]}] }
        });
        fs::write(path.join("manifest.json"), manifest.to_string()).unwrap();
        fs::write(path.join("main.luau"), text).unwrap();
    }
    fn plugin(&self) -> super::discovery::DiscoveredPlugin {
        discover(&self.0.join("plugins"), Some(ID))
            .unwrap()
            .pop()
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::thread::sleep(std::time::Duration::from_millis(100));
        if let Ok(lock) = crate::storage_locks::RootLock::acquire(&self.0) {
            drop(lock);
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}

fn reconcile_and_approve(
    conn: &rusqlite::Connection,
    plugin: super::discovery::DiscoveredPlugin,
) -> crate::error::AppResult<()> {
    let checksum = plugin.checksum.clone();
    super::reconcile(conn, vec![plugin])?;
    super::approve(conn, ID, &checksum, &[], None, "unsigned")?;
    Ok(())
}

#[test]
fn approvals_and_enablement_are_independent_between_vaults() {
    let fixture = Fixture::new();
    let input = fixture.0.join("input");
    fixture.package(&input, "return {} ");
    install(&fixture.0, &input).unwrap();
    let source = open_memory_for_tests();
    let target = open_memory_for_tests();
    source
        .with_conn(|c| reconcile_and_approve(c, fixture.plugin()))
        .unwrap();
    target
        .with_conn(|c| {
            super::reconcile(c, vec![fixture.plugin()])?;
            Ok(())
        })
        .unwrap();
    assert!(source
        .with_conn(|c| super::load_runnable(c, &fixture.0.join("plugins"), ID, None).map(|_| ()))
        .is_ok());
    assert!(target
        .with_conn(|c| super::load_runnable(c, &fixture.0.join("plugins"), ID, None).map(|_| ()))
        .is_err());
    target
        .with_conn(|c| reconcile_and_approve(c, fixture.plugin()))
        .unwrap();
    source
        .with_conn(|c| super::set_enabled(c, ID, false))
        .unwrap();
    assert!(target
        .with_conn(|c| super::load_runnable(c, &fixture.0.join("plugins"), ID, None).map(|_| ()))
        .is_ok());
}

#[test]
fn reinstall_identical_bytes_gates_unopened_and_unmigrated_vaults() {
    let fixture = Fixture::new();
    let input = fixture.source().join("plugins/qa");
    fixture.package(&input, "return {} ");
    prepare(&fixture.0, &fixture.source()).unwrap();
    let migrated = open_memory_for_tests();
    let legacy = open_memory_for_tests();
    migrated
        .with_conn(|c| reconcile_and_approve(c, fixture.plugin()))
        .unwrap();
    legacy
        .with_conn(|c| {
            let mut plugin = fixture.plugin();
            plugin.generation = None;
            plugin.legacy_generation = None;
            reconcile_and_approve(c, plugin)
        })
        .unwrap();
    uninstall(&fixture.0, ID).unwrap();
    prepare(&fixture.0, &fixture.source()).unwrap();
    assert!(
        discover(&fixture.0.join("plugins"), None)
            .unwrap()
            .is_empty(),
        "retained source must not resurrect removed package"
    );
    install(&fixture.0, &input).unwrap();
    for db in [migrated, legacy] {
        db.with_conn(|c| {
            assert!(super::load_runnable(c, &fixture.0.join("plugins"), ID, None).is_err());
            let views = super::reconcile(c, vec![fixture.plugin()])?;
            assert!(!views[0].record.enabled);
            assert!(views[0].record.accepted_hash.is_empty());
            Ok(())
        })
        .unwrap();
    }
}

#[test]
fn running_version_survives_update_and_removal_until_lease_release() {
    let fixture = Fixture::new();
    let input = fixture.0.join("input");
    fixture.package(&input, "return { old = true }");
    install(&fixture.0, &input).unwrap();
    let pinned = fixture.plugin();
    let old_path = pinned.files.fs_path().unwrap().to_path_buf();
    fixture.package(&input, "return { new = true }");
    install(&fixture.0, &input).unwrap();
    assert_ne!(
        fixture.plugin().checksum,
        pinned.checksum,
        "same version, different bytes"
    );
    uninstall(&fixture.0, ID).unwrap();
    assert!(old_path.exists());
    assert_eq!(
        pinned.files.read_text("main.luau").unwrap().unwrap(),
        "return { old = true }"
    );
    drop(pinned);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while old_path.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert!(
        !old_path.exists(),
        "retired bytes reclaimed after final lease"
    );
}

#[test]
fn root_wins_then_selected_vault_and_conflict_sources_are_retained() {
    let fixture = Fixture::new();
    let selected = fixture.source().join("plugins/qa");
    let root = fixture.0.join("plugins/qa");
    fixture.package(&selected, "selected");
    fixture.package(&root, "root");
    prepare(&fixture.0, &fixture.source()).unwrap();
    assert_eq!(
        fixture
            .plugin()
            .files
            .read_text("main.luau")
            .unwrap()
            .unwrap(),
        "root"
    );
    assert!(selected.join("main.luau").exists());
    assert!(root.join("main.luau").exists());
    assert!(!prepare(&fixture.0, &fixture.target()).unwrap());
}

#[test]
fn recovery_cannot_undo_removal_and_orphan_publication_is_reaped() {
    let fixture = Fixture::new();
    let input = fixture.0.join("input");
    fixture.package(&input, "return {}");
    install(&fixture.0, &input).unwrap();
    let pinned = fixture.plugin();
    uninstall(&fixture.0, ID).unwrap();
    fs::write(fixture.0.join("plugins/catalog.json"), b"broken").unwrap();
    assert!(discover(&fixture.0.join("plugins"), None)
        .unwrap()
        .is_empty());
    drop(pinned);
    let orphan = fixture.0.join("plugin-packages/.staging-interrupted");
    fs::create_dir_all(&orphan).unwrap();
    fs::write(orphan.join("manifest.json"), b"partial").unwrap();
    prepare(&fixture.0, &fixture.source()).unwrap();
    assert!(!orphan.exists());
}

#[test]
fn device_settings_seed_only_selected_vault_and_reset_never_resurrects() {
    let fixture = Fixture::new();
    let input = fixture.0.join("input");
    fixture.package(&input, "return {}");
    install(&fixture.0, &input).unwrap();
    super::settings::prepare(&fixture.0, &fixture.source()).unwrap();
    let source = open_memory_for_tests();
    let target = open_memory_for_tests();
    for (db, label) in [(&source, "source"), (&target, "target")] {
        db.with_conn(|c| {
            super::settings::set(c, ID, "device", &serde_json::json!(label))?;
            super::settings::set(c, ID, "vault", &serde_json::json!(label))
        })
        .unwrap();
    }
    let read = |db: &crate::db::Db, vault: &Path| {
        db.with_conn(|c| super::settings::effective(&fixture.0, vault, c, &fixture.plugin()))
            .unwrap()
    };
    assert!(!read(&target, &fixture.target()).contains_key("device"));
    assert_eq!(read(&source, &fixture.source())["device"], "source");
    assert_eq!(read(&target, &fixture.target())["device"], "source");
    assert_eq!(read(&target, &fixture.target())["vault"], "target");
    target
        .with_conn(|c| {
            super::settings::set_scoped(
                &fixture.0,
                c,
                &fixture.plugin(),
                "device",
                Some(&serde_json::json!("root")),
            )
        })
        .unwrap();
    assert_eq!(read(&source, &fixture.source())["device"], "root");
    source
        .with_conn(|c| {
            super::settings::set_scoped(&fixture.0, c, &fixture.plugin(), "device", None)
        })
        .unwrap();
    assert!(!read(&source, &fixture.source()).contains_key("device"));
    assert!(!read(&target, &fixture.target()).contains_key("device"));
    uninstall(&fixture.0, ID).unwrap();
    assert_eq!(
        source.with_conn(|c| super::settings::all(c, ID)).unwrap()["vault"],
        "source"
    );
}

#[test]
fn concurrent_publications_and_removal_leave_a_complete_catalog() {
    let fixture = Fixture::new();
    let first = fixture.0.join("first");
    let second = fixture.0.join("second");
    fixture.package(&first, "first");
    fixture.package(&second, "second");
    install(&fixture.0, &first).unwrap();
    let barrier = std::sync::Barrier::new(3);
    std::thread::scope(|scope| {
        let a = scope.spawn(|| {
            barrier.wait();
            install(&fixture.0, &first).unwrap();
        });
        let b = scope.spawn(|| {
            barrier.wait();
            install(&fixture.0, &second).unwrap();
        });
        barrier.wait();
        uninstall(&fixture.0, ID).unwrap();
        a.join().unwrap();
        b.join().unwrap();
    });
    let plugins = discover(&fixture.0.join("plugins"), None).unwrap();
    if let Some(plugin) = plugins.first() {
        let text = plugin.files.read_text("main.luau").unwrap().unwrap();
        assert!(text == "first" || text == "second");
    }
    assert!(first.join("main.luau").exists());
    assert!(second.join("main.luau").exists());
}

#[test]
fn concurrent_artifact_downloads_deduplicate_without_partial_files() {
    let fixture = Fixture::new();
    let root = fixture.0.join("plugin-artifacts/qa");
    let bytes = b"artifact payload";
    let artifact = super::manifest::ArtifactDecl {
        id: "data".into(),
        kind: super::manifest::ArtifactKind::Data,
        version: "1".into(),
        url: "https://example.invalid/data".into(),
        sha256: super::sha256_hex(bytes),
        file_name: "data.bin".into(),
        size_bytes: Some(bytes.len() as u64),
    };
    std::thread::scope(|scope| {
        let jobs: Vec<_> = (0..4)
            .map(|_| {
                scope.spawn(|| super::install_artifact_bytes(&root, &artifact, bytes).unwrap())
            })
            .collect();
        for job in jobs {
            assert_eq!(fs::read(job.join().unwrap()).unwrap(), bytes);
        }
    });
    let final_path = super::artifact_path_in(&root, &artifact).unwrap();
    assert_eq!(fs::read(final_path).unwrap(), bytes);
}

#[test]
fn immediate_removal_after_selecting_root_input_cannot_reinstall_on_discovery() {
    let fixture = Fixture::new();
    let input = fixture.0.join("plugins/qa");
    fixture.package(&input, "return {}");
    let aliased = fixture.0.join("plugins/../plugins/qa");
    install(&fixture.0, &aliased).unwrap();
    uninstall(&fixture.0, ID).unwrap();
    prepare(&fixture.0, &fixture.source()).unwrap();
    assert!(discover(&fixture.0.join("plugins"), None)
        .unwrap()
        .is_empty());
}

#[test]
fn mutable_source_cannot_publish_a_package_under_stale_metadata() {
    let fixture = Fixture::new();
    let input = fixture.0.join("input");
    fixture.package(&input, "first");
    let discovered = super::discovery::read_plugin(
        super::discovery::PluginFiles::Fs(input.clone()),
        super::SOURCE_INSTALLED,
    )
    .unwrap();
    fixture.package(&input, "changed while installation was starting");
    assert!(super::packages::publish(&fixture.0, &discovered).is_err());
    assert!(!fixture.0.join("plugins/catalog.json").exists());
    prepare(&fixture.0, &fixture.source()).unwrap();
    assert_eq!(
        fs::read_dir(fixture.0.join("plugin-packages"))
            .unwrap()
            .count(),
        0
    );
    assert!(input.join("main.luau").exists());
}

#[test]
fn catalog_recovery_restores_an_available_previous_package() {
    let fixture = Fixture::new();
    let input = fixture.0.join("input");
    fixture.package(&input, "first");
    install(&fixture.0, &input).unwrap();
    let old_path = fixture.plugin().files.fs_path().unwrap().to_path_buf();
    fixture.package(&input, "second");
    install(&fixture.0, &input).unwrap();
    assert!(
        old_path.exists(),
        "previous catalog retains recovery bytes without a running lease"
    );
    fs::write(fixture.0.join("plugins/catalog.json"), b"broken").unwrap();
    assert_eq!(
        fixture
            .plugin()
            .files
            .read_text("main.luau")
            .unwrap()
            .unwrap(),
        "first"
    );
}

fn write_package(path: &Path, id: &str, extra: serde_json::Value) {
    fs::create_dir_all(path).unwrap();
    let mut manifest = serde_json::json!({
        "manifestVersion": 1, "id": id, "name": "Package QA", "version": "1.0.0",
        "runtime": "luau", "entry": "main.luau", "permissions": []
    });
    if let (Some(manifest), Some(extra)) = (manifest.as_object_mut(), extra.as_object()) {
        manifest.extend(extra.clone());
    }
    fs::write(path.join("manifest.json"), manifest.to_string()).unwrap();
    fs::write(path.join("main.luau"), "return {}").unwrap();
}

#[test]
fn installation_refuses_non_packages_and_builtins_and_restore_keeps_existing_entries() {
    let fixture = Fixture::new();
    let empty = fixture.0.join("empty");
    fs::create_dir_all(&empty).unwrap();
    assert!(install(&fixture.0, &empty).is_err());
    let builtin = fixture.0.join("builtin");
    write_package(
        &builtin,
        "com.mindstream.templates.core",
        serde_json::json!({}),
    );
    assert!(install(&fixture.0, &builtin).is_err());
    assert!(uninstall(&fixture.0, "com.mindstream.templates.core").is_err());

    let input = fixture.0.join("input");
    fixture.package(&input, "first");
    assert_eq!(restore_missing(&fixture.0, &input).unwrap(), ID);
    fixture.package(&input, "second");
    assert_eq!(restore_missing(&fixture.0, &input).unwrap(), ID);
    assert_eq!(
        fixture
            .plugin()
            .files
            .read_text("main.luau")
            .unwrap()
            .unwrap(),
        "first",
        "restore never replaces an installed package"
    );
}

#[test]
fn modified_package_bytes_are_refused_by_publication_and_discovery() {
    let fixture = Fixture::new();
    let input = fixture.0.join("input");
    fixture.package(&input, "return {}");
    install(&fixture.0, &input).unwrap();
    let package = fixture.plugin().files.fs_path().unwrap().to_path_buf();
    fs::write(package.join("main.luau"), "tampered").unwrap();
    assert!(discover(&fixture.0.join("plugins"), None)
        .unwrap()
        .is_empty());
    assert!(discover(&fixture.0.join("plugins"), Some(ID)).is_err());
    assert!(
        install(&fixture.0, &input).is_err(),
        "an immutable package cannot be republished over modified bytes"
    );
    fs::remove_file(package.join("manifest.json")).unwrap();
    assert!(discover(&fixture.0.join("plugins"), None)
        .unwrap()
        .is_empty());
    assert!(discover(&fixture.0.join("plugins"), Some(ID)).is_err());
}

#[test]
fn catalog_with_an_unsafe_digest_is_rejected() {
    let fixture = Fixture::new();
    fs::create_dir_all(fixture.0.join("plugins")).unwrap();
    let generation = Uuid::new_v4();
    fs::write(
        fixture.0.join("plugins/catalog.json"),
        serde_json::json!({
            "entries": { ID: {
                "generation": generation,
                "hash": "../escape",
                "legacy_generation": generation
            }},
            "imported": {}
        })
        .to_string(),
    )
    .unwrap();
    assert!(discover(&fixture.0.join("plugins"), None).is_err());
}

#[test]
fn legacy_vault_artifacts_move_to_the_shared_store_and_are_collected_after_removal() {
    let fixture = Fixture::new();
    let bytes = b"legacy artifact";
    let sha = super::sha256_hex(bytes);
    write_package(
        &fixture.source().join("plugins/qa"),
        ID,
        serde_json::json!({
            "permissions": ["pluginArtifacts.download"],
            "contributes": { "artifacts": [{
                "id": "data", "kind": "data", "version": "1",
                "url": "https://example.invalid/data",
                "sha256": sha, "fileName": "data.bin", "sizeBytes": bytes.len()
            }]}
        }),
    );
    let legacy = fixture
        .source()
        .join("plugin-artifacts")
        .join(ID)
        .join("data/1");
    fs::create_dir_all(&legacy).unwrap();
    fs::write(legacy.join("data.bin"), bytes).unwrap();
    // Only digest directories are managed; anything else is an archive.
    let unmanaged = fixture.0.join("plugin-artifacts/other/data/1/not-a-digest");
    fs::create_dir_all(&unmanaged).unwrap();
    fs::write(
        fixture.0.join("plugin-artifacts/other/data/1/stray.bin"),
        b"",
    )
    .unwrap();

    prepare(&fixture.0, &fixture.source()).unwrap();
    let shared = fixture
        .0
        .join("plugin-artifacts")
        .join(ID)
        .join("data/1")
        .join(&sha);
    assert_eq!(fs::read(shared.join("data.bin")).unwrap(), bytes);
    assert!(
        legacy.join("data.bin").exists(),
        "source bytes are retained"
    );
    // A second start finds the shared copy and leaves it alone.
    prepare(&fixture.0, &fixture.source()).unwrap();
    assert!(shared.join("data.bin").exists());

    uninstall(&fixture.0, ID).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while shared.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(20));
        prepare(&fixture.0, &fixture.target()).unwrap();
    }
    assert!(
        !shared.exists(),
        "unreferenced digest directories are reclaimed"
    );
    assert!(unmanaged.exists());
}

#[test]
fn runtime_settings_fill_manifest_defaults_and_vault_keys_stay_in_the_vault() {
    let fixture = Fixture::new();
    let input = fixture.0.join("input");
    fixture.package(&input, "return {}");
    install(&fixture.0, &input).unwrap();
    let plugin = fixture.plugin();
    let stored =
        super::settings::PluginSettings::from([("vault".to_string(), serde_json::json!("mine"))]);
    let runtime = super::settings::with_defaults(&plugin, stored);
    assert_eq!(runtime["vault"], "mine");
    assert_eq!(runtime["device"], "default");

    let db = open_memory_for_tests();
    let value = serde_json::json!("vault value");
    db.with_conn(|c| super::settings::set_scoped(&fixture.0, c, &plugin, "vault", Some(&value)))
        .unwrap();
    assert_eq!(
        db.with_conn(|c| super::settings::all(c, ID)).unwrap()["vault"],
        "vault value"
    );
    assert!(!fixture.0.join("plugin-settings.json").exists());
    db.with_conn(|c| super::settings::set_scoped(&fixture.0, c, &plugin, "vault", None))
        .unwrap();
    assert!(!db
        .with_conn(|c| super::settings::all(c, ID))
        .unwrap()
        .contains_key("vault"));
}

#[test]
fn damaged_device_settings_recover_their_previous_copy() {
    let fixture = Fixture::new();
    let input = fixture.0.join("input");
    fixture.package(&input, "return {}");
    install(&fixture.0, &input).unwrap();
    let plugin = fixture.plugin();
    let db = open_memory_for_tests();
    for value in ["first", "second"] {
        let value = serde_json::json!(value);
        db.with_conn(|c| {
            super::settings::set_scoped(&fixture.0, c, &plugin, "device", Some(&value))
        })
        .unwrap();
    }
    fs::write(fixture.0.join("plugin-settings.json"), b"broken").unwrap();
    let values = super::settings::backup_values(&fixture.0).unwrap();
    assert_eq!(values[ID]["device"], "first");
}

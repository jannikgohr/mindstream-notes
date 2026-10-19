use super::*;

#[test]
fn delayed_focus_persistence_cannot_overwrite_a_newer_vault_selection() {
    use std::sync::atomic::{AtomicU64, Ordering};
    let root = tmp_root();
    load_or_init(&root).unwrap();
    let a = add_profile(&root, "A").unwrap();
    let b = add_profile(&root, "B").unwrap();
    let revision = AtomicU64::new(2);
    remember_active_if(&root, &b.id, || Ok(revision.load(Ordering::Acquire) == 2)).unwrap();
    // The older writer acquires the transaction lock after the newer writer.
    remember_active_if(&root, &a.id, || Ok(revision.load(Ordering::Acquire) == 1)).unwrap();
    assert_eq!(load(&root).unwrap().unwrap().active, b.id);
    revision.store(3, Ordering::Release);
    remember_active_if(&root, &a.id, || Ok(revision.load(Ordering::Acquire) == 3)).unwrap();
    assert_eq!(load(&root).unwrap().unwrap().active, a.id);
    assert_eq!(load(&root).unwrap().unwrap().profiles.len(), 3);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn explicit_workers_keep_the_startup_preference_and_host_can_read_an_open_vault() {
    let root = tmp_root();
    let index = prepare_coordinator_index(&root).unwrap();
    let other = add_profile(&root, "Other").unwrap();
    let owner = resolve_worker(&root, &other.id).unwrap();
    assert_eq!(load(&root).unwrap().unwrap().active, index.active);
    assert!(resolve_worker(&root, &other.id).is_err());
    assert_eq!(prepare_coordinator_index(&root).unwrap().profiles.len(), 2);
    let default = resolve_worker(&root, DEFAULT_PROFILE_ID).unwrap();
    drop(default);
    drop(owner);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn explicit_worker_refuses_unindexed_or_missing_directories_without_recreating_them() {
    let root = tmp_root();
    prepare_coordinator_index(&root).unwrap();
    let other = add_profile(&root, "Missing").unwrap();
    fs::remove_dir_all(profile_dir(&root, &other.id)).unwrap();
    assert!(resolve_worker(&root, &other.id).is_err());
    assert!(!profile_dir(&root, &other.id).exists());
    assert!(resolve_worker(&root, "unindexed").is_err());
    assert!(!profile_dir(&root, "unindexed").exists());
    assert!(resolve_worker(&root, "../unsafe").is_err());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn startup_recovers_previous_index_and_preserves_unindexed_vaults_and_corrupt_bytes() {
    let root = tmp_root();
    load_or_init(&root).unwrap();
    let other = add_profile(&root, "Other").unwrap();
    fs::write(index_path(&root), b"broken latest index").unwrap();
    let (id, owner) = resolve_startup(&root).unwrap();
    assert_eq!(id, DEFAULT_PROFILE_ID);
    drop(owner);
    assert!(profile_dir(&root, &other.id).is_dir());
    assert!(fs::read_dir(&root).unwrap().any(|entry| {
        let path = entry.unwrap().path();
        path.file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("profiles.json.corrupt-")
            && fs::read(path).unwrap() == b"broken latest index"
    }));
    assert_eq!(load(&root).unwrap().unwrap().profiles.len(), 1);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn recovery_does_not_recreate_a_vault_deleted_after_the_previous_index() {
    let root = tmp_root();
    let other = add_profile(&root, "Other").unwrap();
    delete(&root, &other.id, DEFAULT_PROFILE_ID).unwrap();
    fs::write(index_path(&root), b"broken current").unwrap();
    assert!(resolve_startup(&root).is_err());
    assert!(!profile_dir(&root, &other.id).exists());
    assert_eq!(fs::read(index_path(&root)).unwrap(), b"broken current");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn missing_index_with_vault_data_and_missing_selected_directory_stop_startup() {
    let root = tmp_root();
    let default = profile_dir(&root, DEFAULT_PROFILE_ID);
    fs::create_dir_all(&default).unwrap();
    fs::write(default.join("mindstream.db"), b"existing notes").unwrap();
    // Interrupted legacy migration remains a valid recovery path.
    assert!(resolve_startup(&root).is_ok());
    fs::remove_file(index_path(&root)).unwrap();
    assert!(load_or_init(&root).is_err());
    assert!(!index_path(&root).exists());
    fs::remove_dir_all(&default).unwrap();
    save(&root, &Index::default_single()).unwrap();
    assert!(resolve_startup(&root).is_err());
    assert!(!default.exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn recovered_old_index_reconciles_an_interrupted_deletion_before_ownership() {
    let root = tmp_root();
    let other = add_profile(&root, "Other").unwrap();
    let mut index = load(&root).unwrap().unwrap();
    index.profiles.retain(|profile| profile.id != other.id);
    save(&root, &index).unwrap();
    crate::atomic_file::write(
        &root.join(format!(".vault-delete-{}.json", other.id)),
        &serde_json::to_vec(&other.id).unwrap(),
    )
    .unwrap();
    fs::remove_dir_all(profile_dir(&root, &other.id)).unwrap();
    fs::write(index_path(&root), b"broken").unwrap();
    let (_, owner) = resolve_startup(&root).unwrap();
    drop(owner);
    assert_eq!(load(&root).unwrap().unwrap().profiles.len(), 1);
    assert!(!profile_dir(&root, &other.id).exists());
    assert!(resolve_startup(&root).is_ok());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn missing_index_with_multiple_vault_directories_cannot_be_mistaken_for_legacy_migration() {
    let root = tmp_root();
    let default = profile_dir(&root, DEFAULT_PROFILE_ID);
    fs::create_dir_all(&default).unwrap();
    fs::write(default.join("mindstream.db"), b"existing default").unwrap();
    let other = profile_dir(&root, "other");
    fs::create_dir_all(&other).unwrap();
    fs::write(other.join("mindstream.db"), b"existing other").unwrap();
    assert!(resolve_startup(&root).is_err());
    assert!(!index_path(&root).exists());
    assert_eq!(
        fs::read(other.join("mindstream.db")).unwrap(),
        b"existing other"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn migration_preserves_conflicting_wal_copies_without_publishing_index() {
    let root = tmp_root();
    let destination = profile_dir(&root, DEFAULT_PROFILE_ID);
    fs::create_dir_all(&destination).unwrap();
    fs::write(destination.join(LEGACY_DB_FILE), b"moved database").unwrap();
    fs::write(root.join("mindstream.db-wal"), b"source commits").unwrap();
    fs::write(destination.join("mindstream.db-wal"), b"other commits").unwrap();
    assert!(migrate_legacy_if_needed(&root).is_err());
    assert!(!index_path(&root).exists());
    assert_eq!(
        fs::read(root.join("mindstream.db-wal")).unwrap(),
        b"source commits"
    );
    assert_eq!(
        fs::read(destination.join("mindstream.db-wal")).unwrap(),
        b"other commits"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn concurrent_profile_creates_preserve_all_index_entries() {
    let root = tmp_root();
    std::thread::scope(|scope| {
        for worker in 0..8 {
            let root = &root;
            scope.spawn(move || add_profile(root, &format!("Vault {worker}")).unwrap());
        }
    });
    let index = load(&root).unwrap().unwrap();
    assert_eq!(index.profiles.len(), 9);
    validate_index(&index).unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn migration_resumes_after_database_move_before_index_publication() {
    let root = tmp_root();
    let dest = profile_dir(&root, DEFAULT_PROFILE_ID);
    fs::create_dir_all(&dest).unwrap();
    fs::write(dest.join("mindstream.db"), b"moved database").unwrap();
    fs::write(root.join("mindstream.db-wal"), b"remaining WAL").unwrap();
    assert!(migrate_legacy_if_needed(&root).unwrap());
    assert_eq!(
        fs::read(dest.join("mindstream.db-wal")).unwrap(),
        b"remaining WAL"
    );
    assert!(load(&root).unwrap().is_some());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn deletion_refuses_another_instances_open_vault() {
    let root = tmp_root();
    let profile = add_profile(&root, "Other").unwrap();
    let owner = VaultLock::acquire(&profile_dir(&root, &profile.id)).unwrap();
    assert!(delete(&root, &profile.id, DEFAULT_PROFILE_ID).is_err());
    assert_eq!(load(&root).unwrap().unwrap().profiles.len(), 2);
    drop(owner);
    delete(&root, &profile.id, DEFAULT_PROFILE_ID).unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn deletion_recovery_resumes_before_and_after_index_removal() {
    for removed in [false, true] {
        let root = tmp_root();
        let profile = add_profile(&root, "Other").unwrap();
        let dir = profile_dir(&root, &profile.id);
        fs::write(dir.join("note"), b"content").unwrap();
        crate::atomic_file::write(
            &root.join(format!(".vault-delete-{}.json", profile.id)),
            &serde_json::to_vec(&profile.id).unwrap(),
        )
        .unwrap();
        fs::write(dir.join(".vault-deleting"), b"pending").unwrap();
        assert!(VaultLock::acquire(&dir).is_err());
        if removed {
            let mut index = load(&root).unwrap().unwrap();
            index.profiles.retain(|entry| entry.id != profile.id);
            save(&root, &index).unwrap();
        }
        let index = load_or_init(&root).unwrap();
        assert_eq!(index.profiles.len(), 1);
        assert!(!dir.exists());
        assert_eq!(load_or_init(&root).unwrap(), index);
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn unsafe_index_or_delete_records_are_retained_and_rejected() {
    let root = tmp_root();
    let mut index = Index::default_single();
    index.profiles[0].id = "../outside".into();
    index.active = "../outside".into();
    assert!(save(&root, &index).is_err());
    let record = root.join(".vault-delete-unsafe.json");
    fs::write(&record, br#""../outside""#).unwrap();
    assert!(load_or_init(&root).is_err());
    assert!(record.exists());
    fs::remove_dir_all(root).unwrap();
}

fn tmp_root() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ms-profiles-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn profile_dir_is_under_profiles_subdir() {
    let root = Path::new("/data");
    assert_eq!(
        profile_dir(root, "default"),
        Path::new("/data").join("profiles").join("default")
    );
}

#[test]
fn load_or_init_writes_fresh_index_without_migrating() {
    let root = tmp_root();
    let index = load_or_init(&root).unwrap();
    assert_eq!(index.active, DEFAULT_PROFILE_ID);
    assert_eq!(index.profiles.len(), 1);
    assert!(index_path(&root).exists());
    // Reserve the empty directory before publishing its new index entry.
    let reserved = profile_dir(&root, DEFAULT_PROFILE_ID);
    assert!(reserved.is_dir());
    assert_eq!(fs::read_dir(reserved).unwrap().count(), 0);
    fs::remove_dir_all(&root).ok();
}

#[test]
fn index_round_trips_through_save_and_load() {
    let root = tmp_root();
    let original = Index::default_single();
    save(&root, &original).unwrap();
    let loaded = load(&root).unwrap().unwrap();
    assert_eq!(loaded, original);
    fs::remove_dir_all(&root).ok();
}

#[test]
fn load_returns_none_when_index_is_missing() {
    let root = tmp_root();
    assert_eq!(load(&root).unwrap(), None);
    fs::remove_dir_all(&root).ok();
}

#[test]
fn load_rejects_corrupt_index() {
    let root = tmp_root();
    fs::write(index_path(&root), b"{not json").unwrap();
    let err = load(&root).unwrap_err();
    assert!(
        err.to_string().contains("profiles index corrupt"),
        "got {err}"
    );
    fs::remove_dir_all(&root).ok();
}

#[test]
fn migrate_moves_legacy_vault_into_default_profile() {
    let root = tmp_root();
    // Seed a pre-profiles install: the DB trio plus siblings.
    fs::write(root.join("mindstream.db"), b"db").unwrap();
    fs::write(root.join("mindstream.db-wal"), b"wal").unwrap();
    fs::write(root.join("mindstream.db-shm"), b"shm").unwrap();
    fs::write(root.join("etebase.session"), b"sess").unwrap();
    fs::write(root.join("desktop-settings.json"), b"{}").unwrap();
    fs::create_dir_all(root.join("backups")).unwrap();
    fs::write(root.join("backups").join("b.zip"), b"zip").unwrap();

    let migrated = migrate_legacy_if_needed(&root).unwrap();
    assert!(migrated);

    let dest = profile_dir(&root, DEFAULT_PROFILE_ID);
    for name in [
        "mindstream.db",
        "mindstream.db-wal",
        "mindstream.db-shm",
        "etebase.session",
    ] {
        assert!(dest.join(name).exists(), "{name} should move into profile");
        assert!(!root.join(name).exists(), "{name} should leave the root");
    }
    assert!(dest.join("backups").join("b.zip").exists());
    assert!(
        root.join("desktop-settings.json").exists(),
        "device settings stay at root"
    );

    // A valid index now exists with a single active default profile.
    let index = load(&root).unwrap().unwrap();
    assert_eq!(index.active, DEFAULT_PROFILE_ID);
    assert_eq!(index.profiles.len(), 1);
    fs::remove_dir_all(&root).ok();
}

#[test]
fn migrate_refuses_conflicting_source_and_destination_databases() {
    let root = tmp_root();
    let dest = profile_dir(&root, DEFAULT_PROFILE_ID);
    fs::create_dir_all(&dest).unwrap();
    fs::write(root.join("mindstream.db"), b"source-db").unwrap();
    fs::write(dest.join("mindstream.db"), b"existing-db").unwrap();
    fs::write(root.join("notes.txt"), b"leave me").unwrap();

    assert_eq!(
        fs::read(dest.join("mindstream.db")).unwrap(),
        b"existing-db"
    );
    assert_eq!(fs::read(root.join("mindstream.db")).unwrap(), b"source-db");
    assert_eq!(fs::read(root.join("notes.txt")).unwrap(), b"leave me");
    assert!(migrate_legacy_if_needed(&root).is_err());
    assert!(load(&root).unwrap().is_none());
    fs::remove_dir_all(&root).ok();
}

#[test]
fn migrate_is_noop_when_index_already_exists() {
    let root = tmp_root();
    // Index present + a stray legacy db: must not migrate.
    save(&root, &Index::default_single()).unwrap();
    fs::write(root.join("mindstream.db"), b"db").unwrap();

    let migrated = migrate_legacy_if_needed(&root).unwrap();
    assert!(!migrated);
    // The legacy db stays put — we don't touch an already-migrated root.
    assert!(root.join("mindstream.db").exists());
    assert!(!profile_dir(&root, DEFAULT_PROFILE_ID)
        .join("mindstream.db")
        .exists());
    fs::remove_dir_all(&root).ok();
}

#[test]
fn override_ignored_when_gate_closed() {
    // Even with the env var set, a production build (gate closed)
    // must never redirect the data dir.
    let over = override_from_env(Some(OsString::from("/tmp/x")), None, false);
    assert_eq!(over, None);
}

#[test]
fn override_uses_default_id_when_only_dir_set() {
    let over = override_from_env(Some(OsString::from("/tmp/x")), None, true);
    assert_eq!(
        over,
        Some((OVERRIDE_DEFAULT_ID.to_string(), PathBuf::from("/tmp/x")))
    );
}

#[test]
fn override_honors_explicit_id() {
    let over = override_from_env(
        Some(OsString::from("/tmp/x")),
        Some("work".to_string()),
        true,
    );
    assert_eq!(over, Some(("work".to_string(), PathBuf::from("/tmp/x"))));
}

#[test]
fn override_absent_when_dir_unset_or_empty() {
    assert_eq!(override_from_env(None, None, true), None);
    assert_eq!(override_from_env(Some(OsString::new()), None, true), None);
}

#[test]
fn add_profile_appends_persists_and_creates_dir() {
    let root = tmp_root();
    let created = add_profile(&root, "  Work  ").unwrap();
    assert_eq!(created.name, "Work", "name is trimmed");
    assert!(!created.id.is_empty());
    assert!(profile_dir(&root, &created.id).exists());

    // Persisted: a fresh load sees default + the new one.
    let index = load(&root).unwrap().unwrap();
    assert_eq!(index.profiles.len(), 2);
    assert!(index.profiles.iter().any(|p| p.id == created.id));
    // Creating does not change the active profile.
    assert_eq!(index.active, DEFAULT_PROFILE_ID);
    fs::remove_dir_all(&root).ok();
}

#[test]
fn add_profile_rejects_blank_name() {
    let root = tmp_root();
    assert!(add_profile(&root, "   ").is_err());
    fs::remove_dir_all(&root).ok();
}

#[test]
fn set_active_switches_known_profile_and_persists() {
    let root = tmp_root();
    let created = add_profile(&root, "Work").unwrap();
    set_active(&root, &created.id).unwrap();
    assert_eq!(load(&root).unwrap().unwrap().active, created.id);
    fs::remove_dir_all(&root).ok();
}

#[test]
fn set_active_rejects_unknown_profile() {
    let root = tmp_root();
    load_or_init(&root).unwrap();
    assert!(set_active(&root, "does-not-exist").is_err());
    // Active is untouched.
    assert_eq!(load(&root).unwrap().unwrap().active, DEFAULT_PROFILE_ID);
    fs::remove_dir_all(&root).ok();
}

#[test]
fn set_name_renames_and_persists() {
    let root = tmp_root();
    let created = add_profile(&root, "Work").unwrap();
    let renamed = set_name(&root, &created.id, "  Job  ").unwrap();
    assert_eq!(renamed.name, "Job", "name is trimmed");
    assert_eq!(renamed.id, created.id, "id is unchanged");
    let index = load(&root).unwrap().unwrap();
    assert_eq!(
        index
            .profiles
            .iter()
            .find(|p| p.id == created.id)
            .unwrap()
            .name,
        "Job"
    );
    fs::remove_dir_all(&root).ok();
}

#[test]
fn set_name_rejects_blank_or_unknown() {
    let root = tmp_root();
    let created = add_profile(&root, "Work").unwrap();
    assert!(set_name(&root, &created.id, "  ").is_err());
    assert!(set_name(&root, "nope", "Name").is_err());
    fs::remove_dir_all(&root).ok();
}

#[test]
fn delete_removes_entry_and_dir() {
    let root = tmp_root();
    let created = add_profile(&root, "Work").unwrap();
    let dir = profile_dir(&root, &created.id);
    assert!(dir.exists());

    // active is "default", so deleting the new one is allowed.
    delete(&root, &created.id, DEFAULT_PROFILE_ID).unwrap();

    let index = load(&root).unwrap().unwrap();
    assert!(!index.profiles.iter().any(|p| p.id == created.id));
    assert!(!dir.exists(), "the vault directory is removed");
    fs::remove_dir_all(&root).ok();
}

#[test]
fn delete_rejects_active_vault() {
    let root = tmp_root();
    let created = add_profile(&root, "Work").unwrap();
    // Pretend the new vault is the loaded one.
    assert!(delete(&root, &created.id, &created.id).is_err());
    assert!(load(&root)
        .unwrap()
        .unwrap()
        .profiles
        .iter()
        .any(|p| p.id == created.id));
    fs::remove_dir_all(&root).ok();
}

#[test]
fn delete_rejects_index_active_vault() {
    let root = tmp_root();
    let created = add_profile(&root, "Work").unwrap();
    set_active(&root, &created.id).unwrap();

    // The app may still be running from "default" in dev mode, but
    // profiles.json already says "Work" is the next active vault.
    assert!(delete(&root, &created.id, DEFAULT_PROFILE_ID).is_err());
    assert!(load(&root)
        .unwrap()
        .unwrap()
        .profiles
        .iter()
        .any(|p| p.id == created.id));
    fs::remove_dir_all(&root).ok();
}

#[test]
fn delete_rejects_last_and_unknown() {
    let root = tmp_root();
    load_or_init(&root).unwrap();
    // Only "default" exists, and it's not active here — still refused
    // because it's the last one.
    assert!(delete(&root, DEFAULT_PROFILE_ID, "some-other-active").is_err());
    // Unknown id with >1 vault present.
    add_profile(&root, "Work").unwrap();
    assert!(delete(&root, "nope", DEFAULT_PROFILE_ID).is_err());
    fs::remove_dir_all(&root).ok();
}

#[test]
fn migrate_is_noop_for_brand_new_install() {
    let root = tmp_root();
    // No index, no legacy db.
    let migrated = migrate_legacy_if_needed(&root).unwrap();
    assert!(!migrated);
    assert!(!index_path(&root).exists());
    fs::remove_dir_all(&root).ok();
}

#[test]
fn vault_colours_hash_like_the_frontend_fallback() {
    // The same slots as vaultTileColor in src/lib/vaults/tile.ts.
    assert_eq!(color_slot("default"), 6);
    assert_eq!(color_slot("work"), 0);
    assert_eq!(color_slot("uni"), 1);
    assert_eq!(
        Index::default_single().profiles[0].color.as_deref(),
        Some("violet")
    );
}

#[test]
fn old_indexes_get_distinct_colours_locked_in_once() {
    let root = tmp_root();
    // vault-4 and vault-17 hash to violet, the same colour as default.
    for id in ["default", "vault-4", "vault-17", "vault-26"] {
        fs::create_dir_all(profile_dir(&root, id)).unwrap();
    }
    fs::write(
        index_path(&root),
        r#"{"active":"default","profiles":[
            {"id":"default","name":"Default","created_at":""},
            {"id":"vault-4","name":"Work","created_at":""},
            {"id":"vault-17","name":"Uni","created_at":""},
            {"id":"vault-26","name":"Old","created_at":"","color":"teal"}]}"#,
    )
    .unwrap();
    let colors = |index: &Index| -> Vec<String> {
        index
            .profiles
            .iter()
            .map(|profile| profile.color.clone().unwrap())
            .collect()
    };
    let index = load_or_init(&root).unwrap();
    // The stored teal stays; the rest step three colours on from violet.
    assert_eq!(colors(&index), ["violet", "orange", "pink", "teal"]);
    assert_eq!(load(&root).unwrap().unwrap(), index, "colours are saved");
    let saved = fs::read(index_path(&root)).unwrap();
    load_or_init(&root).unwrap();
    assert_eq!(fs::read(index_path(&root)).unwrap(), saved);

    // Deleting a vault recolours nothing, and a new vault takes a free colour.
    delete(&root, "vault-4", "default").unwrap();
    assert_eq!(
        colors(&load_or_init(&root).unwrap()),
        ["violet", "pink", "teal"]
    );
    let added = add_profile(&root, "New").unwrap();
    let color = added.color.unwrap();
    assert!(VAULT_COLORS.contains(&color.as_str()));
    assert!(!["violet", "pink", "teal"].contains(&color.as_str()));
    fs::remove_dir_all(root).ok();
}

#[test]
fn unknown_colour_names_are_kept_and_malformed_ones_rejected() {
    let root = tmp_root();
    fs::create_dir_all(profile_dir(&root, "default")).unwrap();
    let index = |color: &str| {
        format!(
            r#"{{"active":"default","profiles":[{{"id":"default","name":"D","created_at":"","color":"{color}"}}]}}"#
        )
    };
    // A colour a newer build added stays as it is.
    fs::write(index_path(&root), index("slate-blue")).unwrap();
    assert_eq!(
        load_or_init(&root).unwrap().profiles[0].color.as_deref(),
        Some("slate-blue")
    );
    for malformed in ["", "Red", "red;}", &"a".repeat(33)] {
        fs::write(index_path(&root), index(malformed)).unwrap();
        assert!(load(&root).is_err(), "{malformed:?}");
    }
    fs::remove_dir_all(root).ok();
}

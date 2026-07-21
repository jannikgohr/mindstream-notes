use super::*;

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
    // No legacy DB, so nothing should have been moved.
    assert!(!profile_dir(&root, DEFAULT_PROFILE_ID).exists());
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
        "desktop-settings.json",
    ] {
        assert!(dest.join(name).exists(), "{name} should move into profile");
        assert!(!root.join(name).exists(), "{name} should leave the root");
    }
    assert!(dest.join("backups").join("b.zip").exists());

    // A valid index now exists with a single active default profile.
    let index = load(&root).unwrap().unwrap();
    assert_eq!(index.active, DEFAULT_PROFILE_ID);
    assert_eq!(index.profiles.len(), 1);
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

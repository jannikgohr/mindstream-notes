use super::*;
use crate::db::open_memory_for_tests;

fn upsert_input(id: &str, checksum: &str, source: &str) -> UpsertPlugin {
    UpsertPlugin {
        id: id.to_string(),
        version: "1.0.0".to_string(),
        checksum: checksum.to_string(),
        source: source.to_string(),
        source_path: None,
        permissions: vec!["templates.contribute".into(), "notes.create".into()],
    }
}

#[test]
fn upsert_inserts_a_new_enabled_record() {
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        let rec = upsert(c, upsert_input("com.a.plugin", "hash1", "installed"))?;
        assert!(rec.enabled);
        assert_eq!(rec.accepted_hash, "hash1");
        assert_eq!(rec.granted_permissions.len(), 2);
        assert!(rec.last_load_error.is_none());
        assert_eq!(list(c)?.len(), 1);
        Ok(())
    })
    .unwrap();
}

#[test]
fn builtin_accepts_a_changed_checksum_and_stays_enabled() {
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        upsert(
            c,
            upsert_input("com.mindstream.core", "hash1", SOURCE_BUILTIN),
        )?;
        // A shipped update changes the manifest checksum; a trusted builtin
        // accepts it without re-approval.
        let mut next = upsert_input("com.mindstream.core", "hash2", SOURCE_BUILTIN);
        next.version = "2.0.0".into();
        let rec = upsert(c, next)?;
        assert!(rec.enabled);
        assert_eq!(rec.accepted_hash, "hash2");
        assert_eq!(rec.version, "2.0.0");
        assert!(rec.last_load_error.is_none());
        Ok(())
    })
    .unwrap();
}

#[test]
fn installed_plugin_hash_change_disables_and_records_error() {
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        upsert(c, upsert_input("com.a.plugin", "hash1", "installed"))?;
        let rec = upsert(c, upsert_input("com.a.plugin", "hash2", "installed"))?;
        assert!(!rec.enabled, "changed hash disables an installed plugin");
        assert!(rec.last_load_error.is_some());
        // The originally-accepted hash is retained so re-approval can compare.
        assert_eq!(rec.accepted_hash, "hash1");
        Ok(())
    })
    .unwrap();
}

#[test]
fn installed_plugin_unchanged_hash_refreshes_and_clears_error() {
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        upsert(c, upsert_input("com.a.plugin", "hash1", "installed"))?;
        set_load_error(c, "com.a.plugin", Some("stale error"))?;
        let mut next = upsert_input("com.a.plugin", "hash1", "installed");
        next.version = "1.1.0".into();
        let rec = upsert(c, next)?;
        assert!(rec.enabled);
        assert_eq!(rec.version, "1.1.0");
        assert!(rec.last_load_error.is_none());
        Ok(())
    })
    .unwrap();
}

#[test]
fn enable_disable_toggles_state() {
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        upsert(c, upsert_input("com.a.plugin", "hash1", "installed"))?;
        let rec = set_enabled(c, "com.a.plugin", false)?;
        assert!(!rec.enabled);
        let rec = set_enabled(c, "com.a.plugin", true)?;
        assert!(rec.enabled);
        Ok(())
    })
    .unwrap();
}

#[test]
fn approve_accepts_new_hash_enables_and_clears_error() {
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        upsert(c, upsert_input("com.a.plugin", "hash1", "installed"))?;
        // Simulate a hash change that disabled the plugin.
        upsert(c, upsert_input("com.a.plugin", "hash2", "installed"))?;
        let rec = approve(c, "com.a.plugin", "hash2")?;
        assert!(rec.enabled);
        assert_eq!(rec.accepted_hash, "hash2");
        assert!(rec.last_load_error.is_none());
        Ok(())
    })
    .unwrap();
}

#[test]
fn set_enabled_on_missing_plugin_is_not_found() {
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        let err = set_enabled(c, "ghost", true).unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
        Ok(())
    })
    .unwrap();
}

#[test]
fn remove_deletes_the_record() {
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        upsert(c, upsert_input("com.a.plugin", "hash1", "installed"))?;
        remove(c, "com.a.plugin")?;
        assert!(get(c, "com.a.plugin")?.is_none());
        Ok(())
    })
    .unwrap();
}

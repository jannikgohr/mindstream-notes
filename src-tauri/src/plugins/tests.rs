use super::*;
use crate::db::open_memory_for_tests;

fn signed_input(
    id: &str,
    checksum: &str,
    source: &str,
    signer: Option<&str>,
    signature_status: &str,
) -> UpsertPlugin {
    UpsertPlugin {
        id: id.to_string(),
        version: "1.0.0".to_string(),
        checksum: checksum.to_string(),
        source: source.to_string(),
        source_path: None,
        permissions: vec!["templates.contribute".into(), "notes.create".into()],
        signer: signer.map(String::from),
        signature_status: signature_status.to_string(),
    }
}

fn upsert_input(id: &str, checksum: &str, source: &str) -> UpsertPlugin {
    signed_input(id, checksum, source, None, "unsigned")
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
        let rec = approve(c, "com.a.plugin", "hash2", None, "unsigned")?;
        assert!(rec.enabled);
        assert_eq!(rec.accepted_hash, "hash2");
        assert!(rec.last_load_error.is_none());
        // A subsequent unchanged discovery keeps it enabled (hash now matches).
        let rec = upsert(c, upsert_input("com.a.plugin", "hash2", "installed"))?;
        assert!(rec.enabled);
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
fn signed_same_signer_update_auto_approves() {
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        upsert(
            c,
            signed_input("com.a.p", "h1", "installed", Some("keyA"), "valid"),
        )?;
        // Changed manifest, still validly signed by the same key → accepted.
        let rec = upsert(
            c,
            signed_input("com.a.p", "h2", "installed", Some("keyA"), "valid"),
        )?;
        assert!(rec.enabled);
        assert_eq!(rec.accepted_hash, "h2");
        assert_eq!(rec.signer.as_deref(), Some("keyA"));
        assert!(rec.last_load_error.is_none());
        Ok(())
    })
    .unwrap();
}

#[test]
fn signed_different_signer_update_is_gated_and_keeps_pin() {
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        upsert(
            c,
            signed_input("com.a.p", "h1", "installed", Some("keyA"), "valid"),
        )?;
        // Validly signed, but by a DIFFERENT key → gated; pin + hash retained.
        let rec = upsert(
            c,
            signed_input("com.a.p", "h2", "installed", Some("keyB"), "valid"),
        )?;
        assert!(!rec.enabled);
        assert_eq!(rec.accepted_hash, "h1");
        assert_eq!(rec.signer.as_deref(), Some("keyA"));
        assert!(rec.last_load_error.unwrap().contains("different key"));
        Ok(())
    })
    .unwrap();
}

#[test]
fn invalid_signature_update_is_gated() {
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        upsert(
            c,
            signed_input("com.a.p", "h1", "installed", Some("keyA"), "valid"),
        )?;
        let rec = upsert(
            c,
            signed_input("com.a.p", "h2", "installed", None, "invalid"),
        )?;
        assert!(!rec.enabled);
        assert!(rec
            .last_load_error
            .unwrap()
            .contains("signature is invalid"));
        assert_eq!(rec.signature_status, "invalid");
        Ok(())
    })
    .unwrap();
}

#[test]
fn reconcile_registers_discovered_plugins_and_returns_manifests() {
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        let discovered = vec![super::discovery::DiscoveredPlugin {
            id: "com.a.plugin".into(),
            version: "1.0.0".into(),
            permissions: vec!["notes.create".into()],
            source: SOURCE_BUILTIN.into(),
            checksum: "hash1".into(),
            signer: None,
            signature_status: "unsigned".into(),
            manifest: serde_json::json!({ "id": "com.a.plugin", "name": "A" }),
        }];
        let views = reconcile(c, discovered)?;
        assert_eq!(views.len(), 1);
        assert!(views[0].record.enabled);
        assert_eq!(views[0].record.source, SOURCE_BUILTIN);
        assert_eq!(views[0].manifest["name"], "A");
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

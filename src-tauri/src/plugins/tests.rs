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
fn new_installed_plugin_is_gated_disabled_and_unapproved() {
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        let rec = upsert(c, upsert_input("com.a.plugin", "hash1", "installed"))?;
        // Security: merely being discovered never enables a third-party plugin.
        assert!(!rec.enabled, "a new third-party plugin must start disabled");
        assert_eq!(rec.accepted_hash, "", "no hash is accepted until approval");
        assert!(rec.signer.is_none(), "no signer is pinned until approval");
        assert!(
            rec.last_load_error.is_some(),
            "a gate reason is recorded so the UI prompts for approval"
        );
        assert_eq!(rec.granted_permissions.len(), 2);
        assert_eq!(list(c)?.len(), 1);
        Ok(())
    })
    .unwrap();
}

#[test]
fn new_installed_plugin_stays_disabled_on_rediscovery() {
    // The reported bug: dropping a plugin into the folder and restarting must
    // not auto-enable it. Re-discovering the same (unchanged) unapproved plugin
    // keeps it disabled — approval is the only path to enabled.
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        upsert(c, upsert_input("com.a.plugin", "hash1", "installed"))?;
        let rec = upsert(c, upsert_input("com.a.plugin", "hash1", "installed"))?;
        assert!(
            !rec.enabled,
            "re-discovery must not enable an unapproved plugin"
        );
        assert_eq!(rec.accepted_hash, "");
        assert!(rec.last_load_error.is_some());
        Ok(())
    })
    .unwrap();
}

#[test]
fn new_installed_signed_plugin_is_not_auto_approved() {
    // Even a validly-signed third-party plugin is not trusted on sight: the
    // signer is only pinned by the user's approval, so a re-discovery can't
    // satisfy the same-signer auto-approve path and enable it.
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        upsert(
            c,
            signed_input("com.a.p", "h1", "installed", Some("keyA"), "valid"),
        )?;
        let rec = upsert(
            c,
            signed_input("com.a.p", "h1", "installed", Some("keyA"), "valid"),
        )?;
        assert!(
            !rec.enabled,
            "a signed but unapproved plugin stays disabled"
        );
        assert!(rec.signer.is_none(), "no signer pinned before approval");
        Ok(())
    })
    .unwrap();
}

#[test]
fn new_builtin_plugin_is_enabled_on_discovery() {
    // Builtins ship in the signed app bundle and are trusted by location.
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        let rec = upsert(
            c,
            upsert_input("com.mindstream.core", "hash1", SOURCE_BUILTIN),
        )?;
        assert!(rec.enabled);
        assert_eq!(rec.accepted_hash, "hash1");
        assert!(rec.last_load_error.is_none());
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
        // Approve it at hash1 so we're testing the *approved-then-changed* gate.
        approve(c, "com.a.plugin", "hash1", None, "unsigned")?;
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
        approve(c, "com.a.plugin", "hash1", None, "unsigned")?;
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
        // Approve v1, pinning keyA — that's what lets a same-signer update through.
        approve(c, "com.a.p", "h1", Some("keyA"), "valid")?;
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
        approve(c, "com.a.p", "h1", Some("keyA"), "valid")?;
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
        approve(c, "com.a.p", "h1", Some("keyA"), "valid")?;
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
            files: super::discovery::PluginFiles::Fs(std::path::PathBuf::new()),
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

#[test]
fn run_plugin_script_executes_luau_entry_with_input() {
    let dir = std::env::temp_dir().join(format!("ms-luau-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("main.luau"),
        "return { render = function(ctx) return { title = ctx.name } end }",
    )
    .unwrap();
    let manifest = serde_json::json!({
        "id": "com.a.luau", "runtime": "luau", "entry": "main.luau"
    });
    let out = run_plugin_script(
        &super::discovery::PluginFiles::Fs(dir.clone()),
        &manifest,
        vec!["templates.contribute".into()],
        "render",
        serde_json::json!({ "name": "Hi" }),
        Vec::new(),
    )
    .unwrap();
    assert_eq!(out["title"], serde_json::json!("Hi"));
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn templates_plugin_renders_macros_in_lua() {
    // The embedded Templates plugin renders `{{…}}` itself (in Luau, via its
    // required lib/template module) — proof the macro engine is plugin-owned.
    let plugin = super::discovery::discover_builtins()
        .into_iter()
        .find(|p| p.id == "com.mindstream.templates.core")
        .expect("embedded Templates plugin");
    let out = run_plugin_script(
        &plugin.files,
        &plugin.manifest,
        vec!["notes.read".into(), "notes.create".into()],
        "renderTemplate",
        serde_json::json!({
            "title": "Log {{date:YYYY}}",
            "body": "# {{title|upper}}\nid={{uuid}}\nweek={{date+7d:YYYY-MM-DD}}",
            "now": "2026-07-25T10:00:00Z",
        }),
        Vec::new(),
    )
    .unwrap();
    assert_eq!(out["title"], serde_json::json!("Log 2026"));
    let body = out["body"].as_str().unwrap();
    assert!(
        body.starts_with("# LOG 2026\n"),
        "title rendered then uppercased: {body}"
    );
    assert!(
        body.contains("id=") && body.len() > 20,
        "uuid interpolated: {body}"
    );
    // +7d from 2026-07-25 rolls into August (exact day varies with local tz).
    assert!(
        body.contains("week=2026-08-0"),
        "date offset applied: {body}"
    );
}

#[test]
fn templates_plugin_localizes_dates_via_locale() {
    // The `locale` on the render input threads through to ms.date, so a German
    // template gets German month names.
    let plugin = super::discovery::discover_builtins()
        .into_iter()
        .find(|p| p.id == "com.mindstream.templates.core")
        .expect("embedded Templates plugin");
    let out = run_plugin_script(
        &plugin.files,
        &plugin.manifest,
        vec!["notes.read".into(), "notes.create".into()],
        "renderTemplate",
        serde_json::json!({
            "title": "{{date:MMMM}}",
            "body": "",
            "now": "2026-07-25T10:00:00Z",
            "locale": "de",
        }),
        Vec::new(),
    )
    .unwrap();
    assert_eq!(out["title"], serde_json::json!("Juli"));
}

#[test]
fn run_plugin_script_refuses_a_non_luau_runtime() {
    let manifest = serde_json::json!({ "id": "x", "runtime": "manifest-only" });
    let out = run_plugin_script(
        &super::discovery::PluginFiles::Fs(std::env::temp_dir()),
        &manifest,
        vec![],
        "render",
        serde_json::json!({}),
        Vec::new(),
    );
    assert!(out.is_err());
}

#[test]
fn remove_plugin_dir_deletes_a_dir_inside_the_plugins_folder() {
    let base = std::env::temp_dir().join(format!("ms-rm-{}", uuid::Uuid::new_v4()));
    let plugin = base.join("com.a.plugin");
    std::fs::create_dir_all(&plugin).unwrap();
    std::fs::write(plugin.join("manifest.json"), "{}").unwrap();

    remove_plugin_dir(&base, &plugin).unwrap();
    assert!(!plugin.exists(), "the plugin dir should be gone");
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn remove_plugin_dir_refuses_a_path_outside_the_plugins_folder() {
    let base = std::env::temp_dir().join(format!("ms-rm-{}", uuid::Uuid::new_v4()));
    let outside = std::env::temp_dir().join(format!("ms-rm-out-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&base).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("keep.txt"), "keep").unwrap();

    let err = remove_plugin_dir(&base, &outside);
    assert!(err.is_err(), "a dir outside the plugins folder is refused");
    assert!(outside.exists(), "the outside dir must be left untouched");
    std::fs::remove_dir_all(&base).ok();
    std::fs::remove_dir_all(&outside).ok();
}

#[test]
fn remove_plugin_dir_refuses_the_plugins_folder_itself() {
    let base = std::env::temp_dir().join(format!("ms-rm-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&base).unwrap();

    assert!(remove_plugin_dir(&base, &base).is_err());
    assert!(base.exists());
    std::fs::remove_dir_all(&base).ok();
}

#[test]
fn read_plugin_file_reads_a_bundled_asset() {
    let dir = std::env::temp_dir().join(format!("ms-doc-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(dir.join("docs")).unwrap();
    std::fs::write(dir.join("docs/guide.md"), "# Guide\n\nHello.").unwrap();
    std::fs::create_dir_all(dir.join("icons")).unwrap();
    std::fs::write(dir.join("icons/x.svg"), "<svg/>").unwrap();

    assert_eq!(
        read_plugin_file(&dir, "docs/guide.md").unwrap().as_deref(),
        Some("# Guide\n\nHello.")
    );
    assert_eq!(
        read_plugin_file(&dir, "icons/x.svg").unwrap().as_deref(),
        Some("<svg/>")
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn read_plugin_file_returns_none_for_a_missing_file() {
    let dir = std::env::temp_dir().join(format!("ms-doc-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    // A missing locale variant must be None, not an error, so the caller can
    // fall back to the base file.
    assert!(read_plugin_file(&dir, "docs/guide.de.md")
        .unwrap()
        .is_none());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn read_plugin_file_refuses_path_traversal() {
    let dir = std::env::temp_dir().join(format!("ms-doc-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    assert!(read_plugin_file(&dir, "../secret.md").is_err());
    assert!(read_plugin_file(&dir, "docs/../../secret.md").is_err());
    std::fs::remove_dir_all(&dir).ok();
}

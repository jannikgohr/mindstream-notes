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
        enabled_by_default: true,
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
fn new_builtin_plugin_can_opt_out_of_default_enablement() {
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        let mut input = upsert_input("com.mindstream.typst", "hash1", SOURCE_BUILTIN);
        input.enabled_by_default = false;
        let rec = upsert(c, input)?;
        assert!(!rec.enabled);
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
fn plugin_permission_gate_requires_enabled_and_granted() {
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        upsert(c, upsert_input("com.a.plugin", "hash1", "installed"))?;
        let err = require_enabled_permission(c, "com.a.plugin", "pluginStorage.read").unwrap_err();
        assert!(err.to_string().contains("not enabled"));

        approve(c, "com.a.plugin", "hash1", None, "unsigned")?;
        let err = require_enabled_permission(c, "com.a.plugin", "pluginStorage.read").unwrap_err();
        assert!(err.to_string().contains("lacks permission"));

        let mut input = upsert_input("com.storage.plugin", "hash1", SOURCE_BUILTIN);
        input.permissions = vec!["pluginStorage.read".into()];
        upsert(c, input)?;
        let rec = require_enabled_permission(c, "com.storage.plugin", "pluginStorage.read")?;
        assert!(rec.enabled);
        Ok(())
    })
    .unwrap();
}

#[test]
fn parse_artifacts_reads_manifest_declarations() {
    let manifest = serde_json::json!({
        "contributes": {
            "artifacts": [{
                "id": "typst-compiler",
                "kind": "wasm",
                "version": "0.1.0",
                "url": "https://example.com/typst.wasm",
                "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "fileName": "typst.wasm",
                "sizeBytes": 123
            }]
        }
    });
    let artifacts = parse_artifacts(&manifest).unwrap();
    assert_eq!(artifacts.len(), 1);
    assert_eq!(artifacts[0].id, "typst-compiler");
    assert_eq!(artifacts[0].file_name, "typst.wasm");
    assert_eq!(artifacts[0].size_bytes, Some(123));
}

#[test]
fn parse_native_tools_reads_manifest_declarations() {
    let manifest = serde_json::json!({
        "contributes": {
            "nativeTools": [{
                "id": "typst",
                "binaryName": "typst",
                "descriptionKey": "native.typst.description"
            }]
        }
    });
    let tools = parse_native_tools(&manifest).unwrap();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].id, "typst");
    assert_eq!(tools[0].binary_name, "typst");
}

#[test]
fn native_tool_binary_names_are_exact_basenames() {
    assert!(validate_binary_name("typst").is_ok());
    assert!(validate_binary_name("typst.exe").is_ok());
    assert!(validate_binary_name("../typst").is_err());
    assert!(validate_binary_name("tools/typst").is_err());
    assert!(validate_binary_name("typst.cmd").is_err());
}

#[test]
fn plugin_storage_paths_reject_traversal_and_absolute_paths() {
    assert!(split_plugin_rel_path("cache/compiler.json", false).is_ok());
    assert!(split_plugin_rel_path("../escape", false).is_err());
    assert!(split_plugin_rel_path("cache/../escape", false).is_err());
    assert!(split_plugin_rel_path("/absolute", false).is_err());
    assert!(split_plugin_rel_path("", false).is_err());
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
            enabled_by_default: true,
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
        "test-checksum",
        vec!["templates.contribute".into()],
        "render",
        serde_json::json!({ "name": "Hi" }),
        Vec::new(),
        None,
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
        &plugin.checksum,
        vec!["notes.read".into(), "notes.create".into()],
        "renderTemplate",
        serde_json::json!({
            "title": "Log {{date:YYYY}}",
            "body": "# {{title|upper}}\nid={{uuid}}\nweek={{date+7d:YYYY-MM-DD}}",
            "now": "2026-07-25T10:00:00Z",
        }),
        Vec::new(),
        None,
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
        &plugin.checksum,
        vec!["notes.read".into(), "notes.create".into()],
        "renderTemplate",
        serde_json::json!({
            "title": "{{date:MMMM}}",
            "body": "",
            "now": "2026-07-25T10:00:00Z",
            "locale": "de",
        }),
        Vec::new(),
        None,
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
        "test-checksum",
        vec![],
        "render",
        serde_json::json!({}),
        Vec::new(),
        None,
    );
    assert!(out.is_err());
}

#[test]
fn run_plugin_script_executes_wasm_entry_with_input() {
    fn pack(ptr: u32, len: usize) -> u64 {
        ((ptr as u64) << 32) | len as u64
    }
    fn wat_string(s: &str) -> String {
        s.replace('\\', "\\5c")
            .replace('"', "\\22")
            .replace('\n', "\\0a")
    }

    let dir = std::env::temp_dir().join(format!("ms-wasm-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let json = r#"{"effect":"toast","message":"hi"}"#;
    let wasm = wat::parse_str(format!(
        r#"(module
          (memory (export "memory") 1)
          (global $heap (mut i32) (i32.const 1024))
          (func (export "alloc") (param $len i32) (result i32)
            (local $ptr i32)
            global.get $heap
            local.set $ptr
            global.get $heap
            local.get $len
            i32.add
            global.set $heap
            local.get $ptr)
          (data (i32.const 32) "{}")
          (func (export "render") (param i32) (param i32) (result i64)
            i64.const {}))
        "#,
        wat_string(json),
        pack(32, json.len())
    ))
    .unwrap();
    std::fs::write(dir.join("main.wasm"), wasm).unwrap();
    let manifest = serde_json::json!({
        "id": "com.a.wasm", "runtime": "wasm", "entry": "main.wasm"
    });
    let out = run_plugin_script(
        &super::discovery::PluginFiles::Fs(dir.clone()),
        &manifest,
        "test-checksum",
        vec![],
        "render",
        serde_json::json!({ "name": "Hi" }),
        Vec::new(),
        None,
    )
    .unwrap();
    assert_eq!(out["effect"], serde_json::json!("toast"));
    assert_eq!(out["message"], serde_json::json!("hi"));
    std::fs::remove_dir_all(&dir).ok();
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

#[test]
fn sha256_hex_is_lowercase_and_matches_the_known_digest() {
    // Empty-input SHA-256 is a well-known constant.
    assert_eq!(
        sha256_hex(b""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(sha256_hex(b"abc").len(), 64);
    assert!(sha256_hex(b"abc").bytes().all(|b| !b.is_ascii_uppercase()));
}

#[test]
fn safe_segment_accepts_plain_names_and_rejects_traversal() {
    assert!(safe_segment("cache", "seg").is_ok());
    assert!(safe_segment("file.name-1_2", "seg").is_ok());
    assert!(safe_segment("", "seg").is_err());
    assert!(safe_segment(".", "seg").is_err());
    assert!(safe_segment("..", "seg").is_err());
    assert!(safe_segment("has space", "seg").is_err());
    assert!(safe_segment("has/slash", "seg").is_err());
}

#[test]
fn validate_binary_name_rejects_backslash_and_empty() {
    assert!(validate_binary_name("").is_err());
    assert!(validate_binary_name("tools\\typst").is_err());
    assert!(validate_binary_name("ty..pst").is_err());
    // A `+` is allowed (some tool basenames carry it), non-exe extensions are not.
    assert!(validate_binary_name("clang++").is_ok());
    assert!(validate_binary_name("typst.bat").is_err());
}

#[test]
fn validate_native_tool_args_enforces_count_and_size_and_nul() {
    assert!(validate_native_tool_args(&["--version".into()], &None).is_ok());
    // Too many args.
    let many = vec!["x".to_string(); MAX_NATIVE_TOOL_ARGS + 1];
    assert!(validate_native_tool_args(&many, &None).is_err());
    // An arg carrying a NUL byte.
    assert!(validate_native_tool_args(&["a\0b".into()], &None).is_err());
    // Oversized arg.
    let big = "a".repeat(MAX_NATIVE_TOOL_ARG_BYTES + 1);
    assert!(validate_native_tool_args(&[big], &None).is_err());
    // NUL in stdin.
    assert!(validate_native_tool_args(&[], &Some("in\0put".into())).is_err());
}

#[test]
fn split_plugin_rel_path_normalizes_and_allows_empty_when_asked() {
    assert_eq!(
        split_plugin_rel_path("a/b/c", false).unwrap(),
        vec!["a", "b", "c"]
    );
    // Trailing slashes are trimmed away.
    assert_eq!(split_plugin_rel_path("a/", true).unwrap(), vec!["a"]);
    // A leading slash is rejected outright (absolute paths aren't allowed).
    assert!(split_plugin_rel_path("/a", true).is_err());
    // Empty resolves to no segments only when the caller opts in.
    assert!(split_plugin_rel_path("", true).unwrap().is_empty());
    assert!(split_plugin_rel_path("a\\b", true).is_err());
}

#[test]
fn parse_artifacts_and_native_tools_reject_malformed_declarations() {
    let bad_artifacts = serde_json::json!({
        "contributes": { "artifacts": [{ "id": 5 }] }
    });
    assert!(matches!(
        parse_artifacts(&bad_artifacts).unwrap_err(),
        AppError::InvalidArg(_)
    ));
    let bad_tools = serde_json::json!({
        "contributes": { "nativeTools": "not-an-array" }
    });
    assert!(matches!(
        parse_native_tools(&bad_tools).unwrap_err(),
        AppError::InvalidArg(_)
    ));
    // Absent contributions parse to an empty vec, not an error.
    assert!(parse_artifacts(&serde_json::json!({})).unwrap().is_empty());
    assert!(parse_native_tools(&serde_json::json!({}))
        .unwrap()
        .is_empty());
}

#[test]
fn find_native_tool_returns_the_match_or_not_found() {
    let manifest = serde_json::json!({
        "contributes": { "nativeTools": [{ "id": "typst", "binaryName": "typst" }] }
    });
    assert_eq!(find_native_tool(&manifest, "typst").unwrap().id, "typst");
    assert!(matches!(
        find_native_tool(&manifest, "ghost").unwrap_err(),
        AppError::NotFound(_)
    ));
}

#[test]
fn manifest_id_defaults_when_absent() {
    assert_eq!(manifest_id(&serde_json::json!({ "id": "com.x" })), "com.x");
    assert_eq!(manifest_id(&serde_json::json!({})), "plugin");
    // A non-string id also falls back.
    assert_eq!(manifest_id(&serde_json::json!({ "id": 7 })), "plugin");
}

#[test]
fn manifest_entry_validates_extension_and_rejects_traversal() {
    let ok = serde_json::json!({ "entry": "main.luau" });
    assert_eq!(manifest_entry(&ok, "luau", ".luau").unwrap(), "main.luau");
    // No entry at all.
    assert!(manifest_entry(&serde_json::json!({}), "luau", ".luau").is_err());
    // Wrong extension.
    let wrong = serde_json::json!({ "entry": "main.js" });
    assert!(manifest_entry(&wrong, "luau", ".luau").is_err());
    // Traversal in the entry path.
    let evil = serde_json::json!({ "entry": "../main.luau" });
    assert!(manifest_entry(&evil, "luau", ".luau").is_err());
    let nested = serde_json::json!({ "entry": "sub/main.luau" });
    assert!(manifest_entry(&nested, "luau", ".luau").is_err());
}

#[test]
fn enabled_by_default_serde_default_is_true() {
    // The serde default only fires when a discovery payload omits the field;
    // the tests build `UpsertPlugin` directly, so exercise it explicitly.
    assert!(default_enabled_by_default());
}

/// A throwaway directory under the OS temp dir, unique per call.
fn scratch_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("ms-plugins-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn disable_crashed_disables_and_records_the_reason() {
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        upsert(c, upsert_input("com.crash.plugin", "h", "installed"))?;
        disable_crashed(c, "com.crash.plugin", "host runtime panicked")?;
        let rec = require(c, "com.crash.plugin")?;
        assert!(!rec.enabled, "a crashed plugin must stay disabled");
        assert_eq!(
            rec.last_load_error.as_deref(),
            Some("host runtime panicked"),
            "the crash reason is surfaced via last_load_error"
        );
        Ok(())
    })
    .unwrap();
}

#[test]
fn ensure_inside_data_root_guards_escapes() {
    let tmp = scratch_dir();
    let root = tmp.join("data");
    std::fs::create_dir_all(root.join("sub")).unwrap();

    // A real dir inside the root is accepted.
    assert!(ensure_inside_data_root(&root, &root.join("sub")).is_ok());

    // A sibling dir outside the root is rejected.
    let outside = tmp.join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    assert!(ensure_inside_data_root(&root, &outside).is_err());

    // A non-existent target can't be canonicalized, so it's rejected too.
    assert!(ensure_inside_data_root(&root, &root.join("ghost")).is_err());

    std::fs::remove_dir_all(&tmp).ok();
}

#[test]
fn ensure_write_target_safe_allows_inside_and_rejects_escapes() {
    let tmp = scratch_dir();
    let root = tmp.join("data");
    std::fs::create_dir_all(&root).unwrap();

    // A not-yet-existing file directly under the root is allowed (its parent
    // is inside the root).
    let new_file = root.join("cache.json");
    assert!(ensure_write_target_safe(&root, &new_file).is_ok());

    // Once written as a plain file it's still allowed.
    std::fs::write(&new_file, b"x").unwrap();
    assert!(ensure_write_target_safe(&root, &new_file).is_ok());

    // A file whose parent sits outside the root escapes and is rejected.
    assert!(ensure_write_target_safe(&root, &tmp.join("loose.txt")).is_err());

    // A missing intermediate directory can't be canonicalized → rejected.
    assert!(ensure_write_target_safe(&root, &root.join("missing").join("f")).is_err());

    std::fs::remove_dir_all(&tmp).ok();
}

#[cfg(unix)]
#[test]
fn ensure_write_target_safe_rejects_symlinks() {
    let tmp = scratch_dir();
    let root = tmp.join("data");
    std::fs::create_dir_all(&root).unwrap();
    let link = root.join("link");
    std::os::unix::fs::symlink(tmp.join("real"), &link).unwrap();
    assert!(ensure_write_target_safe(&root, &link).is_err());
    std::fs::remove_dir_all(&tmp).ok();
}

#[test]
fn path_extensions_offers_candidates() {
    #[cfg(windows)]
    {
        // A name that already carries an extension is used verbatim.
        assert_eq!(
            path_extensions("typst.exe"),
            vec![std::ffi::OsString::new()]
        );
        // A bare name gets `.exe` appended among its candidates.
        let candidates = path_extensions("typst");
        assert!(candidates
            .iter()
            .any(|ext| ext.to_string_lossy().eq_ignore_ascii_case(".exe")));
    }
    #[cfg(not(windows))]
    {
        // Off Windows there is no PATHEXT dance: use the name as-is.
        assert_eq!(path_extensions("typst"), vec![std::ffi::OsString::new()]);
    }
}

#[test]
fn resolve_path_binary_validates_then_misses_unknown() {
    // An unsafe binary name is rejected before touching the filesystem.
    assert!(resolve_path_binary("../typst").is_err());
    // A binary that is certainly not installed resolves to None.
    assert!(resolve_path_binary("ms-definitely-not-a-real-binary-xyz")
        .unwrap()
        .is_none());
}

#[test]
fn native_tool_status_reflects_binary_resolution() {
    let tool = parse_native_tools(&serde_json::json!({
        "contributes": {
            "nativeTools": [{ "id": "typst", "binaryName": "ms-not-a-real-binary-xyz" }]
        }
    }))
    .unwrap()
    .remove(0);

    let status = native_tool_status("com.x.plugin", &tool).unwrap();
    assert_eq!(status.plugin_id, "com.x.plugin");
    assert_eq!(status.tool_id, "typst");
    assert_eq!(status.binary_name, "ms-not-a-real-binary-xyz");
    // The bogus binary isn't on PATH, so it's unavailable and pathless.
    assert!(!status.available);
    assert!(status.path.is_none());
    // `available` is exactly "did we find a path".
    assert_eq!(status.available, status.path.is_some());
}

#[test]
fn resolve_native_tools_maps_every_declared_tool() {
    let manifest = serde_json::json!({
        "contributes": {
            "nativeTools": [
                { "id": "typst", "binaryName": "ms-not-real-a-xyz" },
                { "id": "other", "binaryName": "ms-not-real-b-xyz" }
            ]
        }
    });
    let resolved = resolve_native_tools(&manifest);
    assert_eq!(resolved.len(), 2);
    assert!(resolved.contains_key("typst"));
    assert!(resolved.contains_key("other"));
    // Unknown binaries resolve to None (also the only outcome on mobile).
    assert!(resolved["typst"].is_none());
    assert!(resolved["other"].is_none());

    // A manifest that declares no native tools yields an empty map.
    assert!(resolve_native_tools(&serde_json::json!({})).is_empty());
}

#[test]
fn find_artifact_returns_the_match_or_not_found() {
    let manifest = serde_json::json!({
        "contributes": {
            "artifacts": [{
                "id": "typst-compiler",
                "kind": "wasm",
                "version": "0.1.0",
                "url": "https://example.com/typst.wasm",
                "sha256": "aaaa",
                "fileName": "typst.wasm"
            }]
        }
    });
    assert_eq!(
        find_artifact(&manifest, "typst-compiler").unwrap().id,
        "typst-compiler"
    );
    assert!(matches!(
        find_artifact(&manifest, "ghost").unwrap_err(),
        AppError::NotFound(_)
    ));
}

#[test]
fn note_snapshot_builds_folder_paths_and_metadata() {
    use crate::collections::{create as create_collection, CreateCollection};
    use crate::notes::{create as create_note, CreateNote};

    let db = open_memory_for_tests();
    let (note_id, inner_id) = db
        .with_conn(|c| -> AppResult<(String, String)> {
            let outer = create_collection(
                c,
                CreateCollection {
                    name: "Outer".into(),
                    parent_collection_id: None,
                },
            )?
            .id;
            let inner = create_collection(
                c,
                CreateCollection {
                    name: "Inner".into(),
                    parent_collection_id: Some(outer),
                },
            )?
            .id;
            let note = create_note(
                c,
                CreateNote {
                    title: Some("Doc".into()),
                    body: Some("hi".into()),
                    parent_collection_id: Some(inner.clone()),
                    note_kind: Some("markdown".into()),
                },
            )?
            .summary
            .id;
            Ok((note, inner))
        })
        .unwrap();

    let snapshot = db.with_conn(note_snapshot).unwrap();
    let meta = snapshot
        .iter()
        .find(|m| m.id == note_id)
        .expect("the created note is in the snapshot");
    assert_eq!(meta.title, "Doc");
    assert_eq!(meta.kind, "markdown");
    // The folder path is the nested folder names joined root-first.
    assert_eq!(meta.folder_path, "Outer / Inner");
    assert_eq!(meta.folder_id.as_deref(), Some(inner_id.as_str()));
}

#[test]
fn limit_readers_clamp_and_fall_back_to_defaults() {
    // Value present but out of range → clamped.
    let over = serde_json::json!({ "limits": { "heap": 999 } });
    assert_eq!(limit_usize(&over, "heap", 10, 1, 100), 100);
    // Absent field → default (itself clamped into range).
    let none = serde_json::json!({});
    assert_eq!(limit_usize(&none, "heap", 10, 1, 100), 10);
    assert_eq!(limit_u64(&over, "heap", 10, 1, 100), 100);

    let dur = serde_json::json!({ "limits": { "timeoutMs": 50 } });
    assert_eq!(
        limit_duration(
            &dur,
            std::time::Duration::from_millis(1000),
            std::time::Duration::from_millis(100),
            std::time::Duration::from_millis(5000),
        ),
        // 50ms is below the 100ms floor → clamped up.
        std::time::Duration::from_millis(100)
    );
    // Absent timeoutMs → the supplied default (already within range).
    assert_eq!(
        limit_duration(
            &none,
            std::time::Duration::from_millis(1000),
            std::time::Duration::from_millis(100),
            std::time::Duration::from_millis(5000),
        ),
        std::time::Duration::from_millis(1000)
    );
}

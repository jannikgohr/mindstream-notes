use super::*;
use crate::db::open_memory_for_tests;

/// Parse a manifest literal the way discovery does, so a test exercises the
/// same schema the backend enforces rather than a hand-rolled struct.
fn manifest_from(value: serde_json::Value) -> manifest::Manifest {
    manifest::Manifest::parse(value.to_string().as_bytes()).expect("valid manifest")
}

/// The minimum a manifest needs, with `extra` merged over it.
fn manifest_with(extra: serde_json::Value) -> manifest::Manifest {
    let mut base = serde_json::json!({
        "manifestVersion": 1,
        "id": "com.a.plugin",
        "name": "A Plugin",
        "version": "1.0.0",
        "runtime": "manifest-only"
    });
    let obj = base.as_object_mut().unwrap();
    for (k, v) in extra.as_object().unwrap() {
        obj.insert(k.clone(), v.clone());
    }
    manifest_from(base)
}

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
        permissions: vec!["notes.create".into()],
        enabled_by_default: true,
        signer: signer.map(String::from),
        signature_status: signature_status.to_string(),
    }
}

/// A script call with nothing but permissions, an export and its input.
fn call(granted: &[&str], export: &str, input: serde_json::Value) -> ScriptCall {
    ScriptCall {
        granted: granted.iter().map(|p| p.to_string()).collect(),
        export: export.into(),
        input,
        notes: Vec::new(),
        data_root: None,
        cancel: runtime::cancel::CancelToken::new(),
        verified_entry: None,
        cache_dir: None,
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
        assert_eq!(rec.granted_permissions, vec!["notes.create".to_string()]);
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
        approve(
            c,
            "com.a.plugin",
            "hash1",
            &["notes.create".to_string()],
            None,
            "unsigned",
        )?;
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
        approve(
            c,
            "com.a.plugin",
            "hash1",
            &["notes.create".to_string()],
            None,
            "unsigned",
        )?;
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
        let rec = approve(
            c,
            "com.a.plugin",
            "hash2",
            &["notes.create".to_string()],
            None,
            "unsigned",
        )?;
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
fn permission_gate_requires_enabled_and_granted() {
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        upsert(c, upsert_input("com.a.plugin", "hash1", "installed"))?;
        let rec = require(c, "com.a.plugin")?;
        let err = require_enabled(&rec).unwrap_err();
        assert!(err.to_string().contains("not enabled"));

        approve(
            c,
            "com.a.plugin",
            "hash1",
            &["notes.create".to_string()],
            None,
            "unsigned",
        )?;
        let rec = require(c, "com.a.plugin")?;
        require_enabled(&rec).expect("approved plugins are enabled");
        // The grant is what is checked, not what the manifest asked for.
        let err = require_permission(&rec, "pluginStorage.read").unwrap_err();
        assert!(err.to_string().contains("lacks permission"));
        require_permission(&rec, "notes.create").expect("granted capability passes");
        Ok(())
    })
    .unwrap();
}

#[test]
fn artifact_and_native_tool_declarations_reach_the_backend() {
    let m = manifest_with(serde_json::json!({
        "permissions": ["pluginArtifacts.download", "nativeTools.runDeclared"],
        "contributes": {
            "artifacts": [{
                "id": "typst-compiler",
                "kind": "wasm",
                "version": "0.1.0",
                "url": "https://example.com/typst.wasm",
                "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "fileName": "typst.wasm",
                "sizeBytes": 123
            }],
            "nativeTools": [{
                "id": "typst",
                "binaryName": "typst",
                "descriptionKey": "native.typst.description"
            }]
        }
    }));
    let artifact = m.artifact("typst-compiler").unwrap();
    assert_eq!(artifact.file_name, "typst.wasm");
    assert_eq!(artifact.size_bytes, Some(123));
    assert_eq!(m.native_tool("typst").unwrap().binary_name, "typst");
    // Absent declarations are an empty list, not an error.
    assert!(manifest_with(serde_json::json!({}))
        .contributes
        .artifacts
        .is_empty());
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
        approve(
            c,
            "com.a.p",
            "h1",
            &["notes.create".to_string()],
            Some("keyA"),
            "valid",
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
        approve(
            c,
            "com.a.p",
            "h1",
            &["notes.create".to_string()],
            Some("keyA"),
            "valid",
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
        approve(
            c,
            "com.a.p",
            "h1",
            &["notes.create".to_string()],
            Some("keyA"),
            "valid",
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
            generation: None,
            legacy_generation: None,
            lease: None,
            id: "com.a.plugin".into(),
            version: "1.0.0".into(),
            permissions: vec!["notes.create".into()],
            enabled_by_default: true,
            source: SOURCE_BUILTIN.into(),
            files: super::discovery::PluginFiles::Fs(std::path::PathBuf::new()),
            checksum: "hash1".into(),
            signer: None,
            signature_status: "unsigned".into(),
            manifest: manifest_with(serde_json::json!({})),
            manifest_json: serde_json::json!({ "id": "com.a.plugin", "name": "A" }),
            entry_bytes: None,
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
    let manifest = manifest_with(serde_json::json!({
        "id": "com.a.luau",
        "runtime": "luau",
        "entry": "main.luau",
        "permissions": ["nativeTools.runDeclared"],
        "contributes": {
            "nativeTools": [{ "id": "missing", "binaryName": "ms-not-a-real-binary-xyz" }]
        }
    }));
    let out = run_plugin_script(
        &super::discovery::PluginFiles::Fs(dir.clone()),
        &manifest,
        call(
            &["nativeTools.runDeclared"],
            "render",
            serde_json::json!({ "name": "Hi" }),
        ),
    )
    .unwrap();
    assert_eq!(out["title"], serde_json::json!("Hi"));
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn templates_plugin_renders_macros_in_wasm() {
    // The embedded Templates component owns the macro engine.
    let plugin = super::discovery::discover_builtins()
        .into_iter()
        .find(|p| p.id == "com.mindstream.templates.core")
        .expect("embedded Templates plugin");
    let out = run_plugin_script(
        &plugin.files,
        &plugin.manifest,
        call(
            &["notes.read", "notes.create"],
            "renderTemplate",
            serde_json::json!({
                "title": "Log {{date:YYYY}}",
                "body": "# {{title|upper}}\nid={{uuid}}\nweek={{date+7d:YYYY-MM-DD}}",
                "now": "2026-07-25T10:00:00Z",
            }),
        ),
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
    // The `locale` on the render input threads through to the host clock, so a German
    // template gets German month names.
    let plugin = super::discovery::discover_builtins()
        .into_iter()
        .find(|p| p.id == "com.mindstream.templates.core")
        .expect("embedded Templates plugin");
    let out = run_plugin_script(
        &plugin.files,
        &plugin.manifest,
        call(
            &["notes.read", "notes.create"],
            "renderTemplate",
            serde_json::json!({
                "title": "{{date:MMMM}}",
                "body": "",
                "now": "2026-07-25T10:00:00Z",
                "locale": "de",
            }),
        ),
    )
    .unwrap();
    assert_eq!(out["title"], serde_json::json!("Juli"));
}

#[test]
fn bundled_template_wasm_matches_retained_luau_for_existing_templates() {
    let plugin = discovery::discover_builtins()
        .into_iter()
        .find(|p| p.id == "com.mindstream.templates.core")
        .unwrap();
    let mut legacy = plugin.manifest.clone();
    legacy.runtime = manifest::PluginRuntime::Luau;
    legacy.manifest_version = 1;
    legacy.entry = Some("main.luau".into());
    for input in [
        serde_json::json!({"now": "2026-07-25T10:00:00Z", "title": "Log {{date:YYYY}}", "body": "{{title|upper}} {{date-1M+2d:YYYY-MM-DD}} {{date+7d:dddd}}", "locale": "de"}),
        serde_json::json!({"now": "2026-01-31T12:00:00Z", "body": "{{date+1M:YYYY-MM-DD}} {{date-1y+2w:YYYY-MM-DD}} {{word|trim|capitalize}}/{{word|slug}}/{{flag}}/{{number}}/{{missing}}/{{word|unknown}}", "vars": {"word": "  hÄllo WORLD  ", "flag": false, "number": 42}}),
        serde_json::json!({"now": "2026-07-25T10:00:00Z", "title": "{{unknown}}", "body": "{{date:}} {{multi\nline}} {{literal", "vars": {"multi\nline": "yes"}}),
    ] {
        let invoke = |manifest| {
            run_plugin_script(
                &plugin.files,
                manifest,
                call(
                    &["notes.read", "notes.create"],
                    "renderTemplate",
                    input.clone(),
                ),
            )
            .unwrap()
        };
        assert_eq!(invoke(&plugin.manifest), invoke(&legacy), "{input}");
    }
    let input = serde_json::json!({
        "settings": {"source-folder": "root", "source-tag": "template"},
        "folders": [{"id": "root", "parentId": null}, {"id": "child", "parentId": "root"}, {"id": "cycle", "parentId": "cycle"}]
    });
    let invoke = |manifest| {
        let mut request = call(
            &["notes.read", "notes.create"],
            "newFromTemplate",
            input.clone(),
        );
        request.notes = [
            ("z", "Zulu", "child", "kanban", false),
            (
                "a",
                "Alpha",
                "other",
                "plugin.com.mindstream.typst.document",
                true,
            ),
            ("x", "Other", "cycle", "markdown", false),
        ]
        .into_iter()
        .map(
            |(id, title, folder, kind, tagged)| runtime::host::NoteMeta {
                id: id.into(),
                title: title.into(),
                folder_id: Some(folder.into()),
                kind: kind.into(),
                tags: if tagged {
                    vec!["template".into()]
                } else {
                    vec![]
                },
                folder_path: String::new(),
                created: String::new(),
                modified: String::new(),
            },
        )
        .collect();
        run_plugin_script(&plugin.files, manifest, request).unwrap()
    };
    assert_eq!(invoke(&plugin.manifest), invoke(&legacy));
}

#[test]
fn bundled_typst_without_native_permission_keeps_source_editing() {
    let plugin = discovery::discover_builtins()
        .into_iter()
        .find(|p| p.id == "com.mindstream.typst")
        .unwrap();
    assert_eq!(plugin.manifest.runtime, manifest::PluginRuntime::Wasm);
    for export in ["renderDocument", "exportDocument"] {
        let out = run_plugin_script(
            &plugin.files,
            &plugin.manifest,
            call(&[], export, serde_json::json!({"body": "= Hello"})),
        )
        .unwrap();
        assert_eq!(
            out,
            serde_json::json!({"sourceOnly": true, "diagnostics": []})
        );
    }
}

/// The conformance component the runtime crate's tests use.
const CONFORMANCE_WASM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../plugin-sdk/conformance/dist/conformance-rust.wasm"
));

fn write_wasm_plugin(dir: &std::path::Path, permissions: serde_json::Value) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join("plugin.wasm"), CONFORMANCE_WASM).unwrap();
    std::fs::write(
        dir.join("manifest.json"),
        serde_json::json!({
            "manifestVersion": 2,
            "id": "com.a.wasm",
            "name": "Wasm",
            "version": "1.0.0",
            "runtime": "wasm",
            "entry": "plugin.wasm",
            "permissions": permissions,
        })
        .to_string(),
    )
    .unwrap();
}

#[test]
fn a_wasm_plugin_on_disk_carries_the_bytes_its_checksum_covers() {
    let dir = std::env::temp_dir().join(format!("ms-wasm-plugin-{}", uuid::Uuid::new_v4()));
    write_wasm_plugin(&dir, serde_json::json!([]));
    let plugin =
        discovery::read_plugin(discovery::PluginFiles::Fs(dir.clone()), SOURCE_INSTALLED).unwrap();
    assert_eq!(plugin.manifest.runtime, manifest::PluginRuntime::Wasm);
    assert_eq!(
        plugin.entry_bytes.as_deref().map(Vec::as_slice),
        Some(CONFORMANCE_WASM)
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn run_plugin_script_executes_a_wasm_component() {
    let dir = std::env::temp_dir().join(format!("ms-wasm-plugin-{}", uuid::Uuid::new_v4()));
    write_wasm_plugin(&dir, serde_json::json!(["notes.read"]));
    let plugin =
        discovery::read_plugin(discovery::PluginFiles::Fs(dir.clone()), SOURCE_INSTALLED).unwrap();
    let mut menu = call(
        &["notes.read"],
        "menu",
        serde_json::json!({ "settings": { "tag": "tpl" } }),
    );
    menu.notes = vec![runtime::host::NoteMeta {
        id: "n1".into(),
        title: "Daily".into(),
        tags: vec!["tpl".into()],
        kind: "markdown".into(),
        folder_id: None,
        folder_path: String::new(),
        created: "2026-07-26T00:00:00Z".into(),
        modified: "2026-07-26T00:00:00Z".into(),
    }];
    menu.verified_entry = plugin.entry_bytes.clone();
    let out = run_plugin_script(&plugin.files, &plugin.manifest, menu).unwrap();
    assert_eq!(out["effect"], "openMenu");
    assert_eq!(out["items"][0]["run"]["sourceNoteId"], "n1");

    // Without the verified bytes the entry is read from the package.
    let echo = run_plugin_script(
        &plugin.files,
        &plugin.manifest,
        call(&[], "echo", serde_json::json!({ "x": 1 })),
    )
    .unwrap();
    assert_eq!(echo, serde_json::json!({ "x": 1 }));

    // The granted set, not the manifest, decides: notes.read was not passed.
    let denied = run_plugin_script(
        &plugin.files,
        &plugin.manifest,
        call(&[], "menu", serde_json::json!({})),
    )
    .unwrap_err();
    assert!(denied.to_string().contains("Denied"), "{denied}");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn wasm_limits_come_from_the_wasm_policy() {
    let m = manifest_with(serde_json::json!({
        "manifestVersion": 2, "runtime": "wasm", "entry": "plugin.wasm",
        "limits": { "memoryBytes": 1 }
    }));
    let limits = script_limits(&m);
    assert_eq!(limits.memory_bytes, 4 * 1024 * 1024, "the wasm floor");
    assert_eq!(
        limits.timeout,
        std::time::Duration::from_secs(1),
        "the wasm default"
    );
}

#[test]
fn run_plugin_script_refuses_a_non_luau_runtime() {
    let manifest = manifest_with(serde_json::json!({}));
    let out = run_plugin_script(
        &super::discovery::PluginFiles::Fs(std::env::temp_dir()),
        &manifest,
        call(&[], "render", serde_json::json!({})),
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
fn malformed_declarations_stop_the_whole_manifest() {
    // A malformed declaration used to surface only when something reached for
    // it. Now the plugin fails to load, which is the honest outcome: the
    // manifest does not describe something the backend can act on.
    for bad in [
        serde_json::json!({ "contributes": { "artifacts": [{ "id": 5 }] } }),
        serde_json::json!({ "contributes": { "nativeTools": "not-an-array" } }),
    ] {
        let mut v = serde_json::json!({
            "manifestVersion": 1, "id": "com.a.plugin", "name": "A",
            "version": "1.0.0", "runtime": "manifest-only"
        });
        let obj = v.as_object_mut().unwrap();
        for (k, val) in bad.as_object().unwrap() {
            obj.insert(k.clone(), val.clone());
        }
        assert!(manifest::Manifest::parse(v.to_string().as_bytes()).is_err());
    }
}

#[test]
fn require_native_tool_returns_the_match_or_not_found() {
    let m = manifest_with(serde_json::json!({
        "permissions": ["nativeTools.runDeclared"],
        "contributes": { "nativeTools": [{ "id": "typst", "binaryName": "typst" }] }
    }));
    assert_eq!(require_native_tool(&m, "typst").unwrap().id, "typst");
    assert!(matches!(
        require_native_tool(&m, "ghost").unwrap_err(),
        AppError::NotFound(_)
    ));
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
    let m = manifest_with(serde_json::json!({
        "permissions": ["nativeTools.runDeclared"],
        "contributes": {
            "nativeTools": [{ "id": "typst", "binaryName": "ms-not-a-real-binary-xyz" }]
        }
    }));
    let tool = m.native_tool("typst").unwrap();

    let status = native_tool_status("com.x.plugin", tool).unwrap();
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
    let manifest = manifest_with(serde_json::json!({
        "permissions": ["nativeTools.runDeclared"],
        "contributes": {
            "nativeTools": [
                { "id": "typst", "binaryName": "ms-not-real-a-xyz" },
                { "id": "other", "binaryName": "ms-not-real-b-xyz" }
            ]
        }
    }));
    let resolved = resolve_native_tools(&manifest);
    assert_eq!(resolved.len(), 2);
    assert!(resolved.contains_key("typst"));
    assert!(resolved.contains_key("other"));
    // Unknown binaries resolve to None (also the only outcome on mobile).
    assert!(resolved["typst"].is_none());
    assert!(resolved["other"].is_none());

    // A manifest that declares no native tools yields an empty map.
    assert!(resolve_native_tools(&manifest_with(serde_json::json!({}))).is_empty());
}

#[test]
fn require_artifact_returns_the_match_or_not_found() {
    let manifest = manifest_with(serde_json::json!({
        "permissions": ["pluginArtifacts.download"],
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
    }));
    assert_eq!(
        require_artifact(&manifest, "typst-compiler").unwrap().id,
        "typst-compiler"
    );
    assert!(matches!(
        require_artifact(&manifest, "ghost").unwrap_err(),
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
fn a_manifests_declared_limits_are_clamped_by_its_runtime() {
    // A manifest may ask; only the host decides.
    let m = manifest_with(serde_json::json!({
        "runtime": "luau", "entry": "main.luau",
        "limits": { "memoryBytes": 1, "timeoutMs": 999999 }
    }));
    let limits = script_limits(&m);
    assert_eq!(limits.memory_bytes, 1024 * 1024, "clamped up to the floor");
    assert_eq!(
        limits.timeout,
        std::time::Duration::from_millis(5000),
        "clamped down to the ceiling"
    );
}

/// Build a `DiscoveredPlugin` standing for "what is on disk right now". Only
/// `source` and `checksum` matter to the integrity gate; the rest is filler.
fn on_disk(id: &str, checksum: &str, source: &str) -> discovery::DiscoveredPlugin {
    discovery::DiscoveredPlugin {
        generation: None,
        legacy_generation: None,
        lease: None,
        id: id.to_string(),
        version: "1.0.0".to_string(),
        permissions: Vec::new(),
        enabled_by_default: true,
        source: source.to_string(),
        files: discovery::PluginFiles::Fs(PathBuf::from("/nonexistent")),
        checksum: checksum.to_string(),
        signer: None,
        signature_status: "unsigned".to_string(),
        manifest: manifest_with(serde_json::json!({ "id": id })),
        manifest_json: serde_json::json!({ "id": id }),
        entry_bytes: None,
    }
}

#[test]
fn approved_installed_plugin_runs_only_while_its_files_are_unchanged() {
    // The integrity gate used to run only during `reconcile`, so an approved
    // plugin edited while the app was running would execute unapproved bytes on
    // the next toolbar click. Execution paths re-check the checksum themselves.
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        upsert(c, upsert_input("com.a.plugin", "hash1", "installed"))?;
        let rec = approve(
            c,
            "com.a.plugin",
            "hash1",
            &["notes.create".to_string()],
            None,
            "unsigned",
        )?;

        require_approved(&rec, &on_disk("com.a.plugin", "hash1", "installed"))
            .expect("unchanged files are approved");

        let err = require_approved(&rec, &on_disk("com.a.plugin", "hash2", "installed"))
            .expect_err("edited files must not run under the old approval");
        assert!(err.to_string().contains("re-approval required"));
        Ok(())
    })
    .unwrap();
}

#[test]
fn builtin_plugins_are_exempt_from_the_execution_time_gate() {
    // Builtins ship inside the signed app binary: their bytes cannot change
    // without the binary changing, so the accepted hash tracks rather than gates.
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        let rec = upsert(c, upsert_input("com.a.builtin", "hash1", SOURCE_BUILTIN))?;
        require_approved(
            &rec,
            &on_disk("com.a.builtin", "hash-different", SOURCE_BUILTIN),
        )
        .expect("a builtin is trusted by location, not by hash");
        Ok(())
    })
    .unwrap();
}

#[test]
fn load_runnable_rejects_disabled_unapproved_and_ungranted_plugins() {
    let db = open_memory_for_tests();
    let dir = std::env::temp_dir().join("ms-plugins-load-runnable-empty");
    db.with_conn(|c| {
        upsert(c, upsert_input("com.a.plugin", "hash1", "installed"))?;
        // Disabled: refused before the filesystem is touched at all.
        let err = load_runnable(c, &dir, "com.a.plugin", None).unwrap_err();
        assert!(err.to_string().contains("not enabled"));

        approve(
            c,
            "com.a.plugin",
            "hash1",
            &["notes.create".to_string()],
            None,
            "unsigned",
        )?;
        // Enabled and approved, but the capability was never granted.
        let err =
            load_runnable(c, &dir, "com.a.plugin", Some("nativeTools.runDeclared")).unwrap_err();
        assert!(err.to_string().contains("lacks permission"));
        Ok(())
    })
    .unwrap();
}

#[test]
fn load_runnable_returns_the_approved_plugin_from_disk() {
    let root =
        std::env::temp_dir().join(format!("ms-plugins-load-runnable-{}", uuid::Uuid::new_v4()));
    let plugin_dir = root.join("installed-plugin");
    std::fs::create_dir_all(&plugin_dir).unwrap();
    std::fs::write(
        plugin_dir.join("manifest.json"),
        serde_json::json!({
            "manifestVersion": 1,
            "id": "com.a.runnable",
            "name": "Runnable",
            "version": "1.0.0",
            "runtime": "manifest-only",
            "permissions": ["notes.create"]
        })
        .to_string(),
    )
    .unwrap();
    let discovered = discovery::discover(&root)
        .into_iter()
        .find(|plugin| plugin.id == "com.a.runnable")
        .expect("plugin is discovered");

    let db = open_memory_for_tests();
    db.with_conn(|c| {
        let mut input = upsert_input(&discovered.id, &discovered.checksum, SOURCE_INSTALLED);
        input.permissions = discovered.permissions.clone();
        upsert(c, input)?;
        approve(
            c,
            &discovered.id,
            &discovered.checksum,
            &discovered.permissions,
            discovered.signer.as_deref(),
            &discovered.signature_status,
        )?;

        let (record, loaded) = load_runnable(c, &root, &discovered.id, Some("notes.create"))?;
        assert!(record.enabled);
        assert_eq!(loaded.checksum, discovered.checksum);
        Ok(())
    })
    .unwrap();
    std::fs::remove_dir_all(root).ok();
}

#[test]
fn signed_same_signer_update_cannot_widen_its_permissions() {
    // Auto-approving a same-signer update is a claim about *authorship* — the
    // bytes came from the author the user already trusted. It is not the user
    // agreeing to whatever those bytes now ask for. A plugin approved holding
    // notes.create must not be able to grant itself native tool execution by
    // re-signing with the same key.
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        upsert(
            c,
            signed_input("com.a.p", "h1", "installed", Some("keyA"), "valid"),
        )?;
        let rec = approve(
            c,
            "com.a.p",
            "h1",
            &["notes.create".to_string()],
            Some("keyA"),
            "valid",
        )?;
        assert!(rec.enabled);

        let mut wider = signed_input("com.a.p", "h2", "installed", Some("keyA"), "valid");
        wider.permissions = vec![
            "notes.create".to_string(),
            "nativeTools.runDeclared".to_string(),
        ];
        let rec = upsert(c, wider)?;

        assert!(!rec.enabled, "a widening update must be gated");
        assert_eq!(
            rec.granted_permissions,
            vec!["notes.create".to_string()],
            "the pinned grant is kept, not replaced"
        );
        assert_eq!(
            rec.accepted_hash, "h1",
            "the approved hash is kept so the old bytes stay identifiable"
        );
        // The reason names what was added — "needs re-approval" alone gives the
        // user nothing to decide on.
        let reason = rec.last_load_error.unwrap();
        assert!(reason.contains("new permissions"), "{reason}");
        assert!(reason.contains("nativeTools.runDeclared"), "{reason}");
        Ok(())
    })
    .unwrap();
}

#[test]
fn resigning_identical_code_cannot_replace_the_pinned_signer() {
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        upsert(
            c,
            signed_input("com.a.p", "h1", SOURCE_INSTALLED, Some("keyA"), "valid"),
        )?;
        approve(
            c,
            "com.a.p",
            "h1",
            &["notes.create".into()],
            Some("keyA"),
            "valid",
        )?;
        for hash in ["h1", "h1", "h2"] {
            let record = upsert(
                c,
                signed_input("com.a.p", hash, SOURCE_INSTALLED, Some("keyB"), "valid"),
            )?;
            assert!(!record.enabled);
            assert_eq!(record.signer.as_deref(), Some("keyA"));
            assert_eq!(record.accepted_hash, "h1");
            assert!(record.last_load_error.unwrap().contains("different key"));
        }
        Ok(())
    })
    .unwrap();
}

#[test]
fn signed_same_signer_update_may_narrow_its_permissions() {
    // Dropping a permission needs no ceremony: the user already agreed to more.
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        let mut wide = signed_input("com.a.p", "h1", "installed", Some("keyA"), "valid");
        wide.permissions = vec!["notes.create".to_string(), "notes.read".to_string()];
        upsert(c, wide)?;
        approve(
            c,
            "com.a.p",
            "h1",
            &["notes.create".to_string(), "notes.read".to_string()],
            Some("keyA"),
            "valid",
        )?;

        let mut narrower = signed_input("com.a.p", "h2", "installed", Some("keyA"), "valid");
        narrower.permissions = vec!["notes.read".to_string()];
        let rec = upsert(c, narrower)?;

        assert!(rec.enabled, "narrowing stays enabled");
        assert_eq!(rec.granted_permissions, vec!["notes.read".to_string()]);
        assert_eq!(rec.accepted_hash, "h2");
        Ok(())
    })
    .unwrap();
}

#[test]
fn builtin_updates_may_widen_their_permissions() {
    // Builtins ship inside the signed binary, so their manifest is exactly as
    // authoritative as the app asking the question.
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        upsert(c, upsert_input("com.a.builtin", "h1", SOURCE_BUILTIN))?;
        let mut wider = upsert_input("com.a.builtin", "h2", SOURCE_BUILTIN);
        wider.permissions = vec![
            "notes.create".to_string(),
            "nativeTools.runDeclared".to_string(),
        ];
        let rec = upsert(c, wider)?;
        assert!(rec.enabled);
        assert!(rec
            .granted_permissions
            .contains(&"nativeTools.runDeclared".to_string()));
        Ok(())
    })
    .unwrap();
}

#[test]
fn approve_pins_the_permission_set_it_was_shown() {
    // The approval prompt lists permissions; the set written has to be that
    // set, or the prompt was describing something other than what happens.
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        upsert(c, upsert_input("com.a.plugin", "h1", "installed"))?;
        let rec = approve(
            c,
            "com.a.plugin",
            "h1",
            &["notes.read".to_string()],
            None,
            "unsigned",
        )?;
        assert_eq!(rec.granted_permissions, vec!["notes.read".to_string()]);
        assert!(rec.enabled);
        Ok(())
    })
    .unwrap();
}

#[test]
fn backend_owns_settings_folders_and_the_clock() {
    // These three used to be assembled in the WebView and passed down as the
    // script's argument, which is what made a UI action the only thing that
    // could ever invoke a plugin. The backend builds them now.
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        settings::set(c, "com.a.p", "source-folder", &serde_json::json!("f1"))?;
        settings::set(c, "com.a.p", "open-on-create", &serde_json::json!(true))?;
        let outer = crate::collections::create(
            c,
            crate::collections::CreateCollection {
                name: "Outer".into(),
                parent_collection_id: None,
            },
        )?;

        let ctx = backend_script_context(c, "com.a.p", &["notes.read".to_string()])?;
        assert_eq!(ctx["settings"]["source-folder"], serde_json::json!("f1"));
        assert_eq!(ctx["settings"]["open-on-create"], serde_json::json!(true));
        // The seeded vault already has folders, so look for ours rather than
        // asserting the whole list.
        let folders = ctx["folders"].as_array().unwrap();
        let ours = folders
            .iter()
            .find(|f| f["id"] == serde_json::json!(outer.id))
            .expect("the created folder reaches the context");
        assert_eq!(ours["name"], serde_json::json!("Outer"));
        assert!(ours["parentId"].is_null());
        assert!(ctx["now"].as_str().unwrap().contains('T'));
        Ok(())
    })
    .unwrap();
}

#[test]
fn folders_stay_behind_notes_read() {
    // Folder names are user content.  is gated, so the vault's shape
    // is too — otherwise the permission means less than it says.
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        crate::collections::create(
            c,
            crate::collections::CreateCollection {
                name: "Private".into(),
                parent_collection_id: None,
            },
        )?;
        let ctx = backend_script_context(c, "com.a.p", &[])?;
        assert_eq!(
            ctx["folders"],
            serde_json::json!([]),
            "no vault structure without notes.read"
        );
        // The plugin's own settings are not vault data, so they still come.
        assert!(ctx["settings"].is_object());
        Ok(())
    })
    .unwrap();
}

#[test]
fn backend_context_wins_over_caller_supplied_keys() {
    // The merge is not a courtesy: a caller must not be able to tell a script
    // that it has settings it does not have, or a clock it does not have.
    let merged = merge_script_input(
        serde_json::json!({
            "noteId": "n1",
            "settings": { "spoofed": true },
            "now": "1999-01-01T00:00:00Z"
        }),
        serde_json::json!({
            "settings": { "real": 1 },
            "folders": [],
            "now": "2026-09-04T00:00:00Z"
        }),
    );
    assert_eq!(merged["settings"], serde_json::json!({ "real": 1 }));
    assert_eq!(merged["now"], serde_json::json!("2026-09-04T00:00:00Z"));
    // Call-specific keys the backend does not own are preserved.
    assert_eq!(merged["noteId"], serde_json::json!("n1"));
}

#[test]
fn backend_context_replaces_a_non_object_input() {
    let backend = serde_json::json!({
        "settings": { "real": true },
        "folders": [],
        "now": "2026-09-04T00:00:00Z"
    });
    assert_eq!(
        merge_script_input(serde_json::json!("not an object"), backend.clone()),
        backend
    );
}

#[test]
fn uninstalling_a_plugin_drops_its_settings() {
    let db = open_memory_for_tests();
    db.with_conn(|c| {
        upsert(c, upsert_input("com.a.p", "h1", "installed"))?;
        settings::set(c, "com.a.p", "k", &serde_json::json!(1))?;
        settings::clear(c, "com.a.p")?;
        remove(c, "com.a.p")?;
        assert!(settings::all(c, "com.a.p")?.is_empty());
        assert!(get(c, "com.a.p")?.is_none());
        Ok(())
    })
    .unwrap();
}

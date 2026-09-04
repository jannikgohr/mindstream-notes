//! The plugin manifest, as the backend understands it.
//!
//! # Why this file exists
//!
//! The manifest used to have two readers that shared no definition. All the
//! real validation lived in `src/lib/plugins/validation.ts` — two thousand
//! lines of it, running in the WebView, downstream of the trust boundary. The
//! backend, which is where the decision to spawn a process or open a socket
//! actually gets made, re-derived what it needed from an untyped
//! `serde_json::Value` in a scatter of ad-hoc helpers, each with its own
//! defaulting rules. `manifest_id` fell back to the literal string `"plugin"`
//! for a manifest with no id; the TypeScript validator rejected that manifest
//! outright. Two parsers, two answers, and no test that they agreed.
//!
//! So this is the schema for everything the **backend acts on**: identity,
//! versioning, the script entry, resource limits, and the three declarations
//! that reach outside the plugin's bundle (artifacts, native tools, native
//! services). Parsed once, in [`super::discovery::read_plugin`], before
//! anything is run.
//!
//! # What is still TypeScript's
//!
//! Contributions the backend never acts on — i18n bundles, settings controls,
//! documentation sections, labels, note templates — stay in `types.ts` and
//! `validation.ts`. That split is honest rather than expedient: those are
//! presentational, the frontend is the only thing that reads them, and
//! describing them here would add a second definition of exactly the kind this
//! file exists to remove. They ride through as [`Manifest::contributes`].
//!
//! # Keeping TypeScript in sync
//!
//! The types below derive `TS`, and `cargo test export_bindings` writes them to
//! `src/lib/plugins/generated/`. Those files are committed, and
//! `bindings_are_up_to_date` fails if they drift from the Rust, so the
//! generated half can never quietly disagree with the enforced half.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The manifest schema version this build writes and accepts.
///
/// Bumped only for a change that is not backwards compatible — a field that
/// changes meaning, a default that flips. Additive changes do not bump it,
/// because the forward-compatibility rules cover them: an unknown contribution
/// is dropped with a warning, an unknown permission is fatal.
pub const CURRENT_MANIFEST_VERSION: u32 = 1;

/// How a plugin produces its contributions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "../../src/lib/plugins/generated/")]
pub enum PluginRuntime {
    /// Purely declarative: everything comes from the manifest, no code runs.
    ManifestOnly,
    /// A sandboxed Luau `entry` script, run in this backend.
    Luau,
}

impl PluginRuntime {
    pub fn is_scripted(self) -> bool {
        matches!(self, PluginRuntime::Luau)
    }
}

/// Optional resource bounds for one script invocation. The backend clamps both
/// to host-owned minimums and maximums, so a manifest can ask but not exceed.
#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, export_to = "../../src/lib/plugins/generated/")]
pub struct RuntimeLimits {
    /// Guest memory cap in bytes.
    #[ts(type = "number | null")]
    pub memory_bytes: Option<u64>,
    /// Wall-clock timeout in milliseconds.
    #[ts(type = "number | null")]
    pub timeout_ms: Option<u64>,
}

/// Something the host does on a plugin's behalf that reaches outside the
/// plugin's own bundle.
///
/// Only capabilities live here. Contribution *gates* — a permission that merely
/// restated what `contributes` already said — were removed: they gated nothing
/// at runtime, and with no per-permission revocation they were a tautology
/// checked in longhand. An unknown permission is refused rather than ignored,
/// because loading a plugin under a narrower grant than it was written for
/// fails later and further away than refusing it here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize, TS)]
#[ts(export, export_to = "../../src/lib/plugins/generated/")]
pub enum PluginPermission {
    /// Read vault metadata: `ms.notes` and `ctx.folders`. Never note bodies.
    #[serde(rename = "notes.read")]
    NotesRead,
    /// The app creates a note from the plugin's output. The app writes it.
    #[serde(rename = "notes.create")]
    NotesCreate,
    /// Send note text to a network endpoint. The host makes the request.
    #[serde(rename = "textCheckers.contribute")]
    TextCheckersContribute,
    /// The host downloads declared artifacts and verifies their pinned digest.
    #[serde(rename = "pluginArtifacts.download")]
    PluginArtifactsDownload,
    /// Read the plugin's isolated data directory (`ms.storage.read`/`.list`).
    #[serde(rename = "pluginStorage.read")]
    PluginStorageRead,
    /// Write it (`ms.storage.write`/`.delete`).
    #[serde(rename = "pluginStorage.write")]
    PluginStorageWrite,
    /// Run the plugin's declared PATH binaries, directly and never via a shell.
    #[serde(rename = "nativeTools.runDeclared")]
    NativeToolsRunDeclared,
    /// Run a declared binary as a long-lived local preview server.
    #[serde(rename = "nativeServices.run")]
    NativeServicesRun,
}

impl PluginPermission {
    /// The wire string, i.e. what appears in a manifest and in the database.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotesRead => "notes.read",
            Self::NotesCreate => "notes.create",
            Self::TextCheckersContribute => "textCheckers.contribute",
            Self::PluginArtifactsDownload => "pluginArtifacts.download",
            Self::PluginStorageRead => "pluginStorage.read",
            Self::PluginStorageWrite => "pluginStorage.write",
            Self::NativeToolsRunDeclared => "nativeTools.runDeclared",
            Self::NativeServicesRun => "nativeServices.run",
        }
    }
}

/// What kind of thing a downloaded artifact is. Only affects how the webview
/// runtime is handed it; the host verifies all three identically.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/plugins/generated/")]
pub enum ArtifactKind {
    Wasm,
    WebScript,
    Data,
}

/// A binary the host downloads and digest-verifies for a webview renderer.
/// Plugin code never performs the download.
#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, export_to = "../../src/lib/plugins/generated/")]
pub struct ArtifactDecl {
    pub id: String,
    pub kind: ArtifactKind,
    /// Display version of the artifact, independent of the plugin version.
    pub version: String,
    /// HTTPS URL fetched by the host.
    pub url: String,
    /// Expected SHA-256 of the bytes, lowercase hex. Checked after download and
    /// again on every read — a mismatch is refused, never repaired.
    pub sha256: String,
    /// Stored filename under the artifact's version directory.
    pub file_name: String,
    /// Optional exact byte length, checked alongside the digest.
    #[ts(type = "number | null")]
    pub size_bytes: Option<u64>,
}

/// A PATH-resolved binary the plugin may run one shot at a time.
#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/plugins/generated/")]
pub struct NativeToolDecl {
    pub id: String,
    /// Exact executable basename resolved from PATH. Never a path, never a
    /// shell string — the host resolves and launches it directly.
    pub binary_name: String,
    pub description_key: Option<String>,
}

/// How a preview service's iframe document is loaded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/plugins/generated/")]
pub enum PreviewIframeMode {
    /// Load the service URL unchanged. The safest and most compatible default.
    #[default]
    Direct,
    /// Route it through the host proxy so theme variables and optional plugin
    /// CSS can be injected.
    Themed,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/plugins/generated/")]
pub struct PreviewIframeDecl {
    #[serde(default)]
    pub mode: PreviewIframeMode,
    /// Plugin-relative `.css` injected after the host theme variables. Themed
    /// mode only.
    pub css: Option<String>,
    /// A port the tool's frontend hardcodes as a socket fallback, redirected
    /// back to the proxy origin. Themed mode only.
    pub socket_rewrite_port: Option<u16>,
}

/// Control-plane message names the host bridge understands.
#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/plugins/generated/")]
pub struct ServiceProtocol {
    /// The server-to-editor inverse-search message that moves the source cursor.
    pub jump_event: Option<String>,
}

/// A PATH binary the host runs as a persistent local preview server.
#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/plugins/generated/")]
pub struct NativeServiceDecl {
    pub id: String,
    pub binary_name: String,
    /// Launch arguments. May contain `{dataPort}`, `{controlPort}`, `{input}`
    /// and `{setting:<id>}`; the last is sanitized to a safe CLI charset.
    pub args: Vec<String>,
    /// URL the iframe loads. Validated to be loopback.
    pub data_url: String,
    /// Control-plane WebSocket URL. Validated to be loopback.
    pub control_url: String,
    /// Extension for the materialized source file.
    pub input_extension: Option<String>,
    #[serde(default)]
    pub preview_iframe: PreviewIframeDecl,
    pub description_key: Option<String>,
    #[serde(default)]
    pub protocol: ServiceProtocol,
}

/// The contribution points the backend acts on.
///
/// Everything else a plugin contributes — i18n, settings, documentation,
/// templates, note kinds, toolbars, text checkers, source languages — is
/// presentational, read only by the frontend, and rides through in
/// [`Manifest::contributes_rest`] untouched.
#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/plugins/generated/")]
pub struct BackendContributions {
    #[serde(default)]
    pub artifacts: Vec<ArtifactDecl>,
    #[serde(default)]
    pub native_tools: Vec<NativeToolDecl>,
    #[serde(default)]
    pub native_services: Vec<NativeServiceDecl>,
}

/// A plugin manifest, as far as the backend is concerned.
#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/plugins/generated/")]
pub struct Manifest {
    /// The manifest schema this plugin targets. Required: without it a manifest
    /// written for a different app version is indistinguishable from a
    /// malformed one, and the error should say which.
    pub manifest_version: u32,
    /// Lowest app version this plugin runs on, `major.minor.patch`.
    pub min_app_version: Option<String>,
    /// Stable, dotted, lowercase. The namespace for every runtime id derived
    /// from this plugin, so two plugins can never collide.
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: Option<String>,
    /// Builtins are enabled on first discovery unless this is false. Installed
    /// plugins ignore it and always start gated.
    #[serde(default = "default_true")]
    pub enabled_by_default: bool,
    pub runtime: PluginRuntime,
    /// Required for a scripted runtime: a plain `.luau` filename, no separators
    /// and no `..`. The backend joins it onto the plugin dir, so this is the
    /// traversal guard.
    pub entry: Option<String>,
    #[serde(default)]
    pub limits: RuntimeLimits,
    pub description_key: Option<String>,
    pub icon: Option<String>,
    #[serde(default)]
    pub permissions: Vec<PluginPermission>,
    /// The contributions the backend acts on.
    #[serde(default)]
    pub contributes: BackendContributions,
}

fn default_true() -> bool {
    true
}

/// Why a manifest was refused. Every variant is something the backend would
/// otherwise have had to guess at.
#[derive(Debug, thiserror::Error)]
pub enum ManifestError {
    #[error("manifest.json: {0}")]
    Parse(#[from] serde_json::Error),
    #[error("manifest.manifestVersion {found} is newer than this app understands ({CURRENT_MANIFEST_VERSION}); update the app")]
    TooNew { found: u32 },
    #[error("manifest.id (\"{0}\") must be a stable, dotted, lowercase id")]
    BadId(String),
    #[error("{runtime} plugin has no entry")]
    MissingEntry { runtime: &'static str },
    #[error("unsafe entry '{0}'")]
    UnsafeEntry(String),
    #[error("manifest.entry is only valid for a scripted runtime")]
    UnexpectedEntry,
}

/// A plugin id: dotted, lowercase, at least two segments.
///
/// Mirrors `isValidPluginId` in `validation.ts`. It is the one rule genuinely
/// duplicated across the boundary, because the frontend needs it before the
/// backend has spoken (to name a load error for a manifest it could not parse);
/// `plugin_id_matches_frontend_rule` pins the two together.
fn is_valid_id(id: &str) -> bool {
    if id.len() > 200 {
        return false;
    }
    let mut segments = 0;
    for segment in id.split('.') {
        segments += 1;
        let mut chars = segment.chars();
        match chars.next() {
            Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit() => {}
            _ => return false,
        }
        if !segment
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        {
            return false;
        }
    }
    segments >= 2
}

/// A safe scripted entry: one path segment with the runtime's extension.
fn is_safe_entry(entry: &str) -> bool {
    !entry.is_empty()
        && !entry.contains('/')
        && !entry.contains('\\')
        && !entry.contains("..")
        && entry.ends_with(".luau")
        && entry.len() > ".luau".len()
        && entry
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
}

impl Manifest {
    /// Parse and structurally validate a manifest.
    ///
    /// Deliberately *not* the whole of validation: the frontend still checks
    /// the presentational contributions, and rejects a manifest that
    /// contributes something it did not ask permission for. What is here is
    /// what the backend would otherwise have had to assume.
    pub fn parse(bytes: &[u8]) -> Result<Self, ManifestError> {
        let manifest: Manifest = serde_json::from_slice(bytes)?;
        if manifest.manifest_version > CURRENT_MANIFEST_VERSION {
            return Err(ManifestError::TooNew {
                found: manifest.manifest_version,
            });
        }
        if !is_valid_id(&manifest.id) {
            return Err(ManifestError::BadId(manifest.id));
        }
        match (manifest.runtime.is_scripted(), manifest.entry.as_deref()) {
            (true, None) => return Err(ManifestError::MissingEntry { runtime: "luau" }),
            (true, Some(entry)) if !is_safe_entry(entry) => {
                return Err(ManifestError::UnsafeEntry(entry.to_string()))
            }
            // A declarative plugin has nothing to run; a stray entry is a
            // mistake worth surfacing rather than silently ignoring.
            (false, Some(_)) => return Err(ManifestError::UnexpectedEntry),
            _ => {}
        }
        Ok(manifest)
    }

    /// Whether this manifest was granted `permission`.
    pub fn declares(&self, permission: PluginPermission) -> bool {
        self.permissions.contains(&permission)
    }

    /// The permission strings, as stored in the database.
    pub fn permission_strings(&self) -> Vec<String> {
        self.permissions
            .iter()
            .map(|p| p.as_str().to_string())
            .collect()
    }

    /// A declared native tool by id.
    pub fn native_tool(&self, tool_id: &str) -> Option<&NativeToolDecl> {
        self.contributes
            .native_tools
            .iter()
            .find(|t| t.id == tool_id)
    }

    /// A declared native service by id.
    pub fn native_service(&self, service_id: &str) -> Option<&NativeServiceDecl> {
        self.contributes
            .native_services
            .iter()
            .find(|s| s.id == service_id)
    }

    /// A declared artifact by id.
    pub fn artifact(&self, artifact_id: &str) -> Option<&ArtifactDecl> {
        self.contributes
            .artifacts
            .iter()
            .find(|a| a.id == artifact_id)
    }
}

/// The manifest as the frontend receives it: the raw JSON, so the
/// presentational contributions this file deliberately does not model survive
/// the trip untouched.
pub type RawManifest = BTreeMap<String, serde_json::Value>;

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> serde_json::Value {
        serde_json::json!({
            "manifestVersion": 1,
            "id": "com.a.plugin",
            "name": "A Plugin",
            "version": "1.0.0",
            "runtime": "manifest-only"
        })
    }

    fn parse(v: serde_json::Value) -> Result<Manifest, ManifestError> {
        Manifest::parse(v.to_string().as_bytes())
    }

    #[test]
    fn parses_a_minimal_manifest() {
        let m = parse(base()).unwrap();
        assert_eq!(m.id, "com.a.plugin");
        assert_eq!(m.runtime, PluginRuntime::ManifestOnly);
        // Absent means enabled for a builtin: the opt-out is explicit.
        assert!(m.enabled_by_default);
        assert!(m.permissions.is_empty());
        assert!(m.contributes.native_tools.is_empty());
    }

    #[test]
    fn refuses_a_manifest_with_no_id_instead_of_inventing_one() {
        // The old untyped reader fell back to the literal string "plugin" here,
        // while the frontend validator rejected the same manifest outright.
        let mut v = base();
        v.as_object_mut().unwrap().remove("id");
        assert!(matches!(parse(v), Err(ManifestError::Parse(_))));
    }

    #[test]
    fn plugin_id_matches_frontend_rule() {
        for good in [
            "com.a.plugin",
            "com.mindstream.templates.core",
            "a.b",
            "a1.b2-c",
        ] {
            let mut v = base();
            v["id"] = good.into();
            assert!(parse(v).is_ok(), "{good} should be valid");
        }
        for bad in [
            "nodot",
            "UPPER.case",
            "com..double",
            "com.-lead",
            ".leading",
            "com.a ",
        ] {
            let mut v = base();
            v["id"] = bad.into();
            assert!(
                matches!(parse(v), Err(ManifestError::BadId(_))),
                "{bad} should be rejected"
            );
        }
    }

    #[test]
    fn refuses_a_manifest_version_from_the_future() {
        let mut v = base();
        v["manifestVersion"] = 2.into();
        let err = parse(v).unwrap_err();
        assert!(err.to_string().contains("update the app"), "{err}");
    }

    #[test]
    fn scripted_runtimes_need_a_safe_entry() {
        let mut v = base();
        v["runtime"] = "luau".into();
        assert!(matches!(
            parse(v.clone()),
            Err(ManifestError::MissingEntry { .. })
        ));

        for bad in [
            "../evil.luau",
            "sub/main.luau",
            "main.lua",
            "main.js",
            ".luau",
        ] {
            let mut v = v.clone();
            v["entry"] = bad.into();
            assert!(
                matches!(parse(v), Err(ManifestError::UnsafeEntry(_))),
                "{bad} should be rejected"
            );
        }

        v["entry"] = "main.luau".into();
        assert_eq!(parse(v).unwrap().entry.as_deref(), Some("main.luau"));
    }

    #[test]
    fn a_declarative_plugin_may_not_carry_an_entry() {
        let mut v = base();
        v["entry"] = "main.luau".into();
        assert!(matches!(parse(v), Err(ManifestError::UnexpectedEntry)));
    }

    #[test]
    fn unknown_permissions_are_refused_not_ignored() {
        // Dropping one would load the plugin under a narrower grant than it was
        // written for, failing later with nothing pointing back at the cause.
        let mut v = base();
        v["permissions"] = serde_json::json!(["notes.read", "future.capability"]);
        assert!(matches!(parse(v), Err(ManifestError::Parse(_))));
    }

    #[test]
    fn reads_the_declarations_the_backend_acts_on() {
        let mut v = base();
        v["permissions"] = serde_json::json!([
            "nativeTools.runDeclared",
            "nativeServices.run",
            "pluginArtifacts.download"
        ]);
        v["contributes"] = serde_json::json!({
            "artifacts": [{
                "id": "engine", "kind": "wasm", "version": "0.13.1",
                "url": "https://example.com/e.wasm",
                "sha256": "ab", "fileName": "e.wasm", "sizeBytes": 12
            }],
            "nativeTools": [{ "id": "typst", "binaryName": "typst" }],
            "nativeServices": [{
                "id": "tinymist", "binaryName": "tinymist",
                "args": ["preview", "--data-plane-host", "127.0.0.1:{dataPort}"],
                "dataUrl": "http://127.0.0.1:{dataPort}",
                "controlUrl": "ws://127.0.0.1:{controlPort}",
                "previewIframe": { "mode": "themed", "css": "preview.css" }
            }],
            // Presentational contributions ride through without the backend
            // needing a definition for them.
            "i18n": { "en": { "a": "b" } },
            "settings": [{ "sectionId": "x", "titleKey": "y", "settings": [] }]
        });
        let m = parse(v).unwrap();

        assert!(m.declares(PluginPermission::NativeToolsRunDeclared));
        assert!(!m.declares(PluginPermission::NotesRead));
        assert_eq!(m.native_tool("typst").unwrap().binary_name, "typst");
        assert!(m.native_tool("ghost").is_none());
        assert_eq!(m.artifact("engine").unwrap().size_bytes, Some(12));
        let service = m.native_service("tinymist").unwrap();
        assert_eq!(service.preview_iframe.mode, PreviewIframeMode::Themed);
        assert_eq!(service.preview_iframe.css.as_deref(), Some("preview.css"));
        // Absent optional: the default, not a guess.
        assert!(service.protocol.jump_event.is_none());
    }

    #[test]
    fn artifact_declarations_reject_unknown_fields() {
        // An artifact is downloaded and executed, so a field the host does not
        // understand is a reason to stop rather than to carry on.
        let mut v = base();
        v["permissions"] = serde_json::json!(["pluginArtifacts.download"]);
        v["contributes"] = serde_json::json!({
            "artifacts": [{
                "id": "engine", "kind": "wasm", "version": "1", "url": "https://e/x",
                "sha256": "ab", "fileName": "x", "surprise": true
            }]
        });
        assert!(matches!(parse(v), Err(ManifestError::Parse(_))));
    }

    #[test]
    fn every_bundled_manifest_parses() {
        // The bundled plugins are the worked examples; if one of them stops
        // parsing, the documentation is wrong too.
        for dir in super::super::discovery::discover_builtins() {
            assert!(
                !dir.manifest.id.is_empty(),
                "builtin {} parsed with an empty id",
                dir.source
            );
        }
    }
    /// Every type the frontend imports has a committed binding.
    ///
    /// `ts-rs` regenerates `src/lib/plugins/generated/` during `cargo test`, so
    /// this asserts the files exist and declare what `types.ts` imports. The
    /// failure it is really for is renaming or removing a type in Rust and not
    /// noticing that the TypeScript side still expects it: the regeneration
    /// leaves a stale or missing file, and `git status` shows the drift.
    #[test]
    fn bindings_are_committed_and_current() {
        use std::path::Path;
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("src")
            .join("lib")
            .join("plugins")
            .join("generated");

        for name in [
            "Manifest",
            "PluginPermission",
            "PluginRuntime",
            "RuntimeLimits",
            "ArtifactDecl",
            "ArtifactKind",
            "NativeToolDecl",
            "NativeServiceDecl",
            "BackendContributions",
        ] {
            let path = dir.join(format!("{name}.ts"));
            assert!(
                path.exists(),
                "missing generated binding {name}.ts — run  and commit src/lib/plugins/generated/"
            );
            let body = std::fs::read_to_string(&path).unwrap();
            assert!(
                body.contains(&format!("export type {name}")),
                "{name}.ts does not declare {name}"
            );
        }
    }

    /// The permission wire strings are the database's contents and a manifest's
    /// text, so they are not free to change with the Rust identifiers.
    #[test]
    fn permission_wire_strings_round_trip() {
        for (permission, wire) in [
            (PluginPermission::NotesRead, "notes.read"),
            (PluginPermission::NotesCreate, "notes.create"),
            (
                PluginPermission::TextCheckersContribute,
                "textCheckers.contribute",
            ),
            (
                PluginPermission::PluginArtifactsDownload,
                "pluginArtifacts.download",
            ),
            (PluginPermission::PluginStorageRead, "pluginStorage.read"),
            (PluginPermission::PluginStorageWrite, "pluginStorage.write"),
            (
                PluginPermission::NativeToolsRunDeclared,
                "nativeTools.runDeclared",
            ),
            (PluginPermission::NativeServicesRun, "nativeServices.run"),
        ] {
            assert_eq!(permission.as_str(), wire);
            let parsed: PluginPermission =
                serde_json::from_value(serde_json::Value::String(wire.into())).expect(wire);
            assert_eq!(parsed, permission);
        }
    }
}

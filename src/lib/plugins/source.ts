/**
 * Plugin source kinds, mirroring src-tauri/src/plugins/mod.rs. Governs the
 * integrity gate: `builtin` plugins ship in the signed app bundle and are
 * trusted; `installed` (third-party) plugins are subject to the manifest
 * hash-change re-approval flow.
 */
export const SOURCE_BUILTIN = 'builtin';
export const SOURCE_INSTALLED = 'installed';

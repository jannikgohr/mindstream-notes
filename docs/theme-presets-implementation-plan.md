# Theme presets implementation plan

Status: implemented on 2026-10-13. Root owns accent, UI font size, preset
selection and user presets. Mode remains independent of preset selection.
The implementation uses the root transactions and worker notifications from the
[concurrency plan](root-vault-implementation-plan.md).

## Delivered behavior

- Mindstream, Warm and Forest supply separate light/dark palettes. Validated
  numeric OKLCH tokens control surfaces, text, borders and brand colors. The
  compatibility tokens still derive from those values.
- Appearance settings select a preset, show its JSON, save a custom copy or
  replacement and remove a user preset. Built-in IDs cannot be overwritten.
  A missing or invalid selected preset displays Mindstream while retaining the
  selected ID. Restoring that preset restores its appearance.
- Root `ui-settings.json` holds `appearance.preset`, `appearance.accent` and
  `appearance.uiFontSize`. Root `theme-presets.json` holds user presets. Every
  edit rereads under RootLock, preserves other entries and publishes atomically.
  Validated previous copies support recovery without discarding corrupt bytes.
- `appearance-migration-owner.json` pins the startup-selected vault before
  workers launch. Root values win. The selected vault seeds missing accent/font
  values once, then `.device-appearance-migrated` prevents reimport after resets.
  Original vault fields remain in their files and do not override snapshots.
  Browser fallback archives its original scoped bucket before rewriting scopes.
- Main windows receive validated root appearance before first paint. Isolated
  browser caches preserve it until settings are ready; popout backgrounds use
  the preset surface color. Mode, preset, font and accent changes refresh every
  worker/popout. Existing preview theme observers pick up token changes.

The authoring contract and token limits are in [the theming guide](theming.md#theme-presets).
Validation evidence and commands are in [the harness guide](e2e/harness.md#concurrent-vault-checks).

## Behavior

Root owns preset files/selection, light/dark/system mode, explicit accent, and UI
font size. Mode and preset are independent. Editor font size and line height
remain vault preferences. Apply preset tokens before explicit accent overrides.

## Delivered sequence

1. Define versioned, validated light/dark token presets following
   `docs/theming.md`. Exclude scripts, unrestricted CSS, and remote imports.
2. Ship a small preset set and root storage for user presets. Add selection,
   validation, and fallback without discarding a missing user preset selection.
3. Migrate accent/UI font size once: root values win, otherwise seed from the
   selected vault. Preserve other vault preferences.
4. Update schema/registry, appearance/accent helpers, lint rules, and preview
   styling. Maintain derived token relationships and contrast in both modes.
5. Update `app.html` and first-paint caches for isolated WebView stores. Refresh
   every worker, popout, new window, and preview on theme revisions.
6. Document authoring, precedence, migration, and missing-preset behavior.

## Validation

Windows native checks verify root migration, both vaults and a popout, mode and
accent precedence, real preset selection/import/removal, retained missing
selection and cold restart. Rust tests cover contrast, unsafe data, concurrent
catalog edits, validated recovery, root precedence and migration replay. All 145
affected frontend tests pass, including first-paint cache rejection and browser
scope migration. Windows Rust fmt/clippy/full tests pass with 893 unit tests and
one integration test, five ignored overall. The harness guide records platform
regressions and retained evidence.

Primary areas: `app.css`, `app.html`, settings schema/registry, appearance/accent
helpers, preview styling, lint tooling, and theming documentation.

The original estimate was 3 to 5 working days after shared persistence and
notifications. Theme marketplaces and unrestricted stylesheets remain separate
features. Packaged macOS and real desktop monitor/DPI/reboot/updater checks retain
the existing release QA status; native theme UI evidence currently covers Windows.

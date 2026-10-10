# Theme presets implementation plan

Status: independent follow-up using root settings/worker notifications from the
[concurrency plan](root-vault-implementation-plan.md). Concurrent vaults and
global plugin packages do not depend on theme presets.

## Behavior

Root owns preset files/selection, light/dark/system mode, explicit accent, and UI
font size. Mode and preset are independent. Editor font size and line height
remain vault preferences. Apply preset tokens before explicit accent overrides.

## Sequence

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

## Validation and estimate

Test restart, new windows, handoff, mode switching, accent precedence, invalid
presets, and concurrent settings edits. Inspect chrome, editors, sidebars, dock,
Kanban, popouts, dialogs, menus, previews, and startup colors.

Primary areas: `app.css`, `app.html`, settings schema/registry, appearance/accent
helpers, preview styling, lint tooling, and theming documentation.

Budget 3 to 5 working days after shared persistence/notifications. Theme
marketplaces and unrestricted stylesheets are separate features.

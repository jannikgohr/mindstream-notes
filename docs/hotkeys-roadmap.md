# Hotkey system — gap roadmap

Living checklist of weaknesses we identified after the initial hotkey
implementation landed. Items roughly ordered by user-visible impact.
Each entry has a brief description, the planned fix, and a status.

When you finish an item, flip the box, add the commit hash + a one-line
note about what shipped, and move on.

---

## Functional gaps (real bugs waiting to happen)

- [x] **#1. Crepe's built-in keymap kept firing after rebind / unset.**
      ProseMirror's commonmark + history plugins install their own
      keymap at editor construction (Mod+B, Mod+I, Mod+Z, Mod+Shift+Z,
      and likely more). Until now, unsetting Mod+B in our settings
      still toggled bold because Crepe ran independently.
      **Shipped:** manager now keeps a `CREPE_NATIVE_CHORDS` whitelist
      and `preventDefault`s those chords when our binding diverges and
      a markdown editor is active. Small whitelist on purpose — false
      positives swallow user keystrokes.

- [x] **#2. Browser / OS shortcut collisions silently lost.**
      Users could save a binding that quietly never fired because the
      OS captured it first.
      **Shipped:** new `$lib/hotkeys/collisions.ts` exposes
      `wellKnownConflict(binding)` against a conservative
      platform-gated seed list (Cmd+Q / Spotlight / Tab switcher on
      Mac, Alt+Tab / Alt+F4 on Win/Linux, screenshots, etc.). The
      recorder shows an amber inline warning when the pending chord
      hits a known reservation; the user can still save it
      (advisory only — many "reserved" chords actually work inside
      a Tauri webview). `hydrateBindingsFromSettings` also logs a
      one-line console warn at app start for any effective binding
      hitting a known reservation. New `collisions.test.ts` (10
      cases) locks the platform gates and seed-list parseability.

- [x] **#3. macOS Alt+letter produces special characters.**
      `Alt+1` on Mac = `¡`, `Alt+A` = `å`; our `normalizeKey` keeps
      the typed character. The binding worked but the label was
      confusing (`alt+å` rather than `alt+a`).
      **Shipped:** recorder shows a muted hint when the pending
      binding has `alt` without `mod` while on Mac. Wording suggests
      adding Cmd (which suppresses Option's composition behaviour
      and captures the plain key). Informational only — a user who
      genuinely wants `alt+å` can still save. No matcher change;
      digit-row bindings already work via the `event.code` fallback,
      letter bindings continue to record the special character.

- [ ] **#4. Sequence chords (`Mod+K Mod+S`).**
      Single-chord only. VS Code, Obsidian, Emacs all support chord
      sequences for deeper menus.
      **Plan:** small state machine in the manager — first match
      opens a "leader pending" state with a short timeout; second
      keydown completes or cancels. Settings recorder needs to
      capture two chords with a visible interstitial.

---

## Testing coverage

- [x] **#5. Manager / bus / store test gaps.**
      Only two manager tests existed before. Missing coverage for
      stack ordering, conflict swap, listener-declined dispatch,
      unset / Crepe-suppression, input blocking, hydration.
      **Shipped:** three new files. `bus.test.ts` (14 cases) covers
      push / re-promote / pop / idempotent unregister plus all
      `emitCommand` paths (global, editor kinds match / mismatch,
      handle-by-default, explicit `false`, listener throws).
      `store.test.ts` (22 cases) covers `getBinding` fallbacks,
      `setBinding` canonical / null / invalid / conflict-swap /
      unknown-id, `resetBinding`, `isCustomized`, `findCommandByBinding`,
      and `hydrateBindingsFromSettings` overlay / forget / null /
      canonicalise. `manager.test.ts` grew from 2 → 10 cases
      covering input-blocking, listener-declined fall-through, no
      active editor, Crepe-native suppression on remap and unset,
      and an explicit regression for the matcher's user-override
      priority. While writing tests I also discovered and fixed a
      matcher bug: user customisations now win over catalogue
      defaults when both match the same chord.

---

## UX nits

- [x] **#6. "Reset all to defaults" button** in the hotkeys panel.
      Two clicks to recover from a tangled binding set.
      **Shipped:** ghost-style button anchored top-right of the panel.
      Loops `resetBinding` over `HOTKEY_COMMANDS` sequentially (so the
      conflict-swap path sees consistent state). Gated behind the
      themed `confirm()` with the destructive variant. Auto-disables
      via `$derived` when nothing is customised so the button can't
      tempt a no-op click.

- [x] **#7. Recorder hides the current binding while editing.**
      Click Edit → chip said "Press a key…", current value vanished.
      If you decided not to change it, you lost visual reference.
      **Shipped:** recording chip now reads `<current> → Press a key…`
      until the first key is typed (or `Unset → Press a key…` when
      nothing was bound). Disappears once a chord is captured —
      what matters then is the new chord, not the old one.

- [x] **#8. Screen readers didn't get the toolbar shortcut.**
      Sighted users saw "Bold (⌘B)" via `title`; screen-reader users
      got just "Bold".
      **Shipped:** new `ariaKeyShortcut(binding)` formatter in
      `format.ts` produces the ARIA-named form (`Control+B` on Win /
      Linux, `Meta+B` on Mac). Wired into `aria-keyshortcuts` on
      every `EditorToolbar` leaf and every `ToolbarMenu` item. Visible
      glyph column is now `aria-hidden` so the chord isn't announced
      twice. Empty string → attribute dropped entirely (some screen
      readers announce `aria-keyshortcuts=""` as "no shortcut",
      worse than silence).

- [x] **#9. No global-command discoverability.**
      `Mod+,` opened settings but nothing told you so. Power users
      had to dig through the panel to learn what was bound.
      **Shipped:** new global command `global.showShortcutHelp`
      bound to `Shift+?` (Gmail / GitHub convention). Triggers a
      modal in `ShortcutHelpDialog.svelte` (mounted at root) that
      reads `groupedCommands()` + live bindings and renders one
      section per scope / editor kind. Each row shows the command
      label plus its current chord (or "Unset" placeholder). State
      lives in `help.svelte.ts` mirroring the `settingsDialog`
      pattern so any non-keyboard caller can `openShortcutHelp()`
      from anywhere — the bus already routes the global command's
      `run()` to it.

- [ ] **#14. Shortcut discovery needs search.**
      The Shift+? shortcut-help menu is useful once it is open, but
      it still asks users to scan every section. Settings search also
      treats the hotkeys custom panel as a single opaque row, so a
      search for "bold" or "heading" cannot jump directly to the
      relevant hotkey function.
      **Plan:** add a search field to `ShortcutHelpDialog` that filters
      commands by label, group, id, raw binding, and formatted binding.
      Thread the settings dialog's search query into `HotkeysPanel` so
      hotkey functions are searchable from Settings and the panel shows
      only matching commands while the query is active.

---

## Architecture / extensibility

- [x] **#11. Catalogue ↔ actions consistency was runtime-checked.**
      A missing `MARKDOWN_ACTIONS` entry only surfaced when a user
      pressed the broken shortcut.
      **Shipped:** `catalogue.test.ts` has six drift guards (action ↔
      command coverage, default parses, `run()` exists, unique ids,
      no duplicate defaults). Runtime warnings stay in place as the
      safety net; tests catch it at PR review.

- [x] **#10. No way to fire a command from non-keyboard sources.**
      `emitCommand` was exported but nothing else used it — the
      bus's general-purpose surface was unexercised in production.
      **Shipped:** new `commandById(id): CommandDefinition | null`
      null-safe lookup helper in `commands.ts`, exported from the
      barrel with the canonical calling pattern documented inline
      (`const cmd = commandById(id); if (cmd) emitCommand(cmd);`).
      `EditorToolbar.invokeLeaf` now routes through the bus
      whenever the clicked button has a `hotkeyId`, falling back
      to the direct `crepe.editor.action(item.action)` call if the
      id isn't in the catalogue or the bus reports unhandled. Every
      click on Bold / Italic / heading / list buttons now exercises
      the same dispatch path as the keyboard, so a regression in
      the bus surfaces immediately. Two `catalogue.test.ts` cases
      cover `commandById` happy + miss paths.

- [ ] **#12. Tauri tray / native menus can't show their bindings.**
      Bindings live in JS `$state`; the Rust side that builds the
      tray menu doesn't see them.
      **Plan:** small Tauri command `get_hotkey_display(commandId)`
      returns the formatted display string. Push updates from the
      layout `$effect` so the tray menu's accelerators stay current.
      Defer until a tray action actually overlaps with a hotkey.

- [x] **#13. No persistence migration story.**
      Renaming a command id silently lost every user's custom binding
      for that command.
      **Shipped:** new `$lib/hotkeys/migrations.ts` exports a
      `MIGRATIONS` map (`oldId → newId`, empty until the first
      rename ships) and a pure `applyMigrations(values, table)`
      walker that `hydrateBindingsFromSettings` runs before the main
      load. On collision (both old and new have values) the user's
      later choice on the new id wins; the old key is always cleaned
      up so it doesn't re-migrate on the next load. New
      `migrations.test.ts` (10 cases) covers the walker behaviour
      and four authoring-rule guards (targets must exist in the
      catalogue, sources must not be live ids, no chains, no
      self-refs) — empty-table-passes-trivially today, real guard
      rails the moment the first rename lands.

---

## Conventions

- Tick a box only when the fix is _shipped_ (committed + tested + 0
  errors / 0 warnings on `pnpm check`).
- Keep the "Shipped" note short — one or two sentences pointing at
  the commit, no diff dumps.
- New items go at the bottom of the relevant section.

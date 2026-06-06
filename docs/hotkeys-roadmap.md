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

- [ ] **#2. Browser / OS shortcut collisions silently lose.**
      We `preventDefault` in capture, which handles most cases. But
      `Mod+W` / `Mod+T` / `Mod+N` / `Mod+Q` are usually hard-coded in
      the browser / OS and uninterceptable. The user can save a
      binding that quietly never fires.
      **Plan:** maintain a list of "well-known un-overridable chords"
      and surface a warning in the recorder (and on hydrate-load with
      a console warn) when the user's binding hits one. Don't reject —
      Tauri's webview _does_ let us override most of them, so the
      detection is advisory.

- [ ] **#3. macOS Alt+letter produces special characters.**
      `Alt+1` on Mac = `¡`; our `normalizeKey` keeps the typed
      character, so a bound `alt+1` only matches when the user
      actually produces `¡`. Following the user's "use current
      keyboard layout" rule prevents an `event.code` fallback for
      letters.
      **Plan:** at minimum surface the limitation in the recorder
      when on Mac with Alt held — show a hint that the captured chord
      may differ from what the label suggests. Optional follow-up:
      offer the user a choice between layout-aware and physical-key
      modes per-binding.

- [ ] **#4. Sequence chords (`Mod+K Mod+S`).**
      Single-chord only. VS Code, Obsidian, Emacs all support chord
      sequences for deeper menus.
      **Plan:** small state machine in the manager — first match
      opens a "leader pending" state with a short timeout; second
      keydown completes or cancels. Settings recorder needs to
      capture two chords with a visible interstitial.

---

## Testing coverage

- [ ] **#5. Manager / bus / store test gaps.**
      Only two manager tests today. Missing coverage for: - bus stack push / re-promote / pop ordering - conflict swap on `setBinding` - "no listener handled, don't preventDefault" path - "unset binding doesn't fire even though the default did" - input-blocking inside non-editor text fields - hydrate from `settings.values` then mutate and re-hydrate
      **Plan:** one `bus.test.ts`, one `store.test.ts`, extra cases
      in `manager.test.ts`.

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

- [ ] **#8. `aria-label`s on toolbar buttons don't include the shortcut.**
      Sighted users get "Bold (⌘B)" via `title`; screen readers get
      just "Bold".
      **Plan:** mirror the `leafTitle` logic into `aria-label`.
      Same for `ToolbarMenu`'s shortcut column.

- [ ] **#9. No global-command discoverability.**
      `Mod+,` opens settings but nothing tells you so. A Gmail /
      GitHub-style "?" overlay listing every bound hotkey would
      help.
      **Plan:** new global command `global.showShortcutHelp` bound
      to `Shift+?` by default; opens a modal that reads from
      `HOTKEY_COMMANDS` + `hotkeys.bindings` and renders the table.

---

## Architecture / extensibility

- [x] **#11. Catalogue ↔ actions consistency was runtime-checked.**
      A missing `MARKDOWN_ACTIONS` entry only surfaced when a user
      pressed the broken shortcut.
      **Shipped:** `catalogue.test.ts` has six drift guards (action ↔
      command coverage, default parses, `run()` exists, unique ids,
      no duplicate defaults). Runtime warnings stay in place as the
      safety net; tests catch it at PR review.

- [ ] **#10. No way to fire a command from non-keyboard sources.**
      `emitCommand` is exported but nothing else uses it. The bus
      design anticipated palette / tray-menu callers — they don't
      exist yet, and there's no `byId(commandId)` helper exposed.
      **Plan:** export `commandById(id): CommandDefinition | null`
      from `$lib/hotkeys`. Document the calling pattern. Use it
      ourselves from at least one non-keyboard surface (e.g. the
      toolbar buttons could route through the bus instead of
      calling Crepe directly) so the wire stays exercised.

- [ ] **#12. Tauri tray / native menus can't show their bindings.**
      Bindings live in JS `$state`; the Rust side that builds the
      tray menu doesn't see them.
      **Plan:** small Tauri command `get_hotkey_display(commandId)`
      returns the formatted display string. Push updates from the
      layout `$effect` so the tray menu's accelerators stay current.
      Defer until a tray action actually overlaps with a hotkey.

- [ ] **#13. No persistence migration story.**
      Rename a command id (`editor.markdown.bulletList` → something
      else) and users with custom bindings silently lose them.
      **Plan:** small `migrations` map keyed by old id → new id,
      walked at the top of `hydrateBindingsFromSettings`. Each entry
      moves the persisted value and deletes the old key. Add a unit
      test per migration so future renames don't forget.

---

## Conventions

- Tick a box only when the fix is _shipped_ (committed + tested + 0
  errors / 0 warnings on `pnpm check`).
- Keep the "Shipped" note short — one or two sentences pointing at
  the commit, no diff dumps.
- New items go at the bottom of the relevant section.

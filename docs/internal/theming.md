# Theming

All colour, elevation and radius in the app comes from tokens defined in
[`src/app.css`](../../src/app.css). This document is the contract for that file:
what each token means, which one to reach for, and what is not allowed.

## Why the system exists

The app previously had tokens but no system. `--muted` was _darker_ than
`--background` in light mode and _lighter_ in dark mode, so any component using
it as a surface recessed in one theme and lifted in the other — most visibly the
Kanban board, whose columns became pale slabs with darker cards floating on
them. `--border`, `--muted`, `--accent` and `--secondary` were all the same
value in dark mode, so bordered elements on a muted surface had no outline. Each
area of the app worked around this locally, which is why the sidebars, the
Kanban board and the dockview chrome each ended up with their own look.

## The two layers

**Layer 1 — the system.** The elevation scale, border tiers, brand accent and
status ramp. This is the source of truth, and the only place a raw colour
literal belongs.

**Layer 2 — shadcn compatibility.** `--background`, `--card`, `--popover`,
`--muted`, `--secondary`, `--accent`, `--border`, `--input`, `--ring` are
_derived_ from layer 1, not authored independently. They exist so the existing
`bg-card` / `text-muted-foreground` utilities and the shadcn-svelte primitives
keep working. **Change layer 1; never edit a layer-2 value directly.**

## Elevation

Four surface steps. The rule that makes light and dark consistent:

> **A higher index is always lighter, in both themes.**

Elevation is distance toward the viewer. A container that recesses takes a
_lower_ index than its parent; one that lifts takes a _higher_ one. This holds
identically in light and dark, so a layout designed in one theme is correct in
the other.

| Token         | Use for                                                                                     | Light `L` | Dark `L` |
| ------------- | ------------------------------------------------------------------------------------------- | --------- | -------- |
| `--surface-0` | window chrome behind everything — title bar, dock strip, mobile top/bottom bars             | 0.975     | 0.220    |
| `--surface-1` | panels — sidebars, editor panel, board background (this is what `--background` resolves to) | 0.985     | 0.245    |
| `--surface-2` | containers on a panel — Kanban columns, sidebar sections, grouped wells                     | 0.992     | 0.270    |
| `--surface-3` | items and overlays — cards, popovers, dialogs, menus                                        | 1.000     | 0.295    |

Utilities: `bg-surface-0` … `bg-surface-3`.

Light mode starts at a real grey rather than near-white so all four steps fit
below pure white. Its steps compress as they approach white, so shadow carries
the rest of the cue — pair a raised surface with `shadow-raised`, an overlay
with `shadow-overlay`. Both are theme-aware (dark mode uses deeper, near-black
shadows, because a soft grey shadow does not register on a dark ground).

The raw tokens behind those utilities are named `--elevation-raised` /
`--elevation-overlay`, not `--shadow-*`: Tailwind owns the `--shadow-`
namespace inside `@theme`, and a same-named entry would self-reference.

## Borders

Two tiers, both clear of every surface step so a border is visible wherever it
lands:

- `--border-subtle` — dividers _inside_ a surface. This is the default, so
  `border-border` and `--border` resolve to it.
- `--border-strong` — outlines of containers that must hold their own against a
  raised surface. Opt in with `border-strong`.

## Brand accent vs. primary

These are different things and the naming is a known hazard:

- `--primary` — the neutral high-contrast button surface. Near-black in light,
  near-white in dark. Not a brand colour.
- `--accent` — shadcn's **hover wash**. Not a brand colour either. It is
  translucent (a wash of `--foreground`), so the same token reads correctly on
  every elevation step.
- `--accent-brand` — the app's identity colour: links, wikilinks, mentions,
  text selection, active-state emphasis. **This is the one you want when you
  mean "accent" in the everyday sense.**

The accent comes from the theme preset, which has separate light and dark
values for it. `--ring` follows `--accent-brand` in `app.css`, so focus rings
match. There is no separate accent setting any more: the old Appearance →
Accent colour override was one hex value for both modes, which a preset can
always do better, and it hid the preset's own accent. Values saved by older
builds (`appearance.accent`) are dropped when settings, browser imports or
backups load, and the next save leaves them out. To change the accent, save a
custom preset.

## Theme presets

Appearance settings offer Apollo (the default, ID `default`), Slate & Indigo,
Paper & Teal, Warm and Forest. The two new presets use the reserved IDs
`builtin:slate-indigo` and `builtin:paper-teal`, leaving existing custom IDs
such as `slate` and `paper` available. Apollo pairs blue-slate neutrals with an ochre
accent; Slate & Indigo is cool and neutral; Paper & Teal is warm paper with a
teal accent. The default preset's values are also the base tokens in
`app.css`, so the two must change together. Light/dark/system mode
is independent of preset selection. Presets and UI font size apply to every
vault on this device. Editor font size and line height stay in the vault.

How a user makes, imports and removes a preset, and the full preset format
with its validation rules, are in [Custom themes](../custom-themes.md).
`themeContrast` in `src/lib/settings/theme-presets.ts` checks those ratios by
converting OKLCH to clipped linear sRGB, and `src-tauri/src/theme_presets.rs`
checks them again before a preset is stored.

Root `theme-presets.json` stores up to 64 user presets in a versioned map. Use
the settings UI to edit them so validation, locked publication and
notifications run. Removing a selected preset keeps its selection and displays
Apollo; restoring the same ID restores the theme, and the original data stays
available during recovery. Complete built-in examples live in
[`src/lib/settings/theme-presets.json`](../../src/lib/settings/theme-presets.json).

## Named colours

`--named-red` … `--named-pink` are eight hues for things that carry a colour
of their own, starting with vault tiles. Code stores the name, never the value:
a vault's entry in `profiles.json` says `"color": "teal"`, and the active
preset decides what teal looks like in each mode. Apollo, Slate & Indigo and
Paper & Teal set their own; Warm and Forest use the `app.css` values, which
mirror Apollo. Light values sit around L 0.55 with near-white
`--named-foreground`; dark values sit around L 0.75 with dark text, so the same
colour also reads as text on the matching surfaces.

The backend gives each vault a colour when it is created, and gives one to every
vault in an index written before colours existed, the first time it loads. It
picks the ID's colour (FNV-1a, the same hash as `vaultTileColor` in
[`src/lib/vaults/tile.ts`](../../src/lib/vaults/tile.ts)) unless an older vault
already has it, then steps three colours on until one is free. Stored colours
never change, so deleting or renaming a vault leaves every colour alone.

## Status colours

`--success`, `--warning`, `--info` and `--destructive`. `--destructive` is the
fourth member of this ramp and keeps its shadcn name — there is no `--danger`
alias, so there is exactly one word for the concept.

Presets do not carry status colours, so one set serves every preset. They come
from Apollo's green, teal and red, with a yellower amber for `--warning` so it
stays apart from Apollo's ochre accent. Each base colour is checked as text
against every built-in preset's surfaces (at least 4.6:1).

Each has three companions:

| Suffix        | Meaning                                                     | Example utility           |
| ------------- | ----------------------------------------------------------- | ------------------------- |
| _(base)_      | tuned for **text** contrast against the surrounding surface | `text-success`            |
| `-foreground` | text placed **on** the base colour as a fill                | `text-success-foreground` |
| `-subtle`     | translucent tint for a background                           | `bg-success-subtle`       |
| `-border`     | translucent tint for an outline                             | `border-success-border`   |

`-subtle` and `-border` are `color-mix` derivations of the base, so they compose
over any elevation step and no per-surface variant is needed. The whole
`bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-400`
pattern collapses to `bg-success-subtle border-success-border text-success`.

## Rules

These are enforced by `pnpm lint:theme`
([`src-tauri/scripts/lint-theme.mjs`](../../src-tauri/scripts/lint-theme.mjs)),
which runs on staged files at commit time and over all of `src/` as part of
`pnpm verify`.

1. **No raw colour literals in components.** No hex, no `rgb()`, no Tailwind
   palette utilities (`bg-emerald-500`, `text-amber-700`, `border-sky-500/30`).
   If a token is missing, add one to layer 1 rather than reaching past it.
2. **No `dark:` variants for colour.** Tokens already swap. A `dark:` colour
   variant means a token is missing or the wrong one is being used.
3. **Pick a surface by elevation, not by appearance.** "What sits on what" is
   the question, not "what looks about right".
4. **Derive, don't duplicate.** A new semantic token should be a `var()` or
   `color-mix()` of an existing one wherever the meaning allows.

### Documented exceptions

Some things are deliberately not on the surface or accent scales, because the
colour _is_ the meaning and must not follow the preset's accent. They are still
tokens with light and dark values — the exception is the fixed hue, not the
absence of a token:

- `--diagnostic-spelling` / `-grammar` / `-style`, the squiggle underlines.
- `--diff-add` / `--diff-remove` (plus `-subtle`), used by both the
  ProseMirror diff decorations in `app.css` and the diff components.
- `--scrim`, the wash behind a modal. Always black, because a scrim's job is
  to darken what is behind it; only its strength is theme-dependent.

- `--highlight-search` / `-active` / `-selection`, shared by the editor's
  find decorations and the PDF viewer's overlay.
- Ink pen swatches and PDF annotation colours
  ([`src/lib/ink/editor-helpers.ts`](../../src/lib/ink/editor-helpers.ts),
  [`src/lib/pdf/viewer-helpers.ts`](../../src/lib/pdf/viewer-helpers.ts)). They
  are content: strokes and annotations store sRGB hex and PDF export writes it,
  so they cannot follow a preset. The pens are Apollo ink plus its named
  colours, dark enough for the white page; the PDF set is lighter highlighter
  tints of the same hues. The ink editor's selection and lasso marks are
  chrome, so they use the preset accent for the page's own light or dark mode.

The linter also allows three things by design:

- **Shadows.** `--elevation-raised` / `--elevation-overlay` cover the common
  cases, but a directional shadow (a bottom sheet lifting off the bottom edge)
  is geometry as much as colour and is spelled out locally.
- **`var()` fallbacks.** Anything painting before `app.css` loads — the boot
  screen, `app.html`'s bootstrap — must inline a literal. Keep those in step
  with the tokens they stand in for.
- **Canvas painting.** `ctx.fillStyle` / `strokeStyle` take a resolved colour
  string, not a `var()`. The ink editor reads tokens from the DOM where it
  can; the rest are drawing constants.

## Pre-paint bootstrap

The inline `<style>` in [`src/app.html`](../../src/app.html) hardcodes the
default `--surface-1` and `--foreground` values to avoid a flash before `app.css`
loads. It first applies validated numeric preset tokens from the root bootstrap
or browser cache. Its literal fallbacks must still match the default tokens.
Update `app.html` when those defaults change. Main windows receive root mode,
preset and font size before document scripts run; popouts share their
vault's cache and use its resolved surface color as the native background.

## Composing a panel

Reach for the primitives rather than hand-rolling container chrome:

- [`ui/surface`](../../src/lib/components/ui/surface) — `<Surface as="aside"
variant="panel">` for a pane of the shell, `variant="section"` for a grouped
  region inside it, `variant="raised"` for a discrete item on a section, and
  `variant="overlay"` for something genuinely floating. The `padding` prop
  covers the common insets.
- [`ui/section-header`](../../src/lib/components/ui/section-header) — the compact
  heading that titles a region.

The desktop navigation uses `surface-0`; the details pane uses `surface-1`.
Sections inside the details pane share its background and use dividers rather
than nested cards. The `--editor-surface` token selects `surface-3` in light mode
and `surface-1` in dark mode; the active document tab shares that surface.
Use `bg-editor-surface` when a desktop document surface needs a utility class.
The toolbar and right sidebar header align with the 42px document tab strip.

## Migration status

Everything is on the token system: both sidebars, the desktop and mobile shell
chrome, the Kanban board, the dockview chrome, the Milkdown/Crepe editor, and
every status colour. There are no raw Tailwind palette utilities left in
`src/` — no `bg-emerald-500`, no `text-amber-700`, no `dark:` colour variants.

Known remaining work:

- **Dialogs and sheets** — the dialog body is `surface-3` (correct, it floats)
  but its header bars are `bg-card` too, so they are flat against it. They want
  `Surface variant="overlay"` for the shell and a lower step for the header.
  Guardrails are in place: `pnpm lint:theme` fails the commit if a raw palette
  utility, a `dark:` colour variant, or a colour literal reappears.

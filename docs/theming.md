# Theming

All colour, elevation and radius in the app comes from tokens defined in
[`src/app.css`](../src/app.css). This document is the contract for that file:
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
| `--surface-0` | window chrome behind everything — title bar, dock strip, mobile top/bottom bars             | 0.955     | 0.155    |
| `--surface-1` | panels — sidebars, editor panel, board background (this is what `--background` resolves to) | 0.976     | 0.185    |
| `--surface-2` | containers on a panel — Kanban columns, sidebar sections, grouped wells                     | 0.990     | 0.215    |
| `--surface-3` | items and overlays — cards, popovers, dialogs, menus                                        | 1.000     | 0.245    |

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

Appearance → Accent overrides `--accent-brand`, `--accent-brand-foreground` and
`--ring` only (see [`src/lib/settings/accent.ts`](../src/lib/settings/accent.ts)).
It used to override `--primary`, which turned every neutral button in the app
into the user's accent colour.

The setting is applied only when the user has actually changed it. A single hex
cannot carry separate light and dark values, so an untouched install keeps the
theme's own `--accent-brand`, which does.

## Status colours

`--success`, `--warning`, `--info` and `--destructive`. `--destructive` is the
fourth member of this ramp and keeps its shadcn name — there is no `--danger`
alias, so there is exactly one word for the concept.

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
([`src-tauri/scripts/lint-theme.mjs`](../src-tauri/scripts/lint-theme.mjs)),
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
colour _is_ the meaning and must not follow a user-chosen accent. They are still
tokens with light and dark values — the exception is the fixed hue, not the
absence of a token:

- `--diagnostic-spelling` / `-grammar` / `-style`, the squiggle underlines.
- `--diff-add` / `--diff-remove` (plus `-subtle`), used by both the
  ProseMirror diff decorations in `app.css` and the diff components.
- `--scrim`, the wash behind a modal. Always black, because a scrim's job is
  to darken what is behind it; only its strength is theme-dependent.

- `--highlight-search` / `-active` / `-selection`, shared by the editor's
  find decorations and the PDF viewer's overlay.

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

The inline `<style>` in [`src/app.html`](../src/app.html) hardcodes the
`--surface-1` and `--foreground` values to avoid a flash of the wrong colour
scheme before `app.css` loads. It cannot use tokens — it runs first. **If you
change `--surface-1` or `--foreground`, update `app.html` in the same commit.**

## Composing a panel

Reach for the primitives rather than hand-rolling container chrome:

- [`ui/surface`](../src/lib/components/ui/surface) — `<Surface as="aside"
variant="panel">` for a pane of the shell, `variant="section"` for a grouped
  region inside it, `variant="raised"` for a discrete item on a section, and
  `variant="overlay"` for something genuinely floating. The `padding` prop
  covers the common insets.
- [`ui/section-header`](../src/lib/components/ui/section-header) — the small
  uppercase label that titles a region.

Both sidebars are built this way, which is what makes them read as one design:
the panel is `surface-1`, its sections are `surface-2`, and items on a section
(the content-stat tiles) are `surface-3`.

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

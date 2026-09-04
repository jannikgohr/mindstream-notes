# Memory footprint

The desktop app is a Rust host plus a WebView2 process tree, and almost all of
its resident memory belongs to the tree, not to us. This page records what the
floor is made of, how to measure it, and which knobs actually moved it — so the
next person does not have to rediscover that (say) shrinking a JS chunk by
100 kB is worth about 350 kB while turning off one Chromium process is worth
tens of megabytes.

## How to measure

Two harnesses, deliberately separate:

- **Whole app, real binary.** Launch a release build against a throwaway
  profile and sample the whole process tree. The number that matters is the
  sum of **private working sets** — that is what Windows' Task Manager reports
  on the Processes tab, and therefore the number a user quotes. Working set
  double-counts shared DLL pages across the five processes, so it reads ~4×
  higher and is only useful for comparisons against itself.
- **Renderer only, browser fallback.** `e2e-tests/perf/*.mjs` drive the SPA in
  headless Chromium against `vite preview`, which iterates in seconds instead
  of the ~5 minutes a release build takes:
  - `open-notes-bench.mjs` — marginal cost of each additional open note.
  - `open-close-leak.mjs` — whether opening and closing a note returns to
    baseline (it does; retention is asymptotic, ~2.7 MB over 12 cycles).
  - `heap-breakdown.mjs` — V8 heap snapshot aggregated by constructor.
  - `boot-payload.mjs` — every JS/CSS file the shell fetches to show one
    markdown note, with a guess at each chunk's owner.

  Start the server first (`vite preview --port 1440 --outDir .output/build`);
  the scripts do not manage it.

## Where the floor comes from

Measured idle, empty vault, one seeded note, on Windows 11 with WebView2
152.x — sum of private working sets:

| process           | before       | after                           |
| ----------------- | ------------ | ------------------------------- |
| renderer          | 53.8 MB      | 51.0 MB                         |
| WebView2 browser  | 27.9 MB      | 46.7 MB (absorbs GPU + network) |
| GPU process       | 26.4 MB      | — merged                        |
| Tauri host (Rust) | 8.0 MB       | 8.0 MB                          |
| network service   | 6.8 MB       | — merged                        |
| storage service   | 3.2 MB       | 3.3 MB                          |
| crashpad handler  | 2.2 MB       | 2.1 MB                          |
| **total**         | **128.2 MB** | **111.0 MB**                    |
| processes         | 7            | 5                               |
| commit charge     | 261 MB       | 176 MB                          |

## What moved it

### WebView2 process configuration

`app.windows[0].additionalBrowserArgs` in `src-tauri/tauri.conf.json`. JSON
takes no comments, so the reasoning lives here:

- `--in-process-gpu` — the largest single win (−13 MB private, −75 MB commit,
  one fewer process). The trade is isolation: a GPU driver fault now takes the
  webview down with it instead of being restarted underneath us. Accepted
  because the app autosaves continuously and the alternative costs a third of
  the commit charge. **This is the first flag to drop if users report black or
  corrupted rendering on a specific GPU.**
- `--enable-features=NetworkServiceInProcess2` — folds the network service into
  the browser process. The app is local-first; the webview itself fetches
  nothing off-machine (sync and updates run through `reqwest` in Rust).
- `--renderer-process-limit=1` — popout note windows are same-origin views of
  the same app, so let them share one renderer instead of paying a fresh
  ~50 MB each.
- `--disable-features=…Translate,OptimizationHints,MediaRouter,AudioServiceOutOfProcess,BackForwardCache`
  — none of these are reachable in an app with no navigation, no `<audio>`, and
  no cast targets. `msWebOOUI,msPdfOOUI,msSmartScreenProtection` are wry's
  defaults and must be repeated here: setting `additionalBrowserArgs` replaces
  them rather than appending.

Measured and rejected: `--disable-gpu-compositing` (worse than
`--in-process-gpu` on every axis), `--disable-features=StorageServiceOutOfProcess`
(+5 MB — the process spawns anyway), `--js-flags=--lite-mode` (−5 MB, but it
turns off TurboFan, and ProseMirror plus Yjs are exactly the hot JS that needs
it), `--js-flags=--optimize-for-size` (inside noise).

### Idle eviction of spellcheck dictionaries

Hunspell tables are ~18 MB resident for `de_DE_frami` and ~3 MB for `en_US`,
and used to stay warm for the life of the process after the first check. They
are now dropped after three idle minutes (`src-tauri/src/spellcheck/mod.rs`)
and reloaded in ~50 ms on a blocking thread when checking resumes.

## What is not worth chasing

- **Open notes.** Dockview only renders the visible panel, so the second and
  later tabs cost ~1.2 MB of heap and ~190 DOM nodes each — a tab strip entry
  and a tree row, not an editor. "Ten notes open" is not why the app is large.
- **A leak.** Twelve open/close cycles on the same note settle ~2.7 MB above
  the first open and stop climbing; DOM node count returns exactly to baseline.
- **Shaving JS.** Worth knowing the exchange rate: V8 keeps each loaded script
  both as an external source string and as bytecode, so 1 MB of shipped JS is
  ~3.5 MB of heap. But the 3.3 MB boot payload is ~1.5 MB of Milkdown/Crepe
  (which statically imports KaTeX, Vue, DOMPurify and CodeMirror from one
  barrel module, so feature flags cannot tree-shake it), 340 kB of dockview and
  286 kB of CSS. There is no large removable piece left, only upstream bloat.

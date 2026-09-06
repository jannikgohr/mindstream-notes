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

  Two probes need the real binary instead, because neither Chromium nor a unit
  test can see WebView2's input pipeline or its visibility state — run both
  through the T3 harness (`pnpm test:e2e:app -- --spec <file>`):
  `e2e-tests/perf/settings-hover-latency.e2e.ts` and
  `e2e-tests/perf/hidden-visibility.e2e.ts`.

  **Do not run the e2e harness while a long measurement is in flight.** All
  WebView2 hosts sharing a user-data folder share one browser process, and
  `mindstream-notes.exe` and `mindstream-notes-e2e-single.exe` share
  `%LOCALAPPDATA%\com.jannikgohr.mindstream-notes\EBWebView`. Killing the
  harness tree takes the other app's webview down with it — which looks
  exactly like the app under measurement having exited on its own.

  Start the server first (`vite preview --port 1440 --outDir .output/build`);
  the scripts do not manage it.

## Where the floor comes from

Measured idle, empty vault, one seeded note, on Windows 11 with WebView2
152.x. Each total is the median of ten private-working-set samples taken one
second apart after a 25-second startup wait:

| process           | unsafe process folding | safe production flags |
| ----------------- | ---------------------: | --------------------: |
| renderer          |                51.7 MB |               52.0 MB |
| WebView2 browser  |                26.9 MB |               28.4 MB |
| GPU process       |                24.6 MB |               26.5 MB |
| Tauri host (Rust) |                 7.4 MB |                7.9 MB |
| network service   |                      — |                6.8 MB |
| storage service   |                 3.2 MB |                3.2 MB |
| crashpad handler  |                 2.1 MB |                2.1 MB |
| **total**         |           **116.1 MB** |          **126.9 MB** |
| processes         |                      6 |                     7 |

Removing the unsafe flags costs 10.8 MB, or 9.3%, at idle. Most of that is
the restored network-service process.

Minimised or parked in the tray, the same build sits at 18–33 MB (below).

## What moved it

### WebView2 process configuration

`app.windows[0].additionalBrowserArgs` in `src-tauri/tauri.conf.json`. JSON
takes no comments, so the reasoning lives here:

- `--in-process-gpu` — **measured, shipped, and then reverted.** It was the
  largest memory win by far (−13 MB private, −75 MB commit, one fewer
  process), and it cost roughly seven times the frame time: a mouse sweep
  down the settings rail on the real binary went from a flat 6.1 ms per frame
  to a p50 of 42 ms with 60% of frames over 32 ms, and pointer-event delay
  from 4.6 ms to a p95 of 28 ms. That is the whole UI at ~24 fps to save
  13 MB. Running the GPU thread inside the browser process puts it on the UI
  thread this app already has contention on — the same thread the Typst
  preview stall was traced to. Do not re-add it.
- `--renderer-process-limit=1` — popout note windows are same-origin views of
  the same app, so let them share one renderer instead of paying a fresh
  ~50 MB each.
- `--disable-features=msWebOOUI,msPdfOOUI,Translate,OptimizationHints,MediaRouter,BackForwardCache`
  removes browser UI and navigation features this app does not use.

Measured and removed from production: `NetworkServiceInProcess2` saved 10.8 MB
by moving the network service into the privileged browser process. That is not
a reasonable security trade for this app. The same cleanup removed
`msSmartScreenProtection`, `AudioServiceOutOfProcess`,
`--disable-background-networking`, and `--disable-component-update`. Those
flags either remove browser protections, suppress their update paths, or move
more parsing into the browser process.

Measured and rejected: `--disable-gpu-compositing` (worse on every axis),
`--disable-features=StorageServiceOutOfProcess`
(+5 MB — the process spawns anyway), `--js-flags=--lite-mode` (−5 MB, but it
turns off TurboFan, and ProseMirror plus Yjs are exactly the hot JS that needs
it), `--js-flags=--optimize-for-size` (inside noise).

### Telling the webview it is off screen, and letting it shrink

The app closes to the tray rather than quitting, and supports starting there,
so "running but invisible" is a state it spends real hours in. Two separate
things had to be fixed for that to be cheap.

**The page never knew it was hidden.** `Window::hide()` — what close-to-tray
calls — and minimising both hide the OS window, but neither touches
`ICoreWebView2Controller::IsVisible`; wry only sets that from the
webview-level show/hide, which nothing in the app called. Measured with the
window minimised, `document.visibilityState` was still `"visible"`. So
Chromium kept the page in the foreground: timers at full rate, compositing
alive, and every page released by the memory trim below faulted straight back
in. That is why a tray-parked app crept back to its full resident size over
an hour. `webview_memory.rs` now sets `IsVisible` from the window's actual
state, which is asserted in both directions (plus that the restored window
still paints) by `e2e-tests/perf/hidden-visibility.e2e.ts`.

A side effect worth knowing: `$lib/editor/suspend-flush` listens for
`visibilitychange → hidden` to flush the 800 ms save debounce, and its comment
has always claimed that fires "on desktop when the window is minimised". It
did not, until now. Closing to the tray mid-edit used to drop the last
debounce window; it no longer does.

**The memory level.** `ICoreWebView2_19::SetMemoryUsageTargetLevel(LOW)` is
the switch Microsoft ships for a hidden webview, and it is what produces the
immediate drop:

| minimised to the taskbar | before   | after   |
| ------------------------ | -------- | ------- |
| private working set      | 103.0 MB | 20.1 MB |
| working set              | ~370 MB  | 89 MB   |
| commit charge            | ~180 MB  | 168 MB  |

Sampled every five minutes over an hour on the fixed build, private working
set for the whole tree, starting from 116.3 MB on screen:

| t   | total    | renderer |
| --- | -------- | -------- |
| 0m  | 112.1 MB | 48.7 MB  |
| 6m  | 59.4 MB  | 31.0 MB  |
| 31m | 59.6 MB  | 30.9 MB  |
| 41m | 29.8 MB  | 9.1 MB   |
| 51m | 20.7 MB  | 2.0 MB   |
| 66m | 20.1 MB  | 1.9 MB   |

The renderer's cumulative CPU does not move across the whole hour, which is
the real tell: before, the page was still running. The step down after ~35
minutes is Windows reclaiming pages that nothing has touched since the trim.

Read that honestly: **this is mostly paging out, not freeing.** Commit charge
barely moves, so the app still owns the address space; what it gives back is
physical RAM, which is the thing another application can actually use and the
number Task Manager shows. Restoring the window faults back only what gets
touched, so a restored window settles around 60 MB rather than the 115 MB it
started at.

The webview is not discarded or reloaded — the renderer keeps the same PID
across a hide/restore cycle, so nothing in the editor is lost.

Dropping to LOW is deferred by 20 seconds; backgrounding the page is not,
because that costs nothing to undo. Undoing LOW does cost page faults on the
way back, so a window parked in the tray should pay it and a
minimise-and-restore ten seconds later should not.

Only the `main` window is managed. Popout note windows get their own webview
and are short-lived, so they are left alone.

### Not holding spellcheck dictionaries the user is not using

Hunspell tables are by far the largest thing the Rust process holds, and the
cost is wildly uneven by language — measured as private working set, with the
process at 0.8 MB before any load:

| resident                    | cost     |
| --------------------------- | -------- |
| `en_US` (551 kB pair)       | ~2.1 MB  |
| `de_DE_frami` (4.4 MB pair) | ~18.9 MB |

They used to stay warm for the life of the process after the first check.
Three things now bound that:

- **Idle eviction.** Dropped after three idle minutes
  (`src-tauri/src/spellcheck/mod.rs`), reloaded in ~50 ms on a blocking thread
  when checking resumes.
- **Not running a shadowed checker at all.** `DiagnosticProvider.kinds` has
  always existed so that "overlapping providers can be de-conflicted without
  running them", but `bus.ts` only ever applied ownership when _composing_
  results. So with the LanguageTool plugin owning spelling, the built-in
  dictionary was still checked on every keystroke and its findings thrown
  away — which on desktop is an IPC round trip that pulls those tables back
  in and keeps them there. The bus now runs a fully-shadowed provider only
  over the segments the owner left unanswered, which in the healthy case is
  none of them. The offline fallback is unchanged: if the owner fails, or
  hangs past the grace, the dictionary is asked and answers.
- **Explicit release.** When the built-in checker is switched off, every
  language is deselected, or a plugin takes spelling over, the frontend calls
  `spellcheck_release_dictionaries` rather than leaving ~19 MB resident for up
  to three minutes waiting on the sweep.

### Interaction latency

`e2e-tests/perf/settings-hover-latency.e2e.ts` drives a real WebDriver mouse
sweep down the settings rail and records both frame intervals and how long
pointer events sit before JS sees them. Worth reaching for before assuming a
memory change caused a responsiveness one: when the settings rail was reported
as lagging, it found two separate things: a 150 ms `transition-colors` fade on
the rail rows (a design choice, now 75 ms), and a real 7× frame-time
regression from `--in-process-gpu`, which is why that flag is gone.

A warning from getting this wrong once: `MINDSTREAM_E2E_SKIP_BUILD=1` skips
preflight's binary _copy_ as well as its build, so the T3 harness will happily
run a stale `mindstream-notes-e2e-single.exe` and report green. When using that
flag to iterate, copy `mindstream-notes.exe` over it yourself first — the first
run of this probe measured the previous build and cleared a regression that was
really there.

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

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
  `mindstream-notes.exe` and `mindstream-notes-e2e.exe` share
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

All of the Windows numbers on this page predate vault worker processes. A
release launch now runs a coordinator, which owns the tray and has no webview,
plus one worker per open vault that owns the window and its webview. On Linux
the coordinator holds about 19 MB private and a worker 43–48 MB, next to a
WebKit web process of 240–270 MB with no tabs open. The `e2e-data-dir` build
the app harness launches runs a single direct process, so it does not show
the coordinator, and its numbers are not a release build's.

The first launch after the browser-storage migration is not representative
either: the migration page leaves the coordinator with a WebKit network
process until it exits. Measure the second launch.

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

### Mounting editors only when their tab is first shown

Every tab used to mount its full editor when its dock panel was created, and a
restored layout creates all of them at startup. Dockview's default renderer
only detaches a background tab's element, so the editor, its Y.Doc, its
awareness timer and its sync listener all stayed alive. Measured on the Linux
release build with 1,500 notes: twelve restored tabs cost about 280 MB in the
web process, whichever kind of note was active, and hiding the window gave
back only about 70 MB of it.

`mountWhenFirstVisible` (`src/lib/desktop/mount-when-visible.ts`) now mounts a
panel's editor the first time dockview shows it. Dockview reports a new panel
as visible until its group has placed it, and a restore activates panels in
turn, so visibility is only read after the current synchronous work. Tabs the
user has visited stay mounted; unmounting them would lose scroll position and
undo history.

### Keeping a hidden window idle

What makes a parked window's footprint unstable is anything that wakes it. On
Windows a wake faults trimmed pages back in, and on every platform it adds
garbage. The largest one was scheduled sync: every 30 seconds while signed
in, `sync-completed` made the hidden page reload the whole note tree into
reactive state and re-run the PDF search-index sweep, even when the sync
changed nothing. With 1,500 notes on Linux that was ~120 ms of CPU and a
6–30 MB swing in the web process per tick.

`deferWhileHidden` (`src/lib/defer-while-hidden.ts`) holds work that only keeps
the UI current while `document.visibilityState` is hidden, and runs it once
when the page is shown again. The tree refresh, the PDF sweep and the PDF
viewer's signature refresh use it; the sync itself still runs in Rust. With
it, the same hidden window stayed within 1 MB across three minutes of ticks.
Use it for any new listener that only refreshes what the user would see.

A visible window reloads the tree only when `sync-completed` says
`tree_changed`. Rust compares a hash of the tree snapshot with the one the
last successful sync saw, because the report's counts miss changes such as a
shared folder's discarded edits, and a sync can change the tree and then
fail. A hidden `CollabProvider` sends no presence: it tells the room its
cursor is gone and re-announces it when shown. Awareness would otherwise renew
it every 15 seconds for each open shared note.

### Unloading a window hidden for long

An idle WebKitGTK page holds about 250 MB however little it shows, and 400 MB
after some ink and editing, so no amount of trimming inside it gets a tray app
under 100 MB. A main window hidden to the tray for 15 minutes, with no popout
open (or 15 minutes after the last one closed), is therefore saved and destroyed (`worker_shutdown::unload_main_window`,
timed from `webview_memory.rs`). The worker keeps the Rust sync and the change
feed running; live Yjs collaboration lives in the page and stops with it.
`tray::focus_main_window` builds the window again for anything that asks for
it: the tray, a second launch, a shortcut, an invite link.

Measured on Linux, 1,500 notes, 12 tabs, private memory of the whole tree:

| state                      | coordinator | worker | WebKit |  total |
| -------------------------- | ----------: | -----: | -----: | -----: |
| hidden, after some editing |       20 MB |  57 MB | 411 MB | 490 MB |
| unloaded                   |       20 MB |  39 MB |   8 MB |  68 MB |

The worker drops below its visible size because it calls `malloc_trim` after
the destroy; without it, glibc kept ~30 MB of the freed page and the total sat
at ~100 MB. WebKit's network process stays (8 MB) and is not worth chasing.

Traps:

- Tauri raises `ExitRequested` when the last window goes. A worker answers that
  by quitting the whole app, so it must not while unloaded (`lib.rs`).
- A full quit while unloaded has no window to save; `Book::begin` accepts the
  empty set only then.
- The rebuilt page loads before its listeners exist. A note made from the tray
  or a shortcut waits in `tray::CreatedNotes` until the window takes it.
- Undo history survives through `$lib/editor/retained-undo`: before the
  destroy each editor hands its history to Rust (in memory only), and a tab
  takes it back when it mounts. Yjs undo needs the deleted content the stored
  note has collected, so `yjs-undo-snapshot` carries the editor's document too.
  Excalidraw's history cannot be exported, so a freeform tab loses its undo,
  and a note left in Source view comes back in the default view without its
  source-pane history, as a switch to WYSIWYG already does.

### A browser tab

The browser leaves a tab's memory to Chrome. Measured on Linux Chromium with
1,500 notes and the same 12 tabs, the tab's renderer (with the SQLite worker)
holds 129 MB restored with one tab shown, 196 MB after every tab was shown
once and 186 MB hidden. The app's JS stays idle while hidden. Energy Saver's
freezing frees nothing and rarely applies: it only freezes CPU-heavy tabs, and
never one the user has edited. Memory Saver's discard frees the whole
renderer, and the tab reloads with `document.wasDiscarded` in under a second.

What a discard would lose, and how it is kept:

- Edits inside the save debounce: `suspend-flush` saves on hide, and a tab is
  always hidden before it is discarded.
- Undo history: `retained-undo` writes every editor's history to
  sessionStorage each time the tab hides, and the reload takes it back, as the
  desktop does across an unload. A reload the user starts keeps it too.

A second tab is refused the vault lock but queues for it, and reloads once
the owner closes (`reloadWhenVaultFree` in `$lib/browser/vault.ts`). The
queued request also stops Chrome freezing the owner. A frozen owner would
otherwise hold the lock with nothing to make Chrome wake it.

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
run a stale `mindstream-notes-e2e.exe` and report green. When using that
flag to iterate, copy `mindstream-notes.exe` over it yourself first — the first
run of this probe measured the previous build and cleared a regression that was
really there.

## What is not worth chasing

- **A leak.** Twelve open/close cycles on the same note settle ~2.7 MB above
  the first open and stop climbing; DOM node count returns exactly to baseline.
- **Shaving JS.** Worth knowing the exchange rate: V8 keeps each loaded script
  both as an external source string and as bytecode, so 1 MB of shipped JS is
  ~3.5 MB of heap. But the 3.3 MB boot payload is ~1.5 MB of Milkdown/Crepe
  (which statically imports KaTeX, Vue, DOMPurify and CodeMirror from one
  barrel module, so feature flags cannot tree-shake it), 340 kB of dockview and
  286 kB of CSS. There is no large removable piece left, only upstream bloat.

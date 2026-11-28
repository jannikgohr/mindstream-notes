# Mindstream against Obsidian, Joplin and Logseq on Windows

Measured 2026-11-28 on PANDORASCORE: Ryzen 7 7800X3D, 31 GB RAM, GeForce RTX
4070 Ti SUPER on a 165 Hz display, Windows 11 (build 26300). Every app drew
on the RTX through ANGLE/Direct3D 11, and each result records the GPU it
saw. Same apps, vaults, queries and steps as the
[Linux run](competitors-2026-11-27.md), from the scripts in
[e2e-tests/perf/competitors](../../../e2e-tests/perf/competitors/).

Mindstream is `41b1b74b` in two builds:

- **Desktop**: what users install. A release build with the test-instance
  seam (`--features e2e-data-dir`) on WebView2 158 and native SQLite, run
  with `bench:vault --native`.
- **Web**: the browser build in Playwright's Chromium (build 1228), storing
  notes in OPFS through WebAssembly. The Linux run measured only this one.

Cold start is the median of 3 launches, timed from spawning the process.
Memory is the private working set (Task Manager's "Memory") summed over each
app's process tree. It leaves shared pages out, so it reads lower than the
Linux run's PSS and doesn't compare with it. Frame rates cap at the
display's 165 fps. Mindstream's desktop 20k run was done twice: import,
cold start and both graphs agreed within 5 %, search and opening a note
within 15 %.

## 20,000 notes

| Step                  | Desktop |    Web | Obsidian                       | Joplin                         | Logseq |
| --------------------- | ------: | -----: | ------------------------------ | ------------------------------ | ------ |
| Import / first index  |    81 s |  117 s | 93 s (indexes in place)        | 543 s, then 716 s until search | failed |
| Cold start, file tree |  0.83 s | 0.87 s | 2.05 s, index clean after 8 s  | 2.23 s                         |        |
| Search, first hit     |  1.19 s | 1.61 s | 0.14 s, all files in 7.3–8.6 s | 0.79 s                         |        |
| Open a note           |  155 ms | 165 ms | 122–202 ms                     | 289 ms                         |        |
| Local graph           |  1.14 s | 1.56 s | 0.33–0.35 s                    | none                           |        |
| Memory, idle          |  252 MB | 337 MB | 859–987 MB                     | 597 MB                         |        |

Logseq's import failed after 74 s with "Unexpected error: Failed to fetch",
as it did on every Wikipedia vault on Linux.

## Global graph, 20,000 notes

| Graph                                       | First draw | Settled         | fps settling | zoom, settling | fps after settling | Memory |
| ------------------------------------------- | ---------: | --------------- | -----------: | -------------: | ------------------ | -----: |
| Desktop, notes and tags (44,824 / 457,555)  |     0.96 s | 10 s            |          165 |            141 | 165, zoom 165      | 552 MB |
| Web, notes and tags (44,824 / 457,555)      |     0.71 s | 10 s            |          165 |            120 | 153, zoom 153      | 865 MB |
| Obsidian, notes and tags (44,819 / 468,300) |     1.84 s | 196 s           |           32 |             17 | 165, zoom 10       | 4.6 GB |
| Obsidian, existing notes (19,998 / 402,527) |     0.99 s | 62 s            |           26 |             13 | 165, zoom 10       | 3.9 GB |
| Obsidian default (237,705 / 799,310)        |     2.13 s | not after 300 s |           24 |             28 | 3, zoom 3          | 5.3 GB |

The 0.8–1.2 s zoom stalls of the Linux run are gone: no zoom sample of
Mindstream's recorded a long task, and its slowest frame took 24 ms. They
were software rasterisation, not our code. Obsidian's zoom after settling
still spends about 2.2 s of each 2 s sample in long tasks (the sample ends
on a late frame), with 390–670 ms frames.

## 28 notes

| Step                    | Desktop |    Web | Obsidian | Joplin                          | Logseq |
| ----------------------- | ------: | -----: | -------: | ------------------------------- | -----: |
| Import / first open     |  116 ms | 481 ms |   610 ms | 2.88 s, then 6.8 s until search | 1.66 s |
| Cold start              |  497 ms | 469 ms |   399 ms | 2.05 s                          | 2.04 s |
| Search, first hit       |  137 ms | 146 ms |    66 ms | 624 ms                          | 384 ms |
| Open a note             |   97 ms |  97 ms |    61 ms | 69 ms                           | 111 ms |
| Local graph             |   90 ms | 144 ms |    16 ms | none                            |        |
| Global graph first draw |   71 ms |  74 ms |   197 ms | none                            | 198 ms |
| Memory, idle            |  143 MB | 224 MB |   151 MB | 580 MB                          | 476 MB |

Mindstream's search includes its 100 ms debounce.

## What changed from Linux

- **The desktop app is the fastest importer**: 81 s against Obsidian's 93 s
  first index. On Linux the web build's 143 s was 3× Obsidian. The web build
  is still the slowest of the three here.
- **Memory leads hold and grow**: on the 20k vault the desktop app idles at
  about a quarter of Obsidian's memory, and uses an eighth of it with the
  matched graph open.
- **Search and the local graph are still where we trail.** They are as slow
  in the desktop app as in the web build: 956 ms of the desktop app's
  1.19 s search is the `search_notes` command, and 485 ms of its local graph
  is `list_note_links`. Both builds rank search hits with the same
  `rank_candidates` in `storage-core`, so the fixes named in the Linux doc
  apply to both.
- **Small fixed costs are gone on the desktop app**: at 28 notes it matches
  Obsidian's memory and beats it on import and the global graph. Obsidian
  is still faster to start, search, open a note and draw the local graph
  there.

## IPC waits in the desktop app

The desktop app's storage timings come from the IPC requests as the
DevTools protocol sees them. On the first start after the import, a dozen
trivial commands (`get_close_to_tray`, `plugin:event|listen`, ...) each took
about 805 ms, and on the last start about 20 took 146–160 ms. During the
search, `get_global_shortcut_status` took 888 ms next to `search_notes`. The
equal durations point at calls queueing behind one another rather than at
the commands themselves. Worth a profile before the next run.

## Caveats

- The Electron apps' windows are 1600×1000 from their command line; the
  desktop app's window opens at its default size and the page is resized to
  1600×1000 through the DevTools protocol, as the browser build's is.
- Joplin's window can't be told to keep drawing while covered; its numbers
  assume nothing covered it. Its plain Markdown importer keeps
  front matter as text, so it imported no tags. Logseq got paragraphs turned
  into bullets, as it drops the rest.

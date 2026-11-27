# Mindstream against Obsidian, Joplin and Logseq

Measured 2026-11-27 on dev-vm-ubuntu: 6 cores, 19 GB RAM, no GPU, every app
headed under Xvfb at 1600×1000. Mindstream is `41b1b74b`, the browser build in
Playwright's Chromium (OPFS storage, not the desktop app). The competitors are
Obsidian 1.15.1, Joplin 3.7.24 and Logseq 2.0.2 (DB graph), from the AppImages
pinned in [e2e-tests/perf/competitors](../../../e2e-tests/perf/competitors/).
The scripts there grew out of this run. Mindstream's numbers came from the
same steps that `bench:vault` now runs.

Vaults: the 28-note fixture in `e2e-tests/perf/fixtures/small-vault`, and
Simple English Wikipedia with 20,000 notes and 972,611 links, 406,097 of them
to articles outside the vault. Search queries are "lisbon" and "europe".

Cold start is the median of 3 launches, timed from spawning the process.
Memory is PSS summed over each app's process tree. Mindstream's 20k run and
Obsidian's matched graph run were each repeated, and agreed within a few
percent.

## 20,000 notes

| Step                  | Mindstream | Obsidian                          | Joplin                         | Logseq |
| --------------------- | ---------: | --------------------------------- | ------------------------------ | ------ |
| Import / first index  |      143 s | 43 s (indexes in place)           | 989 s, then 620 s until search | failed |
| Cold start, file tree |     1.35 s | 3.66 s, index clean after 13–28 s | 3.34 s                         |        |
| Search, first hit     |     1.58 s | 0.17 s, all 2,931 files in 20 s   | 0.75 s                         |        |
| Open a note           |     0.31 s | 0.19–0.28 s                       | 0.13 s                         |        |
| Local graph           |     1.58 s | 0.52 s                            | none                           |        |
| Memory, idle          |     634 MB | 933 MB                            | 742 MB                         |        |

Logseq's "File to DB graph" import failed on every Wikipedia vault tried
(1,500, 5,000 and 20,000 notes), each time about 105 s in. Twice the
database worker died ("Failed to fetch"); once the import stopped on a page
name, `No uuid found for page name "afi's 100 years/"`.

## Global graph, 20,000 notes

| Graph                                         | First draw | Settled         | fps settling | zoom, settling | fps after settling | Memory |
| --------------------------------------------- | ---------: | --------------- | -----------: | -------------: | ------------------ | -----: |
| Mindstream, notes and tags (44,824 / 457,555) |      1.0 s | 11 s            |        23–35 |            2–3 | 60 idle, zoom 4¹   | 1.2 GB |
| Obsidian, notes and tags (44,819 / 468,300)   |      3.0 s | not after 300 s |           11 |             11 | 1, zoom 1          | 4.6 GB |
| Obsidian, existing notes (19,998 / 402,527)   |      1.6 s | 204 s           |            8 |              4 | 60 idle, zoom 3    | 4.0 GB |
| Obsidian default (237,705 / 799,310)          |      4.0 s | not after 300 s |           10 |             11 | 2, zoom 2          | 3.9 GB |

¹ Most zoom frames take 17 ms, but each zoom burst stalls the main thread for
0.8–1.2 s. The Mindstream zoom numbers come from two later runs of
`bench:vault` on this code: the first harness sent its wheel events to the
WebGL canvas, which has no listener, and measured an idle graph.

Obsidian's default draws a node for every link to a missing note; the
"notes and tags" row is the like-for-like one. Its layout counts as settled when the renderer has had 60 frames
without an update, ours when the layout worker has been quiet for a second.

## 28 notes

| Step                    | Mindstream | Obsidian | Joplin                          | Logseq |
| ----------------------- | ---------: | -------: | ------------------------------- | -----: |
| Import / first open     |     1.19 s |   0.86 s | 1.65 s, then 7.8 s until search | 2.15 s |
| Cold start              |     0.87 s |   0.72 s | 3.21 s                          | 2.83 s |
| Search, first hit       |     169 ms |   104 ms | 551 ms                          | 410 ms |
| Open a note             |     207 ms |   104 ms | 87 ms                           | 155 ms |
| Local graph             |     206 ms |    29 ms | none                            |        |
| Global graph first draw |      99 ms |    83 ms | none                            | 176 ms |
| Memory, idle            |     488 MB |   346 MB | 738 MB                          | 682 MB |

Mindstream's search includes its 100 ms debounce.

## Where the time goes

- **Search:** 1,373 ms of the 1.58 s is the storage worker's `search_notes`.
  `rank_candidates` in `src-tauri/storage-core/src/search.rs` lowercases each
  of the ~2,900 FTS candidates into a `Vec<char>` and builds a regex-cleaned
  snippet for every one before keeping the top 200.
- **Local graph:** the first open loads every link in the vault
  (`loadNoteLinks` in `src/lib/notes/note-relations.ts`): 640 ms in
  `list_note_links`, the rest on the main thread.
- **Zoom:** not profiled yet. Long tasks fill 1.9–3.5 s of every 2 s zoom
  window, settled or not.
- **Import:** not profiled yet.

## Caveats

- No GPU: all apps rasterise in software, so frame rates are low across the
  board and will differ on real hardware.
- The browser build stores data in OPFS through WebAssembly; the desktop app's
  native SQLite may import and search faster.
- Joplin's plain Markdown importer keeps front matter as text, so it imported
  no tags. Logseq got paragraphs turned into bullets, as it drops the rest.
- Another session's builds ran on the VM at times, and the Logseq vault was
  copied during one Mindstream import; reruns matched the first numbers.

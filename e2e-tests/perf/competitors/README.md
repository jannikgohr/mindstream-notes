# Competitor benchmarks

Runs Obsidian, Joplin and Logseq through the steps of the
[large-vault benchmark](../wikipedia/bench.mjs), on the same vault, with the
same timing and memory helpers ([measure.mjs](../measure.mjs)). These are
manual tools for Linux with Xvfb and stay out of CI. Results from a run are
in [docs/internal/benchmarks](../../../docs/internal/benchmarks/).

```sh
# Mindstream, with results next to the others
pnpm bench:vault --json .output/bench/competitors/mindstream-20000.json
pnpm bench:vault --small --skip-build --json .output/bench/competitors/mindstream-small.json

# Each competitor: --small for the 28-note vault, --articles N for Wikipedia
xvfb-run -a -s "-screen 0 1920x1080x24" node e2e-tests/perf/competitors/obsidian.mjs
xvfb-run -a -s "-screen 0 1920x1080x24" node e2e-tests/perf/competitors/joplin.mjs --small
xvfb-run -a -s "-screen 0 1920x1080x24" node e2e-tests/perf/competitors/logseq.mjs --small

node e2e-tests/perf/competitors/summary.mjs   # one Markdown table of all results
```

The first run of each script downloads that app's pinned AppImage into
`~/.cache/mindstream-perf/apps/`, checks its SHA-256 and unpacks it. The
versions live in [common.mjs](common.mjs). Moving to a new release means
changing the version, URL and checksum together, then rerunning every app.
The selectors and internals each script reads (Obsidian's `app.metadataCache`,
Joplin's note list classes, Logseq's search dialog) can break on an update.

## Vaults

- `--small`: [../fixtures/small-vault](../fixtures/small-vault), 28 notes of
  everyday content (journal, projects, recipes), searched for "lisbon".
  Prettier skips this folder, so every app reads the same bytes.
- `--articles N` (default 20000): the Wikipedia vault from
  [make-vault.mjs](../wikipedia/make-vault.mjs), searched for "europe".

## What makes each app comparable

- Every app starts as its own process with the DevTools protocol on, and a
  cold start is timed from spawning the process, median of `--runs` (3).
  Mindstream runs its browser build in Playwright's Chromium.
- Steps are timed by polling the page every 50 ms. Memory is PSS summed over
  the app's process tree, so Chromium's and Electron's many processes count
  once each.
- Graph frame rates are taken while the layout moves (first 5 s and a zoom),
  then again after it settles or `--settle` seconds (300) pass.

## Traps

- **No GPU.** Under Xvfb every app rasterises in software. Absolute frame
  rates say more about the machine than the app, but the apps share the
  handicap.
- **Obsidian** reads the vault in place: its "import" is the first start until
  its metadata cache is clean. Its default graph also draws a node for every
  link to a missing note (about 238k on the 20k vault). Pass
  `--graph '{"hideUnresolved":true,"showTags":true}' --label=-tags` to draw
  what Mindstream draws, notes and tags. Use `--label=-x`, not `--label -x`.
  Obsidian closes with a beforeunload dialog, so it is disconnected before
  the SIGTERM.
- **Joplin** exits on start flags it doesn't know, so Playwright can't launch
  it. Its main process is reached through the Node inspector that SIGUSR1
  opens. `HOME` points at a scratch directory; the real profile is never
  touched. The plain Markdown importer keeps front matter as text, not tags,
  and search finds nothing until Joplin's background indexing has run.
- **Logseq** 2.0.2 imports only Logseq file graphs and drops paragraphs that
  aren't bullets, so the script converts the vault first. It failed to import
  every Wikipedia vault tried (1.5k, 5k and 20k notes), each time after about
  105 s; the script then saves what it has and exits with 1.
- **Chromium** started by hand waits about 25 s for the system keyring
  without `--password-store=basic`, and Chrome for Testing reopens the last
  session's tabs, which then wait on each other for the database.

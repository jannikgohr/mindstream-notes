# Requirements

Typst rendering runs the real Typst compiler, so the plugin needs binaries
installed on your machine and reachable on your `PATH`. Nothing is bundled, and
native binaries are desktop-only — Typst notes have no preview on mobile.

After installing a binary, confirm the plugin can find it under **Settings →
Plugins → Typst** — each declared binary has a **Check** button that resolves it
from your `PATH` and shows the path it found.

## `typst` — required for preview and export

Install the [`typst`](https://github.com/typst/typst) CLI. The plugin feeds your
source to it and shows the compiled PDF as the preview; the same binary produces
PDF exports.

Without it, Typst notes still open — but in **source-only** mode, with no
preview and no export.

## `tinymist` — optional, for live preview

Install [`tinymist`](https://github.com/Myriad-Dreamin/tinymist) for an
incremental live preview with **click-to-source**: clicking in the preview jumps
the editor to the matching spot in your source.

It's optional. Without it you still get a preview via `typst`, just recompiled on
a short debounce rather than updated incrementally.

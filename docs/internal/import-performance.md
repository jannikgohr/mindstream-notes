# Importer performance

How the importer scales to large vaults, and how to run the big-vault test.
What users see, from the formats to the link matching, is in
[Importing notes](../import.md).

The code lives in [`src-tauri/storage-core/src/import/`](../../src-tauri/storage-core/src/import.rs);
the dialog is
[`ImportNotesDialog.svelte`](../../src/lib/components/ImportNotesDialog.svelte).

## Two phases

The first phase walks the source without reading any note bodies and gives
every note its final id. The second reads one note at a time and rewrites its
links against that complete list. Because every id exists before any body is
rewritten, notes that link to each other work on the first pass, with no
ordering constraint, and a cycle of any length is not a special case.

## Built for a million notes

- Only one note body is in memory at a time. What grows with the vault is the
  link index, a few entries per note, held for the whole run.
- Notes are written 500 per transaction. Stopping an import keeps everything
  already written, and the database is released between batches so the app
  stays usable.
- Notes are written directly rather than through the normal note-creation path,
  which does two extra database round trips per note.
- The run happens off the UI thread and reports progress as it goes.

After the import finishes the file tree reloads, which reads every note summary
into the frontend. At a million notes that reload, not the import, is the slow
part.

## The Wikipedia performance vault

`pnpm bench:vault` (see the [e2e README](../../e2e-tests/README.md)) builds an
Obsidian vault from Simple English Wikipedia, with `[[links]]`, categories as
tags and redirects as aliases, imports it into the browser build and times the
import and the file-tree reload among other steps. Links to articles outside
the chosen number stay unresolved, which exercises that path too.

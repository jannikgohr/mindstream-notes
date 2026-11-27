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
- Notes are written in batches of 500, or fewer once a batch holds 64 MiB of
  attachments, so memory stays bounded.
- Natively the whole import is one transaction on a connection of its own
  (`run_import` in `src-tauri/src/import/mod.rs`). A cancel, a failure or a
  crash leaves none of it. The app keeps reading the vault as it was, and the
  frontend holds its writes until the import ends
  (`src/lib/storage/import-activity.svelte.ts`).
- Notes are written directly rather than through the normal note-creation path,
  which does two extra database round trips per note.
- The run happens off the UI thread and reports progress as it goes.

After the import finishes the file tree reloads, which reads every note summary
into the frontend. At a million notes that reload, not the import, is the slow
part.

## The Wikipedia performance vault

`pnpm bench:vault` imports a vault built from Simple English Wikipedia into the
browser build and times the import and the file-tree reload. How to run it is in
the [e2e README](../../e2e-tests/README.md).

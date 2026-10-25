# Importer performance

How the importer scales to large vaults, and how to run the big-vault test.
What users see, from the formats to the link matching, is in
[Importing notes](../import.md).

The code lives in [`src-tauri/src/import/`](../../src-tauri/src/import/mod.rs);
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

[`mediawiki-to-markdown`](https://github.com/philipashlock/mediawiki-to-markdown)
turns a MediaWiki XML export into a folder of Markdown files with YAML
frontmatter and relative links between pages. That is the Markdown folder
format, so no extra tooling is needed:

1. Convert the Top-1M export with `mediawiki-to-markdown`.
2. Import the output folder, choosing **Markdown folder**. Links to pages that
   are not in the dump stay as ordinary Markdown links; the unresolved-links
   option only applies to `[[wikilinks]]`.
3. Record the time to finish, peak memory, the size of `mindstream.db`
   afterwards, and the time of the file-tree reload on its own.

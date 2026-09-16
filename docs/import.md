# Importing notes

`Settings → Data & Backup → Import notes` brings an external note collection
into the vault. This page covers what each format maps to, how links survive,
and how to drive the importer for the big-vault performance test.

The code lives in [`src-tauri/src/import/`](../src-tauri/src/import/mod.rs); the
dialog is [`ImportNotesDialog.svelte`](../src/lib/components/ImportNotesDialog.svelte).

## Supported formats

| Format                         | Pick           | Detected by                               |
| ------------------------------ | -------------- | ----------------------------------------- |
| Markdown folder (GFM)          | a folder       | fallback for any folder                   |
| Obsidian vault                 | a folder       | a `.obsidian/` directory                  |
| Joplin RAW export              | a folder       | items ending in a `type_:` metadata block |
| Joplin `.jex`                  | a file         | the `.jex` extension                      |
| Joplin Markdown + Front Matter | a folder       | a `_resources/` directory                 |
| Evernote                       | a `.enex` file | the `.enex` extension                     |

Detection is a suggestion. The dialog shows what it found and lets you pick a
different format, because some folders are legitimately ambiguous: an Obsidian
vault with its `.obsidian` config stripped is a plain Markdown folder, and
importing it as one is fine.

Everything lands in a **new folder** named after the source, inside whichever
folder you choose (the vault root by default). If that name is taken, a number
is appended. Undoing an import means trashing one folder.

### What maps to what

| Source                                                                     | Becomes                                               |
| -------------------------------------------------------------------------- | ----------------------------------------------------- |
| Directory / Joplin notebook                                                | Folder                                                |
| `.md` file / Joplin note / Evernote note                                   | Markdown note                                         |
| Frontmatter `title`, or a leading `# Heading`                              | Note title (file name otherwise)                      |
| Frontmatter `tags`, Obsidian inline `#tags`, Joplin tags, Evernote `<tag>` | Tags                                                  |
| Frontmatter `created` / `modified`, Joplin and Evernote timestamps         | Note timestamps (the file's mtime as a fallback)      |
| Images and other linked files                                              | Attachments (see below)                               |
| Evernote ENML                                                              | Markdown, via [`htmd`](https://crates.io/crates/htmd) |
| Evernote `<en-todo>`                                                       | `- [ ]` / `- [x]`                                     |
| Evernote `<en-crypt>`                                                      | A placeholder saying the content was not imported     |

## Links

Every link between notes in the source becomes a Mindstream note link,
`[text](mindstream://note/<id>)`, the same form the editor writes. Nothing is
left as a literal `[[Title]]` for the editor to guess at later.

The importer works in two phases. The first walks the source without reading
any note bodies and gives every note its final id. The second reads one note at
a time and rewrites its links against that complete list. Because every id
exists before any body is rewritten, notes that link to each other work on the
first pass, with no ordering constraint, and a cycle of any length is not a
special case.

A link target is matched against these, strongest first:

1. The source's own id: Joplin `:/<id>`, an Evernote guid when the export has one.
2. The full path within the source, with or without the extension.
3. The file name alone, with or without the extension (Obsidian's shortest-path
   linking).
4. The note title, ignoring case, and any frontmatter `aliases:`.
5. The title with separators and punctuation flattened, so `Foo_Bar`,
   `foo-bar` and `Foo Bar` match. MediaWiki exports need this.

A stronger match always wins. Two notes called `Index.md` in different folders
both answer to "index", but a link written `Archive/Index.md` still reaches the
one in `Archive`.

### Targets that are not in the source

Obsidian calls these unresolved links; MediaWiki calls them red links. The
dialog offers two options:

- **Leave as plain text** (default). The link text stays, the link goes. A wiki
  dump can reference far more pages than it contains, and creating a note for
  each would bury the real ones.
- **Create an empty note to link to.** Mirrors Obsidian, where clicking an
  unresolved link creates the note. One empty note per distinct target, however
  many notes point at it.

Markdown links to files that do not exist are left exactly as written, since
they may still point somewhere real outside the vault.

## Attachments

Linked images and files inside the source are stored as assets and the note
body is pointed at them. Two options in the dialog control this: attachments can
be switched off entirely, and there is a per-file size limit (25 MB by default).
Files over the limit are counted in the result and their links left as they
were.

Attachments are stored by content. If the same bytes turn up again, whether in
the same import or already in the vault, the existing copy is reused and the
note gets a reference to it. A vault that repeats a logo in two hundred notes
stores it once.

Reuse never crosses a shared-folder boundary. An attachment in a shared folder
is synced to everyone the folder is shared with, so reusing a private copy
there would hand it to them.

## Running a large import

The importer is built for vaults with around a million notes:

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

### The Wikipedia performance vault

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

## Known limitations

See [known-limitations.md](known-limitations.md#import) for the full list. In
short:

- Most Evernote exports do not include note guids, so links between Evernote
  notes are matched by the link text, which Evernote sets to the target's
  title. Two notes with the same title can be confused.
- Obsidian `![[Note]]` embeds become ordinary links. Mindstream cannot display
  one note inside another.
- Obsidian Canvas and Excalidraw files are not imported as drawings.
- Duplicate attachments that were already in the vault before content-based
  storage was added are not merged.

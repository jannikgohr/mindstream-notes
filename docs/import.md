# Importing notes

**Settings → Data & Backup → Import notes** brings an external note collection
into the vault. This page covers what each format maps to and how links
survive.

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

Every note gets its place in the vault before any link is rewritten, so notes
that link to each other all work, however the links run.

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

The importer handles vaults of around a million notes. It works in the
background and shows its progress, and you can keep using the app meanwhile.
Stopping an import keeps every note it has already written.

When the import finishes, the file tree reloads. At a million notes that
reload, not the import, is the slow part.

## Known limitations

See [Known limitations](known-limitations.md#import) for the full list. In
short:

- Most Evernote exports do not include note guids, so links between Evernote
  notes are matched by the link text, which Evernote sets to the target's
  title. Two notes with the same title can be confused.
- Obsidian `![[Note]]` embeds become ordinary links. Mindstream cannot display
  one note inside another.
- Obsidian Canvas and Excalidraw files are not imported as drawing canvases.
- Duplicate attachments that were already in the vault before content-based
  storage was added are not merged.

# Demo notes

The example notes setup adds to a new vault when someone picks "A short welcome
note". The build picks up every file here; nothing else needs registering.

## Layout

```text
demo-notes/
  <slug>/
    en.md
    de.md
```

- `<slug>`: lowercase letters, digits and `-`. Notes are added in slug order, and
  the first one opens when setup finishes.
- `<lang>`: an app language. Every note needs `en.md`, which a language without
  its own file falls back to. The tests ask for a file in every app language.
- Each file starts with front matter holding only the title:

```markdown
---
title: Welcome to Mindstream
---

# Welcome to Mindstream
```

## Rules

- **Plain Markdown only**: headings, paragraphs, emphasis, links, lists,
  quotes, code and tables. No images, math or HTML. An app version that doesn't
  know a node deletes it, and that deletion syncs.
- **No user-specific content.** The text is the same for everyone, so it can't
  show someone's shortcuts or name.

## Changing a note

Edit the file. A demo note is named after the document it starts from
(`demo_<slug>_<lang>_<hash>`, see `src-tauri/src/demo_notes.rs`), so changed
text becomes a new note in vaults set up from then on. A note that exists is
never changed, by an app update or anything else. Two devices set up on app
versions with different text each get their own copy; the same text gives the
same note, and sync merges edits to it.

`pnpm test -- src/lib/onboarding/demo-notes.test.ts` checks every file: the
layout, the languages, the allowed nodes, and that opening the note in the
editor changes nothing.

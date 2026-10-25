# Demo notes

The example notes setup adds to a new vault when someone picks "Welcome notes".
The build picks up every file here; nothing else needs registering.

## Layout

```text
src/lib/onboarding/demo-notes/
  <slug>/
    en.md
    de.md
```

- `<slug>`: lowercase letters, digits and `-`. The `welcome` note comes first,
  followed by the others in slug order. The first note opens when setup finishes.
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

## Linking notes

Use `[Link text](demo:<slug>)` to link to another demo note. Setup resolves the
target in the chosen language, with the usual English fallback, then stores a
normal ID-based note link. Renaming the target later leaves the link working.
Only Markdown links are resolved; text inside code stays as written.

Links must lead to an existing note and cannot form a cycle, including a link
back to the same note. A note's ID depends on its rendered content, including
the target IDs of its links. Setup renders linked notes first so every link
points to the exact version created alongside it. The welcome note can link to
all the others, but those notes cannot link back to it.

## Changing a note

Edit the file. A demo note is named after the document it starts from
(`demo_<slug>_<lang>_<hash>`, see `src-tauri/src/demo_notes.rs`), so changed
text becomes a new note in vaults set up from then on. Setup and app updates
never overwrite an existing note or its edits. Two devices set up on app
versions with different text each get their own copy; the same text gives the
same note, and sync merges edits to it. Unedited welcome notes stay local until
they are changed. Welcome notes cannot be shared; create a new note to try
sharing and live collaboration.

`pnpm test -- src/lib/onboarding/demo-notes.test.ts` checks every file: the
layout, the languages, the allowed nodes, and that opening the note in the
editor changes nothing.

# Writing documentation

The pages in [`docs/`](../README.md) are for people who use the app, run a
server or write plugins. Plans, audits, design notes, test procedures and
anything that points into the code go in `docs/internal/`. When a user page
needs a code-level explanation, link from the internal page to the user page,
not the other way round.

## Vocabulary

Use the words the app shows. When the docs and the interface disagree, fix the
one that is wrong, and keep the English and German strings in step.

| Use                                                                                | Instead of                                     |
| ---------------------------------------------------------------------------------- | ---------------------------------------------- |
| vault                                                                              | profile, workspace                             |
| folder, shared folder, **Shared**                                                  | collection, space, scope                       |
| owner, people with access; **Can view**, **Can edit**, **Admin**                   | recipient, roles, read-only, read-write        |
| invite link, signup code                                                           | join link, invite code                         |
| server address, **Server URL**; sync server in the self-hosting docs               | backend, relay, host, Etebase                  |
| editing together live, live editing                                                | live collab, co-editing, rooms                 |
| device                                                                             | client, peer                                   |
| sign in, sign out                                                                  | log in, log out                                |
| two-factor sign-in, authenticator app, backup codes, recovery key                  | 2FA, TOTP                                      |
| version, version history                                                           | snapshot, checkpoint, revision                 |
| backup, restore, merge                                                             | archive                                        |
| Markdown note, drawing canvas, handwritten note, PDF, Kanban board, Typst document | freeform, ink note, note kind, plugin document |
| core plugin, third-party plugin; install, approve, permissions                     | builtin, first-party, shipped, trust, grant    |
| theme preset, mode                                                                 | theme on its own                               |

Some of the words on the right are still right in narrower places:

- "Ink" is what the pen draws, as in **Ink colour**. It is not the name of a
  kind of note.
- The history settings say **Snapshot after a pause**. Quote the label as it
  is, and call what it makes a version.
- The server administration and configuration pages may say collection, chunk,
  blob, revision or client where they describe the server itself. Explain a
  term the first time, in words a user would know: `--max-spaces` limits the
  collections an account owns, one for each vault it syncs and each folder it
  shares.
- The plugin author pages use the manifest's own terms, such as note kind,
  contribution and grant, where they name a field.

## Style

- Name interface elements in bold, exactly as the app shows them, ellipsis
  included: **Install or update from folder…**.
- Write settings paths as **Settings → Category → Section**, with the labels
  the app uses.
- Headings are in sentence case.
- British spelling: colour, licence, favourite, behaviour. Platform terms keep
  their usual spelling, so the window buttons are Minimize and Maximize.
- Say what someone will notice and what to do about it. Leave out file names,
  functions and tables; they belong in the internal page.
- Don't promise what is not built. Mark it as planned, or leave it out.

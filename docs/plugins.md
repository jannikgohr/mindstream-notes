# Plugins

Plugins add features to Mindstream Notes: new kinds of note, export formats,
toolbar buttons, and spelling and grammar checkers. Three come with the app,
and you can install others from a folder. To write your own, see
[Writing plugins](plugin-development.md).

## Core and third-party plugins

**Settings → Plugins** lists every plugin and marks it **Core** or
**Third-party**.

- **Core** plugins ship inside the app and are trusted like the rest of it.
- **Third-party** plugins are the ones you install. They do nothing until you
  approve them, and the app checks that their files have not changed since.

A third-party plugin can never replace a core plugin, even one that uses the
same ID.

## Installing a plugin

Choose **Settings → Plugins → Install or update from folder…** and pick the
folder that holds the plugin's `manifest.json`. The plugin is then installed for
every vault on the device, but each vault decides on its own whether to use it:

1. Read its **Permissions**: what it may do beyond its own files, such as read
   the titles and tags of your notes or run a program on your computer.
2. Choose **Approve in this vault**.
3. From then on, the plugin's switch turns it off and on in this vault.

Until a vault approves it, a plugin adds nothing to that vault and runs no code
there. The buttons beside each plugin open its documentation, its settings and
its hotkeys.

## Updates and signatures

Install a new version the same way, with **Install or update from folder…**.
Each third-party plugin shows whether it is **Signed**, **Unsigned** or has an
**Invalid signature**. A signature shows that a new version comes from the same
author as the one you approved.

A new version keeps its approval only if it is signed by that author and asks
for no new permissions. Anything else, whether an unsigned change, another
author's signature or a new permission, stops the plugin from loading until you
review and approve it again. A notification lists the plugins that are waiting.

The app checks a plugin's files each time it runs the plugin, so files changed
after you approved them are never run under that approval.

## Removing a plugin

**Remove from device** removes a plugin from every vault on the device, and the
confirmation lists those vaults. Its settings and data are kept, and anything it
is already doing finishes first. If you install it again later, every vault has
to approve it again, even when the files are identical.

## The plugins that come with the app

### Templates

Turns your own notes into templates; it brings none of its own. In its settings,
pick a **Template folder**, whose notes become templates, a **Template tag**,
whose notes do too, or both. **New from template** in the file tree's toolbar,
or in the create menu on mobile, then makes a note from one, of the same kind as
the template. The plugin's documentation lists the placeholders, such as
`{{date}}`, that are filled in when you do.

It can read the titles, tags and folders of your notes, and create notes.

### Typst

Adds Typst documents: Typst source with a preview beside it, exported as PDF,
PNG or SVG. The preview and those exports need the `typst` program on your
computer, and the live preview with click-to-source also needs `tinymist`.
Without them, as on Android, a Typst document stays editable as source, and
exporting the source still works. The plugin's documentation says what to
install.

### LanguageTool

Checks grammar and style, and by default spelling too, through a LanguageTool
server: your own, or the hosted service. It checks nothing until you enter the
server's address in its settings. Your note text goes to that server on every
check, so running your own is the private choice. The plugin's documentation
shows how.

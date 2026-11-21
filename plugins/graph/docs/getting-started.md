# Graph

**Open graph view** shows your whole vault as a graph in a tab: notes are dots,
tags are rings, and lines are the links between notes and the tags notes have.
A note that more notes link to, or that links to more, gets a bigger dot.
Notes are coloured by their top-level folder unless the settings say otherwise.
Run it from the command palette, where you can give it a shortcut, or from the
**Local graph** view in the sidebar.

**Local graph** in the sidebar shows the open note and the notes and tags near
it, and follows you as you switch notes. The whole vault is only in the tab.

- Click a note to open it.
- Click a tag to see only the notes near it. **Show the whole vault** in the
  tab, or **Back to the open note** in the sidebar, goes back.
- Drag a note to move it and scroll to zoom. To move the view, drag the
  background, or drag anywhere with the middle or right mouse button. Names appear as you zoom in, the biggest notes first.
- Point at a note to highlight what it's linked with.
- The whole vault grows into place when you open it, oldest note first. The
  play button in the top right corner shows that again, in either graph.

On a phone, the graph button above your notes opens the whole vault. Tap a note
to highlight what it's linked with, then **Open** to open it. Drag with one
finger to move the view and pinch to zoom. To move a note, rest your finger on
it for a moment before dragging. The local graph is not on phones yet.

A link is a link to another note in the note's text, such as one made with
`[[`. Links from notes other than Markdown notes aren't shown.

## Settings

The button in the graph's top right corner opens its settings beside it. They
are the same ones as under **Settings → Plugins**, and both graphs share them.

Filters:

- **Show only notes with**: text to look for in a note's title, folder or
  tags. Empty shows every note.
- **Show tags**: whether tags are drawn, linked to their notes.
- **Show unlinked notes**: whether notes and tags without any links are drawn.
- **Link depth around the open note**: how far the local graph, or the graph
  around a clicked tag, reaches. 1 shows only what is linked directly.

Colours:

- **Colour notes by**: the top-level folder, the first tag in alphabetical
  order, or nothing.
- **Colour links by direction**: around the note you point at, and around the
  open note in the local graph, notes it links to, notes that link to it and
  notes that do both each get their own colour. A legend names them.

Forces, each in percent of the usual:

- **Pull to the centre**: how tightly the graph is drawn together.
- **Push apart**: how hard notes push each other away.
- **Link pull**: how hard a link pulls its two notes together.
- **Link length**: how long a link wants to be.

**Presets** keep a set of these settings under a name. Type a name and press
**Save**, then pick the preset from the list to bring the settings back. Change
a setting while a preset is in use and the list marks it as changed: the save
button beside it writes the changes into the preset, the pencil renames it and
the bin deletes it. **Defaults** in the list and **Reset to defaults** put
every setting back.

## Removing it

Disable this plugin to remove the graph from the sidebar and close its tab.
Your notes and their links stay as they are.

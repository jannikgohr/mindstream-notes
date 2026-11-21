# Graph

**Open graph view** shows your whole vault as a graph in a tab: notes are dots,
tags are rings, and lines are the links between notes and the tags notes have.
A note that more notes link to, or that links to more, gets a bigger dot.
Notes are coloured by their top-level folder unless the settings say otherwise.
Run it from the command palette, where you can give it a shortcut, or from the
**Local graph** view in the sidebar.

**Local graph** in the sidebar shows the open note and the notes and tags near
it, and follows you as you switch notes. **Show the whole vault** there draws
everything instead.

- Click a note to open it.
- Click a tag to see only the notes near it. **Show the whole vault** goes
  back.
- Drag a note to move it, drag the background to move the view, and scroll to
  zoom. Names appear as you zoom in, the biggest notes first.
- Point at a note to highlight what it's linked with.

A link is a link to another note in the note's text, such as one made with
`[[`. Links from notes other than Markdown notes aren't shown.

## Settings

- **Colour notes by**: the top-level folder, the first tag in alphabetical
  order, or nothing.
- **Show tags**: whether tags are drawn, linked to their notes.
- **Show unlinked notes**: whether notes and tags without any links are drawn.
- **Link depth around the open note**: how far the local graph, or the graph
  around a clicked tag, reaches. 1 shows only what is linked directly.

## Removing it

Disable this plugin to remove the graph from the sidebar and close its tab.
Your notes and their links stay as they are.

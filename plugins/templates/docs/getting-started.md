# Templates

Create new notes from templates you author yourself — there are no built-in
templates.

## Choosing template sources

Set either (or both) under **Template sources**:

- **Template folder** — every note inside the chosen folder (at any depth)
  becomes a template.
- **Template tag** — every note carrying the chosen tag becomes a template.

Both are pickers; if the folder or tag is later deleted, the setting clears
itself.

Templates work with any note kind — a markdown note, a kanban board, or a
plugin-owned kind such as a Typst document. This pairs especially well with
Typst: keep a fully styled `.typ` document as your template and stamp out new
ones with the placeholders already filled in.

## Using a template

Open **New from template** (the file-tree toolbar button, or the mobile create
menu) and pick one. A new note is created from the source note's title and body,
and it keeps the **same kind** as the template — pick a Typst document and you
get a Typst document.

## Removing it

Disable this plugin to remove the **New from template** button entirely.

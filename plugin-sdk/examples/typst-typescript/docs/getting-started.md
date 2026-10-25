# Typst

Write and preview [Typst](https://typst.app) documents as notes. A Typst note
keeps its source and a live-rendered preview together, so you can typeset
letters, reports, or math-heavy notes without leaving the app.

This plugin is **off by default** — turn it on under **Settings → Plugins →
Typst**.

## Creating a Typst document

Open the create menu (the file-tree **New** button, or the mobile create menu)
and pick **Typst document**. You start from a small placeholder document you can
edit right away.

Because Typst ships its own note kind, a template of that kind stays a Typst
document when you create from it — pair this with the **Templates** plugin to
stamp out pre-styled documents with `{{title}}`, `{{date}}`, … already filled
in.

## View modes

A Typst note can be shown three ways. Switch with the view-mode toggle in the
editor, or set a default under **Settings → Plugins → Typst → Editor**:

- **Live Preview** — the rendered document only.
- **Source** — the Typst source only.
- **Split** (default) — source and preview side by side.

## Formatting shortcuts

The editor toolbar has shortcuts for common Typst syntax:

- **Heading** inserts `= `
- **Bold** wraps the selection in `*…*`
- **Italic** wraps it in `_…_`
- **Math** wraps it in `$ … $`
- **List** inserts `- `

## Exporting to PDF

With the `typst` binary installed (see **Requirements**), export the note as a
PDF from its export menu — the same compiler that draws the preview produces the
file.

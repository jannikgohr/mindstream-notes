# Main window concept

A self-contained design reference for the Mindstream Notes desktop UI rework.
It runs independently of the app with temporary sample data. Open
`main-window/index.html` directly in a browser, or serve this directory:

```sh
python3 -m http.server 5173 --directory docs/mockups
```

Visit <http://localhost:5173/main-window/>.

The concept keeps the existing three-pane desktop structure and gives it a
consistent visual system: a compact workspace switcher and create button,
shared control sizes, subtle dividers, flat inspector sections, and one accent
for selection and links. The right sidebar has a single Note details header;
the collapsible outline appears inline for Markdown notes.
The writing surface has more space than the navigation and properties.

Try switching themes, collapsing either sidebar, focus mode, the outline,
document tabs, search (`Ctrl/Cmd K`), creating a note (`Ctrl/Cmd N`), favorites,
tags, checklists, and editing the note body or title. The toolbar formats selected
text. Source mode is a read-only preview. The history panel demonstrates where
real version history would appear.

The New note menu includes Markdown, drawing canvas, handwritten note, Kanban
board, and PDF import, matching the app's built-in note types. The tab strip,
tree, search results, and inspector identify each note type consistently.
Non-text editors are visual layout samples; the mockup does not implement the
app's drawing, ink, board, or PDF engines. Choosing a PDF opens the file picker
and uses its filename for a sample preview, without reading the file contents.
Installed plugin note types would extend the same create menu in the app.

All notes and access information are sample data. Edits last only while the
page is open; reloading resets the mockup. It has no app connection, external
dependencies, network requests, or persistent storage.

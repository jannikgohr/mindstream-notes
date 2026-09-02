/**
 * Hit test for the "click past the end of the text to keep writing"
 * gesture in the WYSIWYG pane.
 *
 * The pane is taller than the document, so a click in the empty space
 * below the last block has to be turned into a caret at the end of the
 * doc by hand. That gesture is claimed with `preventDefault()`, which
 * makes a false positive expensive: Crepe renders its floating
 * selection toolbar, block handle and slash menu INSIDE the same pane
 * but OUTSIDE the ProseMirror element, so treating "not in the
 * ProseMirror node" as "below the content" swallowed every toolbar
 * button press and dropped the caret at the end of the note instead.
 *
 * So the gesture is only recognised on the editing surface itself: the
 * ProseMirror node, or one of its ancestors (the padding around the
 * content). A widget is neither — it is a sibling subtree — and falls
 * through to its own click handling.
 */
export function isEditorEndClick(
  proseDom: HTMLElement,
  target: Node | null,
  clientY: number
): boolean {
  if (!target) return false;
  // `contains` is reflexive, so a click on the ProseMirror node itself
  // satisfies the first test.
  const onSurface = proseDom.contains(target) || target.contains(proseDom);
  if (!onSurface) return false;
  const blocks = Array.from(proseDom.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement &&
      child.offsetHeight > 0 &&
      // Remote-cursor widgets are zero-width overlays, not content.
      !child.classList.contains('ProseMirror-yjs-cursor') &&
      !child.classList.contains('ProseMirror-yjs-selection')
  );
  const last = blocks.at(-1);
  // An empty document has nowhere else for the caret to go.
  if (!last) return true;
  return clientY > last.getBoundingClientRect().bottom + 4;
}

# Upstream fixes to contribute

## Milkdown Crepe selection toolbar intercepts upward selection drags

Status: local workaround implemented. Upstream issue and PR still to file.

Affected dependency: `@milkdown/crepe` 7.22.1.

To reproduce, drag a text selection from a lower paragraph toward an earlier
paragraph. Pause briefly with the mouse button held, then move upward through
the toolbar's position. The toolbar can appear over the text during the gesture
and interrupt the selection.

Crepe's `ToolbarView` updates its `TooltipProvider` during selection changes
without checking whether a selection gesture is still active. Its 20 ms throttle
does not prevent the toolbar from appearing between pointer movements.

Upstream implementation:
<https://github.com/Milkdown/milkdown/blob/v7.22.1/packages/crepe/src/feature/toolbar/index.ts>

Proposed fix in Crepe's selection toolbar:

- Hide the toolbar while a primary pointer gesture that started in the editor is
  active, including when a previously shown toolbar exists.
- After release, refresh the provider against the final selection. Keep the
  toolbar from receiving the gesture's release or generated click.
- Preserve direct toolbar clicks and keyboard selection. Handle cancellation,
  window blur, and editor destruction, and remove listeners on destruction.
- Add a browser regression for upward selection with a pause mid-drag and check
  that formatting still works after release.

Local workaround: `src/lib/editor/plugins/prose/selection-toolbar.ts` sets
`data-selection-dragging` on the editor host. The matching rule in `src/app.css`
hides the toolbar and disables pointer events until the frame after release,
even if Milkdown updates `data-show` during the drag. The guard is removed when
the editor is destroyed.

Remove the drag workaround after adopting an upstream release with this behavior
and passing the browser regression. Keep the outside-click dismissal guard
unless upstream also handles that separately.

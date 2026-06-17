<script lang="ts">
  /**
   * Floating bubble shown above a PDF text selection, offering text-aware
   * highlight / comment actions. Styled to match the Milkdown (Crepe)
   * selection toolbar: a rounded surface bubble with icon buttons and a
   * divider (see @milkdown/crepe theme/common/toolbar.css).
   *
   * Positioned via fixed `x`/`y` (client coords, x = selection centre,
   * y = selection top); it offsets itself up and centres horizontally.
   * mousedown is suppressed so clicking a button doesn't collapse the
   * text selection before the action reads it.
   */

  import { Highlighter, MessageSquarePlus } from 'lucide-svelte';
  import { tUi } from '$lib/settings/i18n.svelte';

  interface Props {
    x: number;
    y: number;
    onHighlight: () => void;
    onComment: () => void;
  }
  let { x, y, onHighlight, onComment }: Props = $props();

  // Render at the document body. dockview wraps editor panels in
  // `transform: translate3d(...)` containers, which would otherwise make
  // `position: fixed` resolve against the (clipped, offset) panel instead
  // of the viewport — pushing this bubble off-screen.
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return {
      destroy() {
        node.remove();
      }
    };
  }
</script>

<div
  use:portal
  class="pdf-selection-menu"
  role="toolbar"
  tabindex="-1"
  aria-label={tUi('pdf.selection.label')}
  style="left: {x}px; top: {y}px;"
  onmousedown={(event) => event.preventDefault()}
>
  <button
    type="button"
    class="item"
    aria-label={tUi('pdf.selection.highlight')}
    title={tUi('pdf.selection.highlight')}
    onclick={onHighlight}
  >
    <Highlighter aria-hidden="true" />
  </button>
  <span class="divider" aria-hidden="true"></span>
  <button
    type="button"
    class="item"
    aria-label={tUi('pdf.selection.comment')}
    title={tUi('pdf.selection.comment')}
    onclick={onComment}
  >
    <MessageSquarePlus aria-hidden="true" />
  </button>
</div>

<style>
  /* Mirrors the Crepe selection toolbar: rounded surface bubble, soft
     shadow, 32px icon items, thin divider. Uses the app's theme tokens
     so it adapts to light/dark like the rest of the PDF viewer. */
  .pdf-selection-menu {
    position: fixed;
    z-index: 50;
    display: flex;
    align-items: center;
    overflow: hidden;
    border-radius: 8px;
    background: var(--popover);
    color: var(--popover-foreground);
    box-shadow:
      0px 1px 3px 1px rgb(0 0 0 / 0.15),
      0px 1px 2px 0px rgb(0 0 0 / 0.3);
    transform: translate(-50%, calc(-100% - 8px));
  }

  .item {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    margin: 6px;
    padding: 4px;
    border: 0;
    background: transparent;
    color: var(--muted-foreground);
    border-radius: 4px;
    cursor: pointer;
    transition: background-color 0.12s ease;
  }

  .item:hover {
    background: var(--accent);
    color: var(--accent-foreground);
  }

  .item :global(svg) {
    width: 18px;
    height: 18px;
  }

  .divider {
    width: 1px;
    height: 20px;
    background: color-mix(in srgb, var(--border) 80%, transparent);
  }
</style>

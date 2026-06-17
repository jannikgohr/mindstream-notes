<script lang="ts">
  /**
   * Action popup shown above a selected annotation (Acrobat-style):
   *   - plain highlight: add comment · choose color · delete
   *   - comment / commented highlight: choose color · delete
   *   - ink / signature: delete
   *
   * Styled to match the text-selection bubble (PdfSelectionMenu / the
   * Crepe toolbar). Positioned via fixed `x`/`y` (client coords; x =
   * annotation centre, y = annotation top) and portaled to the body so a
   * transformed/clipped dockview ancestor can't displace it.
   */

  import { MessageSquarePlus, Trash2 } from 'lucide-svelte';
  import { tUi } from '$lib/settings/i18n.svelte';

  interface Props {
    x: number;
    y: number;
    canAddComment: boolean;
    colorable: boolean;
    colors: string[];
    activeColor: string;
    onAddComment: () => void;
    onPickColor: (color: string) => void;
    onDelete: () => void;
  }
  let {
    x,
    y,
    canAddComment,
    colorable,
    colors,
    activeColor,
    onAddComment,
    onPickColor,
    onDelete
  }: Props = $props();

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
  class="pdf-annotation-menu"
  role="toolbar"
  tabindex="-1"
  aria-label={tUi('pdf.annotation.label')}
  style="left: {x}px; top: {y}px;"
  onmousedown={(event) => event.preventDefault()}
>
  {#if canAddComment}
    <button
      type="button"
      class="item"
      aria-label={tUi('pdf.annotation.addComment')}
      title={tUi('pdf.annotation.addComment')}
      onclick={onAddComment}
    >
      <MessageSquarePlus aria-hidden="true" />
    </button>
    {#if colorable}<span class="divider" aria-hidden="true"></span>{/if}
  {/if}

  {#if colorable}
    <div class="swatches" role="group" aria-label={tUi('pdf.toolbar.color')}>
      {#each colors as color (color)}
        <button
          type="button"
          class="swatch"
          style="background-color: {color}; box-shadow: {activeColor === color
            ? '0 0 0 2px var(--ring)'
            : '0 0 0 1px var(--border)'}"
          aria-label={tUi('pdf.toolbar.colorSwatch').replace('{color}', color)}
          aria-pressed={activeColor === color}
          onclick={() => onPickColor(color)}
        ></button>
      {/each}
    </div>
    <span class="divider" aria-hidden="true"></span>
  {/if}

  <button
    type="button"
    class="item item-danger"
    aria-label={tUi('pdf.annotation.delete')}
    title={tUi('pdf.annotation.delete')}
    onclick={onDelete}
  >
    <Trash2 aria-hidden="true" />
  </button>
</div>

<style>
  .pdf-annotation-menu {
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

  .item-danger:hover {
    background: color-mix(in srgb, var(--destructive) 16%, transparent);
    color: var(--destructive);
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

  .swatches {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 8px;
  }

  .swatch {
    width: 18px;
    height: 18px;
    padding: 0;
    border: 0;
    border-radius: 9999px;
    cursor: pointer;
    transition: transform 0.1s ease;
  }

  .swatch:hover {
    transform: scale(1.12);
  }
</style>

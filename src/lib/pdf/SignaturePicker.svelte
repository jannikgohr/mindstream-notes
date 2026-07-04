<script lang="ts">
  /**
   * Popover menu for the signature toolbar button.
   *
   * Each row shows a preview of one saved signature plus a delete
   * button; the footer has an "add new" entry that opens the drawing
   * pad. The picker is positioned relative to its `anchor` element
   * (the toolbar's signature button) using fixed positioning — same
   * pattern the zoom menu uses, so it floats above the page scroller
   * without getting clipped.
   *
   * Lifecycle: the parent owns `open` and toggles it. When open, the
   * picker installs a window-level pointerdown / Escape / resize
   * handler that calls `onClose` on outside-click, Esc, or any layout
   * change that would visibly move the menu.
   */

  import { untrack } from 'svelte';
  import { Camera, Check, Plus, Trash2 } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import { tUi } from '$lib/settings/i18n.svelte';
  import SignatureStrokes from './SignatureStrokes.svelte';
  import type { PdfSignatureSnapshot } from './types';

  interface Props {
    open: boolean;
    anchor: HTMLButtonElement | null;
    signatures: PdfSignatureSnapshot[];
    activeSignatureId: string | null;
    onSelect: (id: string) => void;
    onDelete: (id: string) => void;
    onAddNew: () => void;
    onImport: () => void;
    onClose: () => void;
  }
  let {
    open,
    anchor,
    signatures,
    activeSignatureId,
    onSelect,
    onDelete,
    onAddNew,
    onImport,
    onClose
  }: Props = $props();

  const MENU_WIDTH = 240;

  let menuEl = $state<HTMLDivElement | null>(null);
  // Bumped by the open + resize/scroll listeners to force re-evaluation
  // of the anchor's bounding rect. Without it the derived would only
  // recompute on `open` flipping, which misses scrolling the toolbar.
  let rectVersion = $state(0);

  const anchorRect = $derived.by(() => {
    void rectVersion;
    return open ? (anchor?.getBoundingClientRect() ?? null) : null;
  });
  const menuLeft = $derived.by(() => {
    if (!anchorRect || typeof window === 'undefined') return 0;
    return Math.max(
      8,
      Math.min(anchorRect.left, window.innerWidth - MENU_WIDTH - 8)
    );
  });
  const menuTop = $derived(anchorRect ? anchorRect.bottom : 0);

  $effect(() => {
    if (!open) return;
    // Microtask-defer the listener so the pointerdown that *opened* the
    // picker doesn't immediately close it. The anchor's contains() check
    // covers subsequent clicks on the same button as a toggle.
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (menuEl?.contains(target)) return;
      if (anchor?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onResize = () => {
      rectVersion += 1;
    };
    queueMicrotask(() => window.addEventListener('pointerdown', onPointerDown));
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('scroll', onResize);
    // Trigger an initial recompute on open in case the toolbar shifted
    // between mount and the open toggle (the derived runs once for free,
    // but if a Resize fired while closed we want a fresh measurement).
    // untrack the read: a bare `rectVersion += 1` reads rectVersion inside
    // the effect, making the effect depend on the very value it writes — an
    // infinite update loop that Svelte aborts with effect_update_depth_
    // exceeded, wedging this component's scheduler (the toolbar then stops
    // responding to clicks).
    untrack(() => (rectVersion += 1));

    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('scroll', onResize);
    };
  });
</script>

{#if open && anchorRect && signatures.length > 0}
  <div
    bind:this={menuEl}
    role="menu"
    aria-label={tUi('pdf.signature.menuLabel')}
    class="fixed z-50 rounded-md border border-border bg-popover p-1 text-sm text-popover-foreground shadow-lg"
    style="left: {menuLeft}px; top: {menuTop}px; width: {MENU_WIDTH}px;"
  >
    <div class="flex flex-col gap-0.5">
      {#each signatures as signature (signature.id)}
        <div class="flex items-center gap-1 rounded-sm hover:bg-accent">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={activeSignatureId === signature.id}
            class="flex flex-1 items-center gap-2 rounded-sm px-2 py-1.5 text-left"
            onclick={() => onSelect(signature.id)}
          >
            <Check
              class="size-3.5 shrink-0 {activeSignatureId === signature.id
                ? 'opacity-100'
                : 'opacity-0'}"
              aria-hidden="true"
            />
            <svg
              role="img"
              aria-label={tUi('pdf.signature.preview')}
              class="h-8 flex-1 rounded-sm border border-input bg-white"
              viewBox="0 0 {signature.width} {signature.height}"
              preserveAspectRatio="xMidYMid meet"
            >
              <SignatureStrokes
                strokes={signature.strokes}
                image={signature.image}
                width={signature.width}
                height={signature.height}
              />
            </svg>
          </button>
          <Button
            variant="ghost"
            size="icon"
            class="size-7 shrink-0 text-muted-foreground hover:text-destructive"
            onclick={() => onDelete(signature.id)}
            aria-label={tUi('pdf.signature.delete')}
            title={tUi('pdf.signature.delete')}
          >
            <Trash2 class="size-3.5" aria-hidden="true" />
          </Button>
        </div>
      {/each}
    </div>
    <div class="my-1 border-t border-border"></div>
    <button
      type="button"
      role="menuitem"
      class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground"
      onclick={onAddNew}
    >
      <Plus class="size-3.5 shrink-0" aria-hidden="true" />
      <span>{tUi('pdf.signature.add')}</span>
    </button>
    <button
      type="button"
      role="menuitem"
      class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground"
      onclick={onImport}
    >
      <Camera class="size-3.5 shrink-0" aria-hidden="true" />
      <span>{tUi('pdf.signature.import')}</span>
    </button>
  </div>
{/if}

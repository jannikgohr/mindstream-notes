<script lang="ts">
  /**
   * Lightweight floating context menu. Positioned where the user right-clicked
   * (or near a triggering element). Closes on outside click, escape, or after
   * any item is invoked.
   *
   * Designed to be the only context menu in the app — the global webview
   * default is suppressed in step 3.
   */
  import { onMount } from 'svelte';

  export interface MenuItem {
    label: string;
    /** Optional shortcut hint shown right-aligned. */
    shortcut?: string;
    /** Mark as destructive — gets red styling. */
    destructive?: boolean;
    disabled?: boolean;
    onSelect: () => void;
  }

  interface Props {
    /** Cursor X / Y in client coords (e.g. event.clientX). */
    x: number;
    y: number;
    items: (MenuItem | 'separator')[];
    /**
     * Element that opened the menu. Clicks inside this element are
     * ignored by the click-away handler so the trigger button can
     * implement "tap again to close" — otherwise pointerdown closes
     * the menu and the subsequent click immediately reopens it.
     */
    ignoreEl?: HTMLElement | null;
    onClose: () => void;
  }

  let { x, y, items, ignoreEl, onClose }: Props = $props();
  let menuEl: HTMLDivElement | null = $state(null);

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // pointerdown unifies mouse + touch — some mobile webviews (notably
    // iOS Safari and older Android variants) skip synthesized mousedown
    // events on non-interactive targets, which would otherwise leave
    // the menu stuck open after a tap on empty space.
    const onClickAway = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!menuEl) return;
      if (menuEl.contains(target)) return;
      if (ignoreEl && ignoreEl.contains(target)) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    // Defer one tick so the click that opened us doesn't immediately close us.
    queueMicrotask(() => window.addEventListener('pointerdown', onClickAway));
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onClickAway);
    };
  });

  // Keep the menu inside the viewport.
  let safeX = $derived.by(() => {
    if (typeof window === 'undefined') return x;
    return Math.min(x, window.innerWidth - 220);
  });
  let safeY = $derived.by(() => {
    if (typeof window === 'undefined') return y;
    return Math.min(y, window.innerHeight - items.length * 32 - 16);
  });

  function invoke(item: MenuItem) {
    if (item.disabled) return;
    item.onSelect();
    onClose();
  }
</script>

<div
  bind:this={menuEl}
  role="menu"
  class="fixed z-350 min-w-[200px] rounded-md border border-border bg-popover py-1 text-sm text-popover-foreground shadow-lg"
  style="left: {safeX}px; top: {safeY}px;"
>
  {#each items as item, i (i)}
    {#if item === 'separator'}
      <div class="my-1 h-px bg-border"></div>
    {:else}
      <button
        type="button"
        role="menuitem"
        disabled={item.disabled}
        class="flex w-full items-center justify-between gap-4 px-3 py-1.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50 {item.destructive
          ? 'text-destructive hover:bg-destructive/10 hover:text-destructive'
          : ''}"
        onclick={() => invoke(item)}
      >
        <span>{item.label}</span>
        {#if item.shortcut}
          <span class="text-xs text-muted-foreground">{item.shortcut}</span>
        {/if}
      </button>
    {/if}
  {/each}
</div>

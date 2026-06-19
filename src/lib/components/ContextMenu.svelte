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
  import { ChevronRight } from '@lucide/svelte';
  import type { MenuItem } from './context-menu-types';

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
  let activeSubmenu = $state<number | null>(null);

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
  let submenuOpensLeft = $derived.by(() => {
    if (typeof window === 'undefined') return false;
    return safeX > window.innerWidth - 440;
  });

  function invoke(item: MenuItem) {
    if (item.disabled) return;
    if (item.children?.length) return;
    item.onSelect?.();
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
      <div
        role="none"
        class="relative"
        onpointerenter={() =>
          (activeSubmenu = item.children?.length ? i : null)}
      >
        <button
          type="button"
          role="menuitem"
          aria-haspopup={item.children?.length ? 'menu' : undefined}
          aria-expanded={item.children?.length
            ? activeSubmenu === i
            : undefined}
          disabled={item.disabled}
          class="flex w-full items-center justify-between gap-4 px-3 py-1.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50 {activeSubmenu ===
          i
            ? 'bg-accent text-accent-foreground'
            : ''} {item.destructive
            ? 'text-destructive hover:bg-destructive/10 hover:text-destructive'
            : ''}"
          onclick={() => {
            if (item.children?.length)
              activeSubmenu = activeSubmenu === i ? null : i;
            else invoke(item);
          }}
          onfocus={() => (activeSubmenu = item.children?.length ? i : null)}
        >
          <span class="flex min-w-0 items-center gap-2">
            {#if item.icon}
              {@const Icon = item.icon}
              <Icon class="size-4 shrink-0 text-muted-foreground" />
            {/if}
            <span class="truncate">{item.label}</span>
          </span>
          {#if item.children?.length}
            <ChevronRight
              class="size-4 text-muted-foreground"
              aria-hidden="true"
            />
          {:else if item.shortcut}
            <span class="text-xs text-muted-foreground">{item.shortcut}</span>
          {/if}
        </button>
        {#if item.children?.length && activeSubmenu === i}
          <div
            role="menu"
            class="absolute top-0 z-350 min-w-[200px] rounded-md border border-border bg-popover py-1 text-sm text-popover-foreground shadow-lg {submenuOpensLeft
              ? 'right-full mr-1'
              : 'left-full ml-1'}"
          >
            {#each item.children as child, childIndex (child.id ?? child.label ?? childIndex)}
              <button
                type="button"
                role="menuitem"
                disabled={child.disabled}
                class="flex w-full items-center justify-between gap-4 px-3 py-1.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50 {child.destructive
                  ? 'text-destructive hover:bg-destructive/10 hover:text-destructive'
                  : ''}"
                onclick={() => invoke(child)}
              >
                <span class="flex min-w-0 items-center gap-2">
                  {#if child.icon}
                    {@const ChildIcon = child.icon}
                    <ChildIcon class="size-4 shrink-0 text-muted-foreground" />
                  {/if}
                  <span class="truncate">{child.label}</span>
                </span>
                {#if child.shortcut}
                  <span class="text-xs text-muted-foreground"
                    >{child.shortcut}</span
                  >
                {/if}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  {/each}
</div>

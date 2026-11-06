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
  import { getSettingValue } from '$lib/settings/store.svelte';
  import PluginIcon from '$lib/plugins/PluginIcon.svelte';
  import { noteKindIcon } from './note-kind-icon';
  import { menuItemForShortcut } from './context-menu-shortcuts';
  import {
    isAimingAtSubmenu,
    SUBMENU_AIM_DELAY_MS,
    type AimPoint
  } from './submenu-aim';
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
    /** App-wide menus sit above editors; editor-local menus stay below
     * top-level app popovers and dialogs. */
    layer?: 'app' | 'editor' | 'overlay';
    onClose: () => void;
  }

  let { x, y, items, ignoreEl, layer = 'app', onClose }: Props = $props();
  let menuEl: HTMLDivElement | null = $state(null);
  let activeSubmenu = $state<number | null>(null);
  let submenuEl: HTMLDivElement | null = $state(null);
  // Recent pointer positions; the oldest is the safe triangle's apex.
  let pointerTrail: AimPoint[] = [];
  // A sibling the pointer crossed while aiming at the open submenu. It takes
  // over once the pointer leaves the triangle or rests.
  let pendingSubmenu: { index: number | null } | null = null;
  let aimTimer: ReturnType<typeof setTimeout> | null = null;
  const layerClass = $derived(
    layer === 'editor' ? 'z-[250]' : layer === 'overlay' ? 'z-[450]' : 'z-350'
  );
  const showIcons = $derived(
    getSettingValue('appearance.contextMenuIcons') !== false
  );

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const item = menuItemForShortcut(items, e.key);
      if (!item) return;
      e.preventDefault();
      e.stopPropagation();
      invoke(item);
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
    window.addEventListener('pointermove', onPointerMove);
    // Defer one tick so the click that opened us doesn't immediately close us.
    queueMicrotask(() => window.addEventListener('pointerdown', onClickAway));
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onClickAway);
      window.removeEventListener('pointermove', onPointerMove);
      clearAim();
    };
  });

  function clearAim() {
    if (aimTimer) clearTimeout(aimTimer);
    aimTimer = null;
    pendingSubmenu = null;
  }

  function aimingAtSubmenu(): boolean {
    if (!submenuEl || pointerTrail.length < 2) return false;
    return isAimingAtSubmenu(
      pointerTrail[0],
      pointerTrail[pointerTrail.length - 1],
      submenuEl.getBoundingClientRect(),
      submenuOpensLeft
    );
  }

  function armAim(index: number | null) {
    pendingSubmenu = { index };
    if (aimTimer) clearTimeout(aimTimer);
    aimTimer = setTimeout(commitPendingSubmenu, SUBMENU_AIM_DELAY_MS);
  }

  function commitPendingSubmenu() {
    const pending = pendingSubmenu;
    clearAim();
    if (pending) activeSubmenu = pending.index;
  }

  function recordPointer(event: PointerEvent) {
    const point = { x: event.clientX, y: event.clientY };
    pointerTrail = [...pointerTrail.slice(-3), point];
  }

  function onPointerMove(event: PointerEvent) {
    recordPointer(event);
    if (!pendingSubmenu) return;
    // Made it into the submenu: it stays.
    if (submenuEl?.contains(event.target as Node)) {
      clearAim();
      return;
    }
    // Still reaching for the submenu: keep it open a little longer.
    if (aimingAtSubmenu()) armAim(pendingSubmenu.index);
    else commitPendingSubmenu();
  }

  function hoverItem(event: PointerEvent, index: number, item: MenuItem) {
    // Boundary events fire before the pointermove that caused them.
    recordPointer(event);
    const next = item.children?.length ? index : null;
    if (next === activeSubmenu) {
      clearAim();
      return;
    }
    // A tap jumps straight to its target; only mouse and pen travel across
    // siblings on the way to a submenu.
    if (
      event.pointerType !== 'touch' &&
      activeSubmenu !== null &&
      aimingAtSubmenu()
    ) {
      armAim(next);
      return;
    }
    clearAim();
    activeSubmenu = next;
  }

  // Keep the menu inside the viewport.
  const viewportInset = 8;
  let safeX = $derived.by(() => {
    if (typeof window === 'undefined') return x;
    return Math.max(
      viewportInset,
      Math.min(x, window.innerWidth - 200 - viewportInset)
    );
  });
  let safeY = $derived.by(() => {
    if (typeof window === 'undefined') return y;
    return Math.max(
      viewportInset,
      Math.min(y, window.innerHeight - items.length * 32 - viewportInset)
    );
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
  class="fixed {layerClass} min-w-[200px] rounded-md border border-border bg-popover py-1 text-sm text-popover-foreground shadow-lg"
  style="left: {safeX}px; top: {safeY}px;"
>
  {#each items as item, i (i)}
    {#if item === 'separator'}
      <div class="my-1 h-px bg-border"></div>
    {:else}
      {@const Icon = showIcons ? (item.icon ?? null) : null}
      {@const KindIcon =
        showIcons && item.noteKind ? noteKindIcon(item.noteKind) : null}
      <div
        role="none"
        class="relative"
        onpointerenter={(event) => hoverItem(event, i, item)}
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
            // A parent item always OPENS its submenu — never toggles it shut.
            // pointerenter and focus already set `activeSubmenu = i`, so a
            // toggle here would close the submenu that a preceding focus/hover
            // just opened (the exact ordering is event-timing dependent), which
            // silently loses the click. Closing is owned by pointerenter on a
            // sibling and the outside-click dismiss, so a click that reaches a
            // parent deterministically leaves its submenu open.
            if (item.children?.length) activeSubmenu = i;
            else invoke(item);
          }}
          onfocus={() => {
            clearAim();
            activeSubmenu = item.children?.length ? i : null;
          }}
        >
          <span class="flex min-w-0 items-center gap-2">
            {#if showIcons && item.pluginIcon}
              <PluginIcon
                pluginId={item.pluginIcon.pluginId}
                file={item.pluginIcon.file}
                class="size-4 text-current"
              />
            {:else if KindIcon}
              <KindIcon class="size-4 shrink-0 text-current" />
            {:else if Icon}
              <Icon class="size-4 shrink-0 text-current" />
            {/if}
            <span class="truncate">{item.label}</span>
          </span>
          {#if item.children?.length}
            <ChevronRight class="size-4 text-current" aria-hidden="true" />
          {:else if item.shortcut}
            <span class="text-xs text-current">{item.shortcut}</span>
          {/if}
        </button>
        {#if item.children?.length && activeSubmenu === i}
          <div
            bind:this={submenuEl}
            role="menu"
            class="absolute -top-1 {layerClass} min-w-[200px] rounded-md border border-border bg-popover py-1 text-sm text-popover-foreground shadow-lg {submenuOpensLeft
              ? 'right-full mr-1'
              : 'left-full ml-1'}"
          >
            {#each item.children as child, childIndex (child.id ?? child.label ?? childIndex)}
              {@const ChildIcon = showIcons ? (child.icon ?? null) : null}
              {@const ChildKindIcon =
                showIcons && child.noteKind
                  ? noteKindIcon(child.noteKind)
                  : null}
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
                  {#if showIcons && child.pluginIcon}
                    <PluginIcon
                      pluginId={child.pluginIcon.pluginId}
                      file={child.pluginIcon.file}
                      class="size-4 text-current"
                    />
                  {:else if ChildKindIcon}
                    <ChildKindIcon class="size-4 shrink-0 text-current" />
                  {:else if ChildIcon}
                    <ChildIcon class="size-4 shrink-0 text-current" />
                  {/if}
                  <span class="truncate">{child.label}</span>
                </span>
                {#if child.shortcut}
                  <span class="text-xs text-current">{child.shortcut}</span>
                {/if}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  {/each}
</div>

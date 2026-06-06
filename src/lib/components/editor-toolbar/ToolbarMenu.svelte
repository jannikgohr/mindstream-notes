<script lang="ts">
  /**
   * Popover menu anchored to a trigger element. Used both for group dropdowns
   * (Text, List, Advanced) and for the overflow "More" button. Positioning is
   * fixed-coords relative to the trigger's bounding rect; placement="top"
   * uses a CSS translateY(-100%) trick so we don't need to measure the menu.
   *
   * Click-away handling mirrors ContextMenu.svelte: pointerdown on `window`
   * outside the menu OR the ignored trigger closes it. The trigger element
   * is `ignoreEl` so a second tap on the same trigger collapses the menu
   * instead of immediately re-opening it.
   */

  import { onMount } from 'svelte';
  import type { ComponentType } from 'svelte';
  import { Portal } from 'bits-ui';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { displayBinding, getBinding } from '$lib/hotkeys';

  export interface MenuItem {
    kind: 'item';
    id: string;
    labelKey: string;
    icon: ComponentType;
    onSelect: () => void;
    /**
     * Optional hotkey command id (from `$lib/hotkeys`). When set, the
     * row renders the user's current binding right-aligned next to the
     * label, mirroring native menu conventions ("Bold ⌘B"). Omitted on
     * items with no keyboard equivalent.
     */
    hotkeyId?: string;
  }
  export interface MenuSection {
    kind: 'section';
    id: string;
    labelKey: string;
  }
  export type MenuEntry = MenuItem | MenuSection;

  interface Props {
    trigger: HTMLElement;
    placement: 'top' | 'bottom';
    entries: MenuEntry[];
    onClose: () => void;
  }

  let { trigger, placement, entries, onClose }: Props = $props();

  let menuEl: HTMLDivElement | null = $state(null);
  // Re-measure trigger on viewport resize so the menu stays glued to it when
  // visualViewport shrinks (mobile keyboard) or window is resized.
  let rectVersion = $state(0);

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onClickAway = (e: PointerEvent) => {
      const target = e.target as Node;
      if (menuEl?.contains(target)) return;
      if (trigger.contains(target)) return;
      onClose();
    };
    const onResize = () => {
      rectVersion += 1;
    };

    window.addEventListener('keydown', onKey);
    // Defer one tick so the click that opened us doesn't immediately close us.
    queueMicrotask(() => window.addEventListener('pointerdown', onClickAway));
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('scroll', onResize);

    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onClickAway);
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('scroll', onResize);
    };
  });

  const rect = $derived.by(() => {
    void rectVersion; // dep
    return trigger.getBoundingClientRect();
  });

  const left = $derived.by(() => {
    if (typeof window === 'undefined') return rect.left;
    const minWidth = 200;
    // Right-align if the menu would overflow the right edge.
    const wouldOverflow = rect.left + minWidth > window.innerWidth - 8;
    if (wouldOverflow) return Math.max(8, window.innerWidth - minWidth - 8);
    return rect.left;
  });
  // For placement='top', anchor the top edge to rect.top and use translateY(-100%)
  // in CSS so we don't need to know the menu's own height.
  // Glue the menu's edge directly to the trigger's edge — no visual gap.
  // The original 4px buffer made the dropdown feel detached on desktop,
  // especially when the status row sat between the toolbar and the
  // dropdown's natural position.
  const top = $derived(placement === 'bottom' ? rect.bottom : rect.top);
  const translate = $derived(
    placement === 'bottom' ? 'none' : 'translateY(-100%)'
  );

  function invoke(item: MenuItem) {
    item.onSelect();
    onClose();
  }

  function holdFocus(e: Event) {
    e.preventDefault();
  }

  /**
   * Per-row shortcut display string. `getBinding` reads the reactive
   * `hotkeys.bindings` map, so the menu re-renders automatically if a
   * binding changes while the menu is open — without depending on the
   * whole settings.values surface.
   */
  function shortcutFor(entry: MenuItem): string {
    if (!entry.hotkeyId) return '';
    return displayBinding(getBinding(entry.hotkeyId));
  }
</script>

<!--
  Portal to <body> so the menu can never be clipped by an ancestor with
  overflow:hidden, nor pinned beneath a sibling by a parent stacking
  context. Combined with `position: fixed` + a high z-index this
  guarantees the menu overlaps whatever is below the toolbar (the SAVED
  / EDITING status row, on desktop).
-->
<Portal to="body">
  <div
    bind:this={menuEl}
    role="menu"
    class="fixed z-50 min-w-[200px] max-w-[260px] rounded-md border border-border bg-popover py-1 text-sm text-popover-foreground shadow-lg"
    style="left: {left}px; top: {top}px; transform: {translate};"
  >
    {#each entries as entry (entry.id)}
      {#if entry.kind === 'section'}
        <div
          class="px-3 pt-1.5 pb-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
          role="presentation"
        >
          {tUi(entry.labelKey)}
        </div>
      {:else}
        {@const Icon = entry.icon}
        {@const shortcut = shortcutFor(entry)}
        <button
          type="button"
          role="menuitem"
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground"
          onpointerdown={holdFocus}
          onclick={() => invoke(entry)}
        >
          <Icon class="size-4 shrink-0" aria-hidden="true" />
          <span class="flex-1 truncate">{tUi(entry.labelKey)}</span>
          {#if shortcut}
            <span
              class="ml-3 shrink-0 font-mono text-[11px] text-muted-foreground"
            >
              {shortcut}
            </span>
          {/if}
        </button>
      {/if}
    {/each}
  </div>
</Portal>

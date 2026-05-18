<script lang="ts">
  /**
   * Icons-only toolbar surface shared by desktop and mobile. Renders only
   * the buttons row plus its menus — chrome (border, rounded card, shadow)
   * is the caller's job so the same component drops into a top-anchored
   * desktop bar and a centered mobile floating pill without forking.
   *
   * Overflow strategy:
   *   - A hidden "measurer" container holds an *exact replica* of every
   *     button — same shadcn Button, same classes, same icons — so
   *     offsetWidth reads match the visible bar to the pixel. We never
   *     measure the visible bar itself, which keeps collapsing items from
   *     feeding back into the cutoff calculation.
   *   - A ResizeObserver on the visible container drives `visibleCount`.
   *     Anything past the cutoff is swept into a "More" popover, which
   *     uses section headers to keep groups visually intact.
   *
   * `menuPlacement` decides whether group dropdowns open below the triggers
   * (desktop, toolbar at top) or above (mobile, toolbar at bottom).
   */

  import { onMount } from 'svelte';
  import type { Crepe } from '@milkdown/crepe';
  import { ChevronDown, MoreHorizontal } from 'lucide-svelte';
  import { Button } from '$lib/components/ui/button';
  import { cn } from '$lib/utils';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { TOOLBAR_ITEMS, type ToolbarItem, type ToolbarLeaf, type ToolbarGroup } from './commands';
  import ToolbarMenu, { type MenuEntry } from './ToolbarMenu.svelte';

  interface Props {
    crepe: Crepe | null;
    menuPlacement?: 'top' | 'bottom';
    /** Extra classes merged onto the outer bar (e.g. the desktop variant
     *  adds `border-b border-border bg-background`). */
    class?: string;
  }
  let { crepe, menuPlacement = 'bottom', class: className = '' }: Props = $props();

  let visibleEl: HTMLDivElement | null = $state(null);
  let measureEl: HTMLDivElement | null = $state(null);
  let itemWidths = $state<number[]>([]);
  let containerWidth = $state(0);
  let moreButtonWidth = $state(40);

  let openGroupId = $state<string | null>(null);
  let moreOpen = $state(false);
  let openTriggerEl = $state<HTMLElement | null>(null);

  /** Pointer down on toolbar buttons must NOT yank focus away from the
   * editor — otherwise the soft keyboard collapses between every tap and
   * the desktop selection vanishes on click. */
  function holdFocus(e: Event) {
    e.preventDefault();
  }

  function invokeLeaf(item: ToolbarLeaf) {
    if (!crepe) return;
    crepe.editor.action(item.action);
  }

  function toggleGroup(item: ToolbarGroup, btn: HTMLElement | null) {
    if (!btn) return;
    if (openGroupId === item.id) {
      closeMenus();
      return;
    }
    moreOpen = false;
    openGroupId = item.id;
    openTriggerEl = btn;
  }
  function toggleMore(btn: HTMLElement | null) {
    if (!btn) return;
    if (moreOpen) {
      closeMenus();
      return;
    }
    openGroupId = null;
    moreOpen = true;
    openTriggerEl = btn;
  }
  function closeMenus() {
    openGroupId = null;
    moreOpen = false;
    openTriggerEl = null;
  }

  function readWidths() {
    if (!measureEl) return;
    const buttons = measureEl.querySelectorAll<HTMLElement>('[data-toolbar-measure]');
    itemWidths = Array.from(buttons).map((el) => el.offsetWidth);
    const more = measureEl.querySelector<HTMLElement>('[data-toolbar-more-measure]');
    if (more) moreButtonWidth = more.offsetWidth;
  }

  onMount(() => {
    readWidths();
    if (visibleEl) {
      containerWidth = visibleEl.clientWidth;
      const ro = new ResizeObserver((entries) => {
        for (const entry of entries) {
          if (entry.target === visibleEl) {
            containerWidth = entry.contentRect.width;
          }
        }
      });
      ro.observe(visibleEl);
      return () => ro.disconnect();
    }
  });

  $effect(() => {
    void TOOLBAR_ITEMS.length;
    readWidths();
  });

  const visibleCount = $derived.by(() => {
    if (!itemWidths.length || !containerWidth) return TOOLBAR_ITEMS.length;
    const gap = 2; // gap-0.5 = 0.125rem = 2px
    const padding = 8; // px-1 = 0.25rem each side = 8px total
    const totalAllItems =
      itemWidths.reduce((a, b) => a + b, 0) + gap * (itemWidths.length - 1);
    const usable = containerWidth - padding;
    if (totalAllItems <= usable) return TOOLBAR_ITEMS.length;
    const budget = usable - moreButtonWidth - gap;
    let used = 0;
    for (let i = 0; i < itemWidths.length; i++) {
      const next = used + itemWidths[i] + (i > 0 ? gap : 0);
      if (next > budget) return i;
      used = next;
    }
    return itemWidths.length;
  });

  const overflowedItems = $derived(TOOLBAR_ITEMS.slice(visibleCount));
  const showMoreButton = $derived(visibleCount < TOOLBAR_ITEMS.length);

  const openGroup = $derived.by<ToolbarGroup | null>(() => {
    if (!openGroupId) return null;
    const found = TOOLBAR_ITEMS.find((i) => i.id === openGroupId);
    return found?.kind === 'group' ? found : null;
  });

  function groupEntries(group: ToolbarGroup): MenuEntry[] {
    return group.items.map((leaf) => ({
      kind: 'item' as const,
      id: leaf.id,
      labelKey: leaf.labelKey,
      icon: leaf.icon,
      onSelect: () => invokeLeaf(leaf)
    }));
  }

  function moreEntries(items: ToolbarItem[]): MenuEntry[] {
    const out: MenuEntry[] = [];
    for (const item of items) {
      if (item.kind === 'leaf') {
        out.push({
          kind: 'item',
          id: item.id,
          labelKey: item.labelKey,
          icon: item.icon,
          onSelect: () => invokeLeaf(item)
        });
      } else {
        out.push({
          kind: 'section',
          id: `section-${item.id}`,
          labelKey: item.labelKey
        });
        for (const leaf of item.items) {
          out.push({
            kind: 'item',
            id: `${item.id}-${leaf.id}`,
            labelKey: leaf.labelKey,
            icon: leaf.icon,
            onSelect: () => invokeLeaf(leaf)
          });
        }
      }
    }
    return out;
  }

  // Classes for leaf and group buttons. Kept in `const`s so the visible
  // bar and the measurer can't drift apart — same string in both places.
  const LEAF_BTN_CLASS = 'size-9 shrink-0';
  // Wider than a leaf so the icon + chevron + padding actually breathes.
  // Base button styles force `[&_svg]:size-4` on every svg, so chevron is
  // also 16px; total content ≈ 16 + 4 (gap-1) + 16 + 16 (px-2) ≈ 52px.
  const GROUP_BTN_CLASS = 'h-9 shrink-0 gap-1 px-2';
</script>

<div class={cn('relative w-full', className)} role="toolbar" aria-label={tUi('editor.toolbar.label')}>
  <div
    bind:this={visibleEl}
    class="flex items-center gap-0.5 overflow-hidden px-1 py-1"
  >
    {#each TOOLBAR_ITEMS.slice(0, visibleCount) as item (item.id)}
      {#if item.kind === 'leaf'}
        {@const Icon = item.icon}
        <Button
          variant="ghost"
          size="icon"
          class={LEAF_BTN_CLASS}
          disabled={!crepe}
          onpointerdown={holdFocus}
          onclick={() => invokeLeaf(item)}
          title={tUi(item.labelKey)}
          aria-label={tUi(item.labelKey)}
        >
          <Icon aria-hidden="true" />
        </Button>
      {:else}
        {@const Icon = item.icon}
        {@const open = openGroupId === item.id}
        <Button
          variant={open ? 'secondary' : 'ghost'}
          size="sm"
          class={GROUP_BTN_CLASS}
          disabled={!crepe}
          onpointerdown={holdFocus}
          onclick={(e) => toggleGroup(item, e.currentTarget as HTMLElement)}
          aria-expanded={open}
          aria-haspopup="menu"
          title={tUi(item.labelKey)}
          aria-label={tUi(item.labelKey)}
        >
          <Icon aria-hidden="true" />
          <ChevronDown
            class="opacity-60 transition-transform {open ? 'rotate-180' : ''}"
            aria-hidden="true"
          />
        </Button>
      {/if}
    {/each}

    {#if showMoreButton}
      <Button
        variant={moreOpen ? 'secondary' : 'ghost'}
        size="icon"
        class={LEAF_BTN_CLASS}
        disabled={!crepe}
        onpointerdown={holdFocus}
        onclick={(e) => toggleMore(e.currentTarget as HTMLElement)}
        aria-expanded={moreOpen}
        aria-haspopup="menu"
        title={tUi('editor.toolbar.more')}
        aria-label={tUi('editor.toolbar.more')}
      >
        <MoreHorizontal aria-hidden="true" />
      </Button>
    {/if}
  </div>

  <!--
    Hidden measurer. Renders the *same* shadcn Button + classes the visible
    bar uses so offsetWidth matches what would render if everything fit.
    `invisible` keeps layout intact (offsetWidth still works); we tuck it
    off-screen left and clip the row at 0 height so it never paints
    anything visible even if a parent forgets overflow-hidden.
  -->
  <div
    bind:this={measureEl}
    aria-hidden="true"
    class="pointer-events-none invisible absolute -left-[9999px] top-0 flex h-0 items-center gap-0.5 overflow-hidden"
  >
    {#each TOOLBAR_ITEMS as item (item.id)}
      {#if item.kind === 'leaf'}
        {@const Icon = item.icon}
        <Button
          variant="ghost"
          size="icon"
          class={LEAF_BTN_CLASS}
          tabindex={-1}
          data-toolbar-measure
        >
          <Icon aria-hidden="true" />
        </Button>
      {:else}
        {@const Icon = item.icon}
        <Button
          variant="ghost"
          size="sm"
          class={GROUP_BTN_CLASS}
          tabindex={-1}
          data-toolbar-measure
        >
          <Icon aria-hidden="true" />
          <ChevronDown aria-hidden="true" />
        </Button>
      {/if}
    {/each}
    <Button
      variant="ghost"
      size="icon"
      class={LEAF_BTN_CLASS}
      tabindex={-1}
      data-toolbar-more-measure
    >
      <MoreHorizontal aria-hidden="true" />
    </Button>
  </div>

  {#if openGroup && openTriggerEl}
    <ToolbarMenu
      trigger={openTriggerEl}
      placement={menuPlacement}
      entries={groupEntries(openGroup)}
      onClose={closeMenus}
    />
  {:else if moreOpen && openTriggerEl}
    <ToolbarMenu
      trigger={openTriggerEl}
      placement={menuPlacement}
      entries={moreEntries(overflowedItems)}
      onClose={closeMenus}
    />
  {/if}
</div>

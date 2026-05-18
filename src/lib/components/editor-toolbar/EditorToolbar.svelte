<script lang="ts">
  /**
   * Icons-only toolbar surface shared by desktop and mobile. The actual
   * positioning (top of the editor on desktop, fixed-above-keyboard on mobile)
   * is the caller's job — this component only renders the bar itself plus its
   * group-dropdowns and the "More" overflow menu.
   *
   * Overflow strategy:
   *   - A hidden, absolutely-positioned "measurer" container holds every
   *     button at full size at all times. We read offsetWidth from those
   *     ghost buttons so collapsing the visible bar never breaks our own
   *     measurements (the classic feedback-loop trap with this pattern).
   *   - A ResizeObserver on the visible container drives `visibleCount`.
   *     Items past the cutoff get swept into a "More" popover, which uses
   *     section headers to keep groups visually intact.
   *
   * `menuPlacement` decides whether the group dropdowns open below the
   * triggers (desktop, toolbar-at-top) or above (mobile, toolbar-at-bottom).
   */

  import { onMount } from 'svelte';
  import type { Crepe } from '@milkdown/crepe';
  import { ChevronDown, MoreHorizontal } from 'lucide-svelte';
  import { Button } from '$lib/components/ui/button';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { TOOLBAR_ITEMS, type ToolbarItem, type ToolbarLeaf, type ToolbarGroup } from './commands';
  import ToolbarMenu, { type MenuEntry } from './ToolbarMenu.svelte';

  interface Props {
    crepe: Crepe | null;
    menuPlacement?: 'top' | 'bottom';
  }
  let { crepe, menuPlacement = 'bottom' }: Props = $props();

  let visibleEl: HTMLDivElement | null = $state(null);
  let measureEl: HTMLDivElement | null = $state(null);
  // Each entry's *measured* outer width in px, including its trailing gap.
  let itemWidths = $state<number[]>([]);
  let containerWidth = $state(0);
  // Slot for the "More" button when it has to appear (kept independent so we
  // can measure it once from the measurer and not from a moving target).
  let moreButtonWidth = $state(48);

  // Which group dropdown is open, if any. Mutually exclusive with `moreOpen`.
  let openGroupId = $state<string | null>(null);
  let moreOpen = $state(false);
  // Track which button element opens the current menu so ToolbarMenu can
  // anchor + the click-away handler can ignore re-taps on the trigger.
  let openTriggerEl = $state<HTMLElement | null>(null);

  /** Pointer down on toolbar buttons must NOT yank focus away from the
   * editor — otherwise the soft keyboard collapses between every tap. */
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

  // -- Measurement --------------------------------------------------------

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

  // Re-read widths if the items array ever changes (it doesn't today, but
  // keeps us honest if someone makes the catalogue conditional later).
  $effect(() => {
    void TOOLBAR_ITEMS.length;
    readWidths();
  });

  /**
   * How many leading items fit in the visible bar. If everything fits, returns
   * `TOOLBAR_ITEMS.length` and no "More" button is shown. Otherwise reserves
   * room for the "More" button at the trailing edge.
   *
   * Conservative when measurements haven't landed yet (assumes "show all") to
   * avoid a flash of "More" on first paint.
   */
  const visibleCount = $derived.by(() => {
    if (!itemWidths.length || !containerWidth) return TOOLBAR_ITEMS.length;
    const gap = 2; // mirrors `gap-0.5` (0.125rem = 2px)
    const totalAllItems = itemWidths.reduce((a, b) => a + b, 0) + gap * (itemWidths.length - 1);
    // Padding (px-1 each side = 8px) eats into the container.
    const usable = containerWidth - 8;
    if (totalAllItems <= usable) return TOOLBAR_ITEMS.length;
    // We need to show "More" — reserve its width + a gap.
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

  // Currently-open group, derived from the open id.
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

  /**
   * Build the "More" menu: leaves appear as direct items; groups appear as a
   * section header followed by their leaves. Flat (no nested popovers) keeps
   * the interaction model simple — the cost is vertical space if multiple
   * groups overflow at once, which is acceptable for a rare edge case.
   */
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
</script>

<div class="relative w-full" role="toolbar" aria-label={tUi('editor.toolbar.label')}>
  <div
    bind:this={visibleEl}
    class="flex items-center gap-0.5 overflow-hidden border-b border-border bg-background px-1 py-1"
  >
    {#each TOOLBAR_ITEMS.slice(0, visibleCount) as item (item.id)}
      {#if item.kind === 'leaf'}
        {@const Icon = item.icon}
        <Button
          variant="ghost"
          size="icon"
          class="size-9 shrink-0"
          disabled={!crepe}
          onpointerdown={holdFocus}
          onclick={() => invokeLeaf(item)}
          title={tUi(item.labelKey)}
          aria-label={tUi(item.labelKey)}
        >
          <Icon class="size-4" aria-hidden="true" />
        </Button>
      {:else}
        {@const Icon = item.icon}
        {@const open = openGroupId === item.id}
        <Button
          variant={open ? 'secondary' : 'ghost'}
          size="icon"
          class="size-9 shrink-0"
          disabled={!crepe}
          onpointerdown={holdFocus}
          onclick={(e) => toggleGroup(item, e.currentTarget as HTMLElement)}
          aria-expanded={open}
          aria-haspopup="menu"
          title={tUi(item.labelKey)}
          aria-label={tUi(item.labelKey)}
        >
          <Icon class="size-4" aria-hidden="true" />
          <ChevronDown
            class="size-2.5 -ml-0.5 opacity-60 transition-transform {open ? 'rotate-180' : ''}"
            aria-hidden="true"
          />
        </Button>
      {/if}
    {/each}

    {#if showMoreButton}
      <Button
        variant={moreOpen ? 'secondary' : 'ghost'}
        size="icon"
        class="size-9 shrink-0"
        disabled={!crepe}
        onpointerdown={holdFocus}
        onclick={(e) => toggleMore(e.currentTarget as HTMLElement)}
        aria-expanded={moreOpen}
        aria-haspopup="menu"
        title={tUi('editor.toolbar.more')}
        aria-label={tUi('editor.toolbar.more')}
      >
        <MoreHorizontal class="size-4" aria-hidden="true" />
      </Button>
    {/if}
  </div>

  <!--
    Hidden measurer. Always renders every button at its natural width — we
    poll offsetWidth from here, never from the visible bar, so collapsing
    the bar can't feed back into our cutoff calculation.
  -->
  <div
    bind:this={measureEl}
    aria-hidden="true"
    class="pointer-events-none invisible absolute left-0 top-0 flex h-0 items-center gap-0.5 overflow-hidden"
  >
    {#each TOOLBAR_ITEMS as item (item.id)}
      <div data-toolbar-measure class="inline-flex size-9 items-center justify-center px-2">
        <span class="size-4"></span>
        {#if item.kind === 'group'}
          <span class="size-2.5"></span>
        {/if}
      </div>
    {/each}
    <div data-toolbar-more-measure class="inline-flex size-9 items-center justify-center px-2">
      <span class="size-4"></span>
    </div>
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

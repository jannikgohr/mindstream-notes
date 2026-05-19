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
  import { listenerCtx } from '@milkdown/kit/plugin/listener';
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
     *  adds `border-b border-border bg-background`; the mobile variant
     *  adds the rounded-full pill chrome). */
    class?: string;
    /**
     * When true, the toolbar sizes to its natural content width (capped at
     * 100% of parent) via an inline `width` style computed from the
     * measurer. Required when the parent uses shrink-to-fit (e.g. a
     * centered floating pill on mobile) — without it the pill collapses
     * to a single button width because of the classic
     * shrink-to-fit + w-full child circular-sizing trap, and the overflow
     * logic then enters a feedback loop with itself.
     *
     * Desktop leaves this off and relies on `align-items: stretch` from
     * its flex column parent to provide a stable width.
     */
    fitContent?: boolean;
    /**
     * Drop the visible bar's vertical padding so total height matches the
     * button height (36px) instead of button + 2·py-1 (44px). Desktop sets
     * this so the toolbar lines up with the rest of the 36px UI controls.
     * Mobile leaves it off so the floating pill keeps a little breathing
     * room around the buttons.
     */
    dense?: boolean;
  }
  let {
    crepe,
    menuPlacement = 'bottom',
    class: className = '',
    fitContent = false,
    dense = false
  }: Props = $props();

  let visibleEl: HTMLDivElement | null = $state(null);
  let measureEl: HTMLDivElement | null = $state(null);
  let itemWidths = $state<number[]>([]);
  /** Content-box width of the visible bar (excludes its px-1 padding) —
   *  i.e. the actual horizontal space available for buttons + gaps.
   *  Kept consistent with `ResizeObserver.contentRect.width`, which is
   *  also content-box; previously we mixed `clientWidth` (padding-box)
   *  at init with `contentRect.width` afterwards and that 8px discrepancy
   *  was enough to push the last button into "More" when everything
   *  should have fit. */
  let containerWidth = $state(0);
  let moreButtonWidth = $state(40);
  /** Horizontal chrome the caller wrapped around the toolbar — border +
   *  padding on the outer element. Read from computed style at mount so
   *  we don't hard-code "mobile pill has 1px border" into this component.
   *  Without accounting for this, the last button gets pushed into "More"
   *  by exactly the border width even when content would fit. */
  let outerChromeX = $state(0);

  /** Total horizontal padding of the visible bar (Tailwind `px-1` ⇒
   *  0.25rem each side ⇒ 8px). Used only to translate `clientWidth` into
   *  content-box width at init time. */
  const VISIBLE_BAR_PADDING_X = 8;

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
    // Recompute manually as well as via the listener. Mark toggles on an
    // empty selection only mutate `state.storedMarks` — doc and selection
    // are unchanged — so neither selectionUpdated nor updated would fire,
    // and the button visual would stay one click behind without this.
    recomputeActive();
  }

  /**
   * Active-state map keyed by item id. Bold/Italic populate this so their
   * icons render in the "toggled" (secondary) variant whenever the mark is
   * either present in the selection or queued in storedMarks for the next
   * typed character. Items without an `isActive` predicate stay absent
   * from the map and render in their normal state.
   */
  let activeMap = $state<Record<string, boolean>>({});

  function recomputeActive() {
    if (!crepe) return;
    crepe.editor.action((ctx) => {
      const next: Record<string, boolean> = {};
      for (const item of TOOLBAR_ITEMS) {
        if (item.kind === 'leaf' && item.isActive) {
          try {
            next[item.id] = item.isActive(ctx);
          } catch {
            // Predicates may throw if the editor is mid-teardown; treat
            // an error as "inactive" rather than crashing the toolbar.
            next[item.id] = false;
          }
        }
      }
      activeMap = next;
    });
  }

  // Subscribe to editor lifecycle so the active state refreshes on every
  // selection move and doc change (cursor navigation, typing, remote
  // collab edits). The `cancelled` flag per-effect-run lets us neutralise
  // stale handlers if `crepe` ever swaps; the listener plugin offers no
  // unregister API, so we leave the handler in place and let it no-op.
  $effect(() => {
    if (!crepe) return;
    let cancelled = false;
    crepe.editor.action((ctx) => {
      if (cancelled) return;
      const manager = ctx.get(listenerCtx);
      const onChange = () => {
        if (!cancelled) recomputeActive();
      };
      manager.selectionUpdated(onChange);
      manager.updated(onChange);
    });
    recomputeActive();
    return () => {
      cancelled = true;
    };
  });

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

  function readOuterChrome() {
    const outer = visibleEl?.parentElement;
    if (!outer) return;
    const cs = getComputedStyle(outer);
    outerChromeX =
      parseFloat(cs.borderLeftWidth || '0') +
      parseFloat(cs.borderRightWidth || '0') +
      parseFloat(cs.paddingLeft || '0') +
      parseFloat(cs.paddingRight || '0');
  }

  onMount(() => {
    readWidths();
    readOuterChrome();
    if (visibleEl) {
      // clientWidth is padding-box; subtract padding to match the
      // content-box value the ResizeObserver will report below.
      containerWidth = visibleEl.clientWidth - VISIBLE_BAR_PADDING_X;
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
    const totalAllItems =
      itemWidths.reduce((a, b) => a + b, 0) + gap * (itemWidths.length - 1);
    // containerWidth is already content-box (see VISIBLE_BAR_PADDING_X
    // comment above). Don't subtract padding again — that double-subtract
    // was the bug that pushed the last button into "More" prematurely.
    if (totalAllItems <= containerWidth) return TOOLBAR_ITEMS.length;
    const budget = containerWidth - moreButtonWidth - gap;
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

  /**
   * Width the toolbar *wants* if everything fit — sum of measured button
   * widths plus gaps and the row's px-1 padding. Calculated from the
   * measurer (which always renders every button), so it does NOT change
   * when visibleCount drops. That stability is what breaks the
   * "fewer buttons → smaller content → smaller pill → fewer buttons …"
   * feedback loop for `fitContent` parents.
   */
  const naturalContentWidth = $derived.by(() => {
    if (!itemWidths.length) return null;
    const gap = 2;
    const padding = 8;
    const sum = itemWidths.reduce((a, b) => a + b, 0);
    return sum + gap * Math.max(0, itemWidths.length - 1) + padding;
  });

  /**
   * Inline width style applied only in fitContent mode. We set the OUTER
   * width to `naturalContentWidth + outerChromeX` so that after the
   * caller's chrome (border/padding) consumes its share, the inner
   * visible bar's content-box is exactly `naturalContentWidth − padding`
   * = sum + gaps — i.e. buttons fit. Without the chrome term the
   * visible bar comes up 2+ px short and overflows by exactly that
   * little, pushing the last button into "More" even with space.
   *
   * Combined with `max-width: 100%`, the browser computes
   * `min(natural+chrome, 100% of parent)`: content-sized when it fits,
   * clamped to parent width when it doesn't.
   */
  const fitStyle = $derived(
    fitContent && naturalContentWidth !== null
      ? `width: ${naturalContentWidth + outerChromeX}px; max-width: 100%;`
      : null
  );

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

<!--
  No `w-full` here on purpose: desktop relies on `align-items: stretch`
  from its flex column parent (the default) to fill width, mobile sets
  an explicit pixel width via `fitStyle` to break the shrink-to-fit
  feedback loop. Adding `w-full` re-introduces that loop on mobile and
  causes the pill to collapse to a single button.
-->
<div
  class={cn('relative', className)}
  style={fitStyle ?? undefined}
  role="toolbar"
  aria-label={tUi('editor.toolbar.label')}
>
  <div
    bind:this={visibleEl}
    class={cn(
      'flex items-center gap-0.5 overflow-hidden px-1',
      dense ? 'py-0' : 'py-1'
    )}
  >
    {#each TOOLBAR_ITEMS.slice(0, visibleCount) as item (item.id)}
      {#if item.kind === 'leaf'}
        {@const Icon = item.icon}
        {@const isActive = activeMap[item.id] === true}
        <Button
          variant={isActive ? 'secondary' : 'ghost'}
          size="icon"
          class={LEAF_BTN_CLASS}
          disabled={!crepe}
          onpointerdown={holdFocus}
          onclick={() => invokeLeaf(item)}
          aria-pressed={item.isActive ? isActive : undefined}
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

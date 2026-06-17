<script lang="ts">
  /**
   * Split-button sort control used by both the mobile toolbar and the
   * desktop file explorer. Two halves:
   *
   *   - Left half: ↑/↓ icon. Click flips the direction.
   *   - Right half: the active strategy's label. Click pops a context
   *     menu of strategies, selecting one writes it back through
   *     `onStrategyChange`.
   *
   * All labels go through `tUi()` — adding a strategy is two edits
   * (`SORT_STRATEGIES` in sort.ts + `sort.strategy.<id>` in every i18n
   * bundle) and the picker picks it up automatically.
   */
  import { ArrowUpDown } from '@lucide/svelte';
  import ContextMenu from '$lib/components/ContextMenu.svelte';
  import type { MenuItem } from '$lib/components/context-menu-types';
  import {
    SORT_STRATEGIES,
    type SortDirection,
    type SortStrategy
  } from '$lib/sort';
  import { tUi } from '$lib/settings/i18n.svelte';

  interface Props {
    strategy: SortStrategy;
    direction: SortDirection;
    onStrategyChange: (s: SortStrategy) => void;
    onDirectionChange: (d: SortDirection) => void;
    /** Tailwind size class for the icons; defaults to `size-3.5`. */
    iconClass?: string;
    /**
     * `outlined` (default) draws the bordered pill used in the mobile
     * toolbar — sits over the note-list background as a self-contained
     * unit. `ghost` strips the border + bg so the control reads like a
     * pair of ghost-icon buttons; used by the desktop file-tree header
     * where it sits next to the new-note / new-folder ghost icons.
     */
    variant?: 'outlined' | 'ghost';
    /**
     * `false` (default) renders at h-8 (32px) — matches the mobile
     * breadcrumb pill. `true` drops to h-7 (28px) for the cramped
     * desktop file-tree header.
     */
    compact?: boolean;
  }
  let {
    strategy,
    direction,
    onStrategyChange,
    onDirectionChange,
    iconClass = 'size-3.5',
    variant = 'outlined',
    compact = false
  }: Props = $props();

  const strategyLabel = $derived.by(() => {
    const opt = SORT_STRATEGIES.find((o) => o.id === strategy);
    return opt ? tUi(opt.labelKey) : strategy;
  });

  // Tooltip describes the *result* of clicking, not the current state —
  // matches the convention used by toggle buttons elsewhere in the app.
  const directionTooltip = $derived(
    direction === 'asc' ? tUi('sort.descending') : tUi('sort.ascending')
  );

  let menuOpen = $state(false);
  let menuX = $state(0);
  let menuY = $state(0);
  let menuTriggerEl = $state<HTMLElement | null>(null);

  function toggleDirection() {
    onDirectionChange(direction === 'asc' ? 'desc' : 'asc');
  }

  function openStrategyMenu(e: MouseEvent) {
    const trigger = e.currentTarget as HTMLElement;
    if (menuOpen && menuTriggerEl === trigger) {
      closeMenu();
      return;
    }
    const r = trigger.getBoundingClientRect();
    menuX = r.left;
    menuY = r.bottom + 4;
    menuTriggerEl = trigger;
    menuOpen = true;
  }

  function closeMenu() {
    menuOpen = false;
    menuTriggerEl = null;
  }

  function strategyMenuItems(): (MenuItem | 'separator')[] {
    return SORT_STRATEGIES.map((opt) => ({
      label: (strategy === opt.id ? '✓  ' : '    ') + tUi(opt.labelKey),
      onSelect: () => onStrategyChange(opt.id as SortStrategy)
    }));
  }
</script>

<div
  class="inline-flex select-none items-stretch overflow-hidden rounded-md text-xs {compact
    ? 'h-7'
    : 'h-8'} {variant === 'outlined'
    ? 'border border-border bg-background'
    : ''}"
  role="group"
  aria-label={tUi('sort.label')}
>
  <button
    type="button"
    class="flex items-center justify-center px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    onclick={toggleDirection}
    aria-label={directionTooltip}
    title={directionTooltip}
  >
    <!--
      Single ArrowUpDown icon — shows both arrows side-by-side. On a
      direction flip we vertically mirror it via -scale-y-100 so the
      "currently leading" arrow swaps between top and bottom. Smoother
      than swapping between two distinct icons.
    -->
    <ArrowUpDown
      class="{iconClass} transition-transform {direction === 'desc'
        ? '-scale-y-100'
        : ''}"
    />
  </button>

  <span class="w-px shrink-0 self-stretch bg-border" aria-hidden="true"></span>

  <button
    type="button"
    class="flex min-w-0 items-center gap-1.5 px-2.5 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    onclick={openStrategyMenu}
    aria-label={tUi('sort.switch')}
    title={tUi('sort.switch')}
  >
    <span class="truncate">{strategyLabel}</span>
  </button>
</div>

{#if menuOpen}
  <ContextMenu
    x={menuX}
    y={menuY}
    items={strategyMenuItems()}
    ignoreEl={menuTriggerEl}
    onClose={closeMenu}
  />
{/if}

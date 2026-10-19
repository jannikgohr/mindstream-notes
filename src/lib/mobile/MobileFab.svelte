<script lang="ts">
  /**
   * The create bar, anchored bottom-right. It uses the desktop file-tree
   * toolbar's action IDs with its own layout: the first bar action is the main button
   * (the default) and the rest of the section are pinned quick buttons beside
   * it, as many as fit in one row; the More section is menu only.
   *
   * The chevron opens everything that can be created as one sortable list:
   * the bar section above a divider, More below. Drag a row by its handle (or
   * move it with the arrow keys): above the divider pins it, below unpins it,
   * and the top row is always the default. While dragging, the drop marker
   * and the dragged row say "Default" when the drop would make it so. A pin
   * button is the tap shortcut between the sections. `extras` (templates) are
   * listed after and never move.
   */
  import { ChevronUp, GripVertical, Pin } from '@lucide/svelte';
  import type { IconComponent } from '$lib/settings/icons';
  import PluginIcon from '$lib/plugins/PluginIcon.svelte';
  import { tUi, tUiFormat } from '$lib/settings/i18n.svelte';
  import { mobileState, toggleFabExpanded, collapseFab } from './state.svelte';

  export interface FabAction {
    id: string;
    label: string;
    icon: IconComponent;
    pluginIcon?: { pluginId: string; file: string };
    onSelect: (anchor: HTMLElement) => void;
  }

  export type FabSection = 'toolbar' | 'more';

  interface Props {
    /** Creatable kinds: the bar section in order, then More. */
    actions: FabAction[];
    /** How many of `actions` are on the bar; the first is the default. */
    barCount: number;
    /** Listed after the kinds; never moved, pinned or default (templates). */
    extras: FabAction[];
    /** Move a kind into a section, before `beforeId` or at its end. */
    onMove: (id: string, section: FabSection, beforeId?: string) => void;
    onTogglePin: (id: string) => void;
  }
  let { actions, barCount, extras, onMove, onTogglePin }: Props = $props();

  /** A quick button (`size-11`) plus the row's `gap-2`, in px. */
  const QUICK_PX = 44 + 8;

  let rowWidth = $state(0);
  let mainWidth = $state(0);

  const primary = $derived(actions[0]);
  const bar = $derived(actions.slice(0, Math.max(1, barCount)));
  const more = $derived(actions.slice(Math.max(1, barCount)));
  // Pinned kinds that do not fit beside the main button stay in the menu.
  const quickActions = $derived(
    bar
      .slice(1)
      .slice(0, Math.max(0, Math.floor((rowWidth - mainWidth) / QUICK_PX)))
  );

  function run(action: FabAction, anchor: HTMLElement) {
    collapseFab();
    action.onSelect(anchor);
  }

  // --- Sorting -------------------------------------------------------------

  interface Drag {
    id: string;
    pointerId: number;
    startY: number;
    y: number;
    grabY: number;
    left: number;
    width: number;
    height: number;
    moved: boolean;
  }

  let drag = $state<Drag | null>(null);
  let drop = $state<{ section: FabSection; index: number } | null>(null);
  let list = $state<HTMLDivElement | null>(null);
  let divider = $state<HTMLDivElement | null>(null);

  const dragged = $derived(
    drag?.moved ? actions.find((action) => action.id === drag!.id) : undefined
  );
  const shownBar = $derived(bar.filter((action) => action.id !== dragged?.id));
  const shownMore = $derived(
    more.filter((action) => action.id !== dragged?.id)
  );
  /** The kind that would be the default if the drag ended now. */
  const previewDefault = $derived.by(() => {
    if (!dragged || !drop) return primary?.id;
    if (drop.section === 'toolbar' && drop.index === 0) return dragged.id;
    return shownBar[0]?.id ?? dragged.id;
  });

  function startDrag(event: PointerEvent, action: FabAction) {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    const rect = (
      handle.closest<HTMLElement>('[data-create-row]') ?? handle
    ).getBoundingClientRect();
    drag = {
      id: action.id,
      pointerId: event.pointerId,
      startY: event.clientY,
      y: event.clientY,
      grabY: event.clientY - rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
      moved: false
    };
    window.addEventListener('pointermove', moveDrag, true);
    window.addEventListener('pointerup', endDrag, true);
    window.addEventListener('pointercancel', cancelDrag, true);
  }

  function moveDrag(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const moved = drag.moved || Math.abs(event.clientY - drag.startY) >= 4;
    drag = { ...drag, y: event.clientY, moved };
    if (!moved) return;
    event.preventDefault();
    drop = dropAt(event.clientY);
  }

  /** Where a drop at `y` lands: above the divider is the bar section. */
  function dropAt(y: number): { section: FabSection; index: number } {
    const rows = Array.from(
      list?.querySelectorAll<HTMLElement>('[data-create-row]') ?? []
    ).filter((row) => row.dataset.createRow !== drag?.id);
    const line = divider?.getBoundingClientRect();
    let section: FabSection =
      line && y > line.top + line.height / 2 ? 'more' : 'toolbar';
    // The bar keeps at least the default.
    if (section === 'more' && shownBar.length === 0) section = 'toolbar';
    const inSection = rows.filter((row) => row.dataset.section === section);
    let index = inSection.length;
    for (let i = 0; i < inSection.length; i += 1) {
      const rect = inSection[i].getBoundingClientRect();
      if (y < rect.top + rect.height / 2) {
        index = i;
        break;
      }
    }
    return { section, index };
  }

  function endDrag(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const done = drag;
    const target = drop;
    cleanupDrag();
    if (!done.moved || !target) return;
    // With the drag cleared the lists hold the dragged row again, so leave it
    // out when picking the row it lands before.
    const rows = (target.section === 'toolbar' ? bar : more).filter(
      (action) => action.id !== done.id
    );
    onMove(done.id, target.section, rows[target.index]?.id);
  }

  function cancelDrag(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    cleanupDrag();
  }

  function cleanupDrag() {
    window.removeEventListener('pointermove', moveDrag, true);
    window.removeEventListener('pointerup', endDrag, true);
    window.removeEventListener('pointercancel', cancelDrag, true);
    drag = null;
    drop = null;
  }

  /** Arrow keys on a handle move the row one place, across the divider too. */
  function keyMove(event: KeyboardEvent, action: FabAction) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const inBar = bar.some((item) => item.id === action.id);
    const rows = inBar ? bar : more;
    const at = rows.findIndex((item) => item.id === action.id);
    if (event.key === 'ArrowUp') {
      if (at > 0)
        onMove(action.id, inBar ? 'toolbar' : 'more', rows[at - 1].id);
      else if (!inBar) onMove(action.id, 'toolbar');
    } else if (at < rows.length - 1) {
      onMove(action.id, inBar ? 'toolbar' : 'more', rows[at + 2]?.id);
    } else if (inBar && bar.length > 1) {
      onMove(action.id, 'more', more[0]?.id);
    }
  }
</script>

{#snippet actionIcon(action: FabAction, className: string)}
  {#if action.pluginIcon}
    <PluginIcon {...action.pluginIcon} class={className} />
  {:else}
    {@const Icon = action.icon}
    <Icon class={className} />
  {/if}
{/snippet}

{#snippet badge()}
  <span class="shrink-0 px-3 text-[11px] font-medium text-accent-brand"
    >{tUi('fab.default')}</span
  >
{/snippet}

{#snippet pinButton(action: FabAction, pinned: boolean)}
  <button
    type="button"
    class="grid size-9 shrink-0 place-items-center rounded-lg hover:bg-accent {pinned
      ? 'text-accent-brand'
      : 'text-muted-foreground'}"
    aria-pressed={pinned}
    aria-label={tUiFormat('fab.pinAction', { action: action.label })}
    title={tUiFormat('fab.pinAction', { action: action.label })}
    onclick={() => onTogglePin(action.id)}
  >
    <Pin class="size-4" fill={pinned ? 'currentColor' : 'none'} />
  </button>
{/snippet}

{#snippet create(action: FabAction)}
  <button
    type="button"
    class="flex min-w-0 flex-1 items-center gap-3 rounded-lg py-2.5 pl-1 pr-3 text-left text-sm hover:bg-accent"
    onclick={(event) => run(action, event.currentTarget)}
  >
    {@render actionIcon(action, 'size-4 shrink-0 text-muted-foreground')}
    <span class="truncate">{action.label}</span>
  </button>
{/snippet}

{#snippet row(action: FabAction, section: FabSection)}
  <div
    class="flex items-center"
    data-create-row={action.id}
    data-section={section}
  >
    <button
      type="button"
      class="grid h-9 w-7 shrink-0 cursor-grab touch-none place-items-center rounded-md text-muted-foreground hover:text-foreground active:cursor-grabbing"
      aria-label={tUiFormat('fab.moveAction', { action: action.label })}
      title={tUiFormat('fab.moveAction', { action: action.label })}
      onpointerdown={(event) => startDrag(event, action)}
      onkeydown={(event) => keyMove(event, action)}
    >
      <GripVertical class="size-4" />
    </button>
    {@render create(action)}
    {#if action.id === previewDefault}
      {@render badge()}
    {:else}
      {@render pinButton(action, section === 'toolbar')}
    {/if}
  </div>
{/snippet}

{#snippet placeholder(becomesDefault: boolean)}
  <div
    class="mx-1 flex h-9 items-center justify-end rounded-lg border border-dashed px-3 text-[11px] font-medium {becomesDefault
      ? 'border-accent-brand bg-accent-brand/10 text-accent-brand'
      : 'border-border-strong'}"
    aria-hidden="true"
  >
    {#if becomesDefault}{tUi('fab.default')}{/if}
  </div>
{/snippet}

{#if mobileState.fabExpanded}
  <!-- Scrim absorbs taps elsewhere so the menu behaves like a popover. -->
  <button
    type="button"
    aria-label={tUi('mobile.closeActionMenu')}
    class="fixed inset-0 z-30 bg-scrim"
    onclick={collapseFab}
  ></button>
{/if}

{#if primary}
  <div class="pointer-events-none absolute inset-0 z-40">
    <!-- Pointer events come back on the interactive children only, so the
         rest of the screen stays tappable. -->
    <div
      class="pointer-events-none absolute inset-x-4 bottom-4 flex flex-col items-end gap-3"
    >
      {#if mobileState.fabExpanded}
        <div
          role="dialog"
          aria-label={tUi('fab.menu')}
          class="pointer-events-auto w-80 max-w-full select-none rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-overlay"
        >
          <div bind:this={list}>
            {#each shownBar as action, index (action.id)}
              {#if drop?.section === 'toolbar' && drop.index === index}
                {@render placeholder(index === 0)}
              {/if}
              {@render row(action, 'toolbar')}
            {/each}
            {#if drop?.section === 'toolbar' && drop.index === shownBar.length}
              {@render placeholder(shownBar.length === 0)}
            {/if}
            <!-- Above this line is the bar; below it, the menu only. While
                 dragging, an empty More still gets room to drop into. -->
            {#if more.length > 0 || dragged}
              <div
                bind:this={divider}
                class="mx-2 my-1 border-t border-border"
              ></div>
            {/if}
            {#if dragged && shownMore.length === 0 && drop?.section !== 'more'}
              <div class="h-9" aria-hidden="true"></div>
            {/if}
            {#each shownMore as action, index (action.id)}
              {#if drop?.section === 'more' && drop.index === index}
                {@render placeholder(false)}
              {/if}
              {@render row(action, 'more')}
            {/each}
            {#if drop?.section === 'more' && drop.index === shownMore.length}
              {@render placeholder(false)}
            {/if}
          </div>
          {#if extras.length > 0}
            <div class="mx-2 my-1 border-t border-border"></div>
            {#each extras as action (action.id)}
              <div class="flex items-center pl-7">{@render create(action)}</div>
            {/each}
          {/if}
        </div>
      {/if}

      <div
        class="flex w-full items-center justify-end gap-2"
        bind:clientWidth={rowWidth}
      >
        {#each quickActions as action (action.id)}
          <button
            type="button"
            class="pointer-events-auto grid size-11 shrink-0 place-items-center rounded-full border border-border bg-surface-3 text-foreground shadow-raised hover:bg-accent"
            aria-label={action.label}
            title={action.label}
            onclick={(event) => run(action, event.currentTarget)}
          >
            {@render actionIcon(action, 'size-5')}
          </button>
        {/each}
        <div
          bind:offsetWidth={mainWidth}
          class="pointer-events-auto flex h-11 min-w-0 shrink-0 items-stretch overflow-hidden rounded-full bg-primary text-primary-foreground shadow-overlay"
        >
          <button
            type="button"
            class="flex min-w-0 items-center gap-2 pl-4 pr-3 text-[13px] font-medium hover:bg-primary-foreground/10"
            onclick={(event) => run(primary, event.currentTarget)}
          >
            {@render actionIcon(primary, 'size-4 shrink-0')}
            <span class="max-w-44 truncate">{primary.label}</span>
          </button>
          <span class="my-3 w-px bg-primary-foreground/25" aria-hidden="true"
          ></span>
          <button
            type="button"
            class="flex w-10 shrink-0 items-center justify-center hover:bg-primary-foreground/10"
            onclick={toggleFabExpanded}
            aria-haspopup="dialog"
            aria-expanded={mobileState.fabExpanded}
            aria-label={tUi(
              mobileState.fabExpanded
                ? 'mobile.closeActionMenu'
                : 'fab.showMenu'
            )}
            title={tUi(
              mobileState.fabExpanded
                ? 'mobile.closeActionMenu'
                : 'fab.showMenu'
            )}
          >
            <ChevronUp
              class="size-4 transition-transform {mobileState.fabExpanded
                ? 'rotate-180'
                : ''}"
            />
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}

{#if drag?.moved && dragged}
  {@const becomesDefault = previewDefault === dragged.id}
  <!-- The row under the finger; it says what the drop will make it. -->
  <div
    class="pointer-events-none fixed z-50 flex items-center rounded-lg border bg-popover text-sm text-popover-foreground shadow-overlay {becomesDefault
      ? 'border-accent-brand'
      : 'border-border'}"
    style:left={`${drag.left}px`}
    style:top={`${drag.y - drag.grabY}px`}
    style:width={`${drag.width}px`}
    style:height={`${drag.height}px`}
    aria-hidden="true"
  >
    <span class="grid w-7 shrink-0 place-items-center text-muted-foreground">
      <GripVertical class="size-4" />
    </span>
    <span class="flex min-w-0 flex-1 items-center gap-3 pl-1">
      {@render actionIcon(dragged, 'size-4 shrink-0 text-muted-foreground')}
      <span class="truncate">{dragged.label}</span>
    </span>
    {#if becomesDefault}
      {@render badge()}
    {:else}
      <span
        class="grid size-9 shrink-0 place-items-center {drop?.section ===
        'toolbar'
          ? 'text-accent-brand'
          : 'text-muted-foreground'}"
      >
        <Pin
          class="size-4"
          fill={drop?.section === 'toolbar' ? 'currentColor' : 'none'}
        />
      </span>
    {/if}
  </div>
{/if}

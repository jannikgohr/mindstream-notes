<script lang="ts">
  import type { InkPage } from './page';
  import type { InkStroke } from './stroke-types';
  import InkPageThumbnail from './InkPageThumbnail.svelte';
  import ContextMenu from '$lib/components/ContextMenu.svelte';
  import {
    ArrowDown,
    ArrowUp,
    GripVertical,
    MoreVertical,
    Plus,
    FileUp,
    Trash2,
    X
  } from '@lucide/svelte';
  import {
    createPdfBackgroundCache,
    preparePdfImport,
    type PreparedPdfImport
  } from './pdf-backgrounds';
  import { onDestroy, onMount } from 'svelte';
  import { parsePageRange } from './pdf-import';
  import { tUi, tUiFormat } from '$lib/settings/i18n.svelte';
  import type { PageImageProgress } from './page-images';
  let {
    pages,
    disabled,
    onBlank,
    onMove,
    onDelete,
    onImport,
    onClose,
    onSelect,
    initialPageId,
    strokesForPage
  }: {
    pages: InkPage[];
    disabled: boolean;
    onBlank: (at: number) => void;
    onMove: (id: string, to: number) => void;
    onDelete: (id: string) => void;
    onImport: (
      source: PreparedPdfImport,
      indices: number[],
      at: number,
      progress?: PageImageProgress
    ) => Promise<void>;
    onClose: () => void;
    onSelect: (id: string) => void;
    initialPageId: string | null;
    strokesForPage: (id: string) => InkStroke[];
  } = $props();
  let selectedId = $state<string | null>(null);
  const selected = $derived(
    Math.max(
      0,
      pages.findIndex((p) => p.id === (selectedId ?? initialPageId))
    )
  );
  let menu = $state<{
    pageId: string;
    x: number;
    y: number;
    trigger: HTMLElement;
  } | null>(null);
  let list: HTMLDivElement;
  let closeButton: HTMLButtonElement;
  let thumbnailRevision = $state(0);
  const thumbnails = createPdfBackgroundCache(
    () => thumbnailRevision++,
    (e) => console.warn('[ink] thumbnail failed', e)
  );
  // Visibility drives the PDF cache directly; the template never reads this map.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const visiblePages = new Map<string, InkPage>();
  function updateVisible(page: InkPage, visible: boolean) {
    if (visible) visiblePages.set(page.id, page);
    else visiblePages.delete(page.id);
    thumbnails.beginFrame();
    for (const p of visiblePages.values())
      thumbnails.get(p, Math.min(216 / p.width, 288 / p.height));
    thumbnails.endFrame();
  }
  function select(id: string) {
    selectedId = id;
    onSelect(id);
  }
  function move(id: string, to: number) {
    onMove(id, to);
    selectedId = id;
  }
  let dragging = $state<string | null>(null);
  let dropIndex = $state<number | null>(null);
  let dragPointer: number | null = null;
  function startDrag(event: PointerEvent, id: string) {
    if (disabled || busy || event.button !== 0) return;
    event.preventDefault();
    dragging = id;
    dragPointer = event.pointerId;
    dropIndex = pages.findIndex((p) => p.id === id);
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }
  function dragMove(event: PointerEvent) {
    if (event.pointerId !== dragPointer || !dragging || !list) return;
    const bounds = list.getBoundingClientRect();
    if (event.clientY < bounds.top + 40) list.scrollTop -= 18;
    else if (event.clientY > bounds.bottom - 40) list.scrollTop += 18;
    const cards = Array.from(
      list.querySelectorAll<HTMLElement>('[data-page-card]')
    );
    let nearest = 0,
      distance = Infinity;
    cards.forEach((card, i) => {
      const rect = card.getBoundingClientRect();
      const d =
        (event.clientX - rect.left - rect.width / 2) ** 2 +
        (event.clientY - rect.top - rect.height / 2) ** 2;
      if (d < distance) {
        distance = d;
        nearest = i;
      }
    });
    dropIndex = nearest;
  }
  function endDrag(event: PointerEvent, cancelled = false) {
    if (event.pointerId !== dragPointer) return;
    if (!cancelled && dragging && dropIndex !== null && !disabled && !busy)
      move(dragging, dropIndex);
    dragging = null;
    dropIndex = null;
    dragPointer = null;
  }
  function moveWithKeyboard(event: KeyboardEvent, id: string, index: number) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const to = index + (event.key === 'ArrowUp' ? -1 : 1);
    if (!disabled && !busy && to >= 0 && to < pages.length) move(id, to);
  }
  function openMenu(event: MouseEvent, id: string) {
    const trigger = event.currentTarget as HTMLElement;
    const rect = trigger.getBoundingClientRect();
    selectedId = id;
    menu = { pageId: id, x: rect.right - 200, y: rect.bottom, trigger };
  }
  const menuItems = $derived.by(() => {
    if (!menu) return [];
    const id = menu.pageId;
    const index = pages.findIndex((p) => p.id === id);
    if (index < 0) return [];
    return [
      {
        label: tUi('ink.pages.up'),
        icon: ArrowUp,
        disabled: disabled || busy || index === 0,
        onSelect: () => move(id, index - 1)
      },
      {
        label: tUi('ink.pages.down'),
        icon: ArrowDown,
        disabled: disabled || busy || index === pages.length - 1,
        onSelect: () => move(id, index + 1)
      },
      {
        label: tUi('ink.pages.blank'),
        icon: Plus,
        disabled: disabled || busy,
        onSelect: () => onBlank(index + 1)
      },
      {
        label: tUi('ink.pages.delete'),
        icon: Trash2,
        destructive: true,
        disabled: disabled || busy || pages.length < 2,
        onSelect: () => {
          onDelete(id);
          selectedId = pages[Math.max(0, index - 1)]?.id ?? null;
        }
      }
    ];
  });
  let source = $state<PreparedPdfImport | null>(null);
  let disposed = false;
  onMount(() => {
    closeButton?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !menu) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  onDestroy(() => {
    disposed = true;
    thumbnails.destroy();
    void source?.destroy().catch(console.warn);
  });
  let sourceCount = $state(0);
  let range = $state('');
  let busy = $state(false);
  let progressText = $state('');
  let error = $state('');
  async function choose(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const next = input.files?.[0];
    if (!next) return;
    busy = true;
    error = '';
    const previous = source;
    source = null;
    try {
      await previous?.destroy();
      const prepared = await preparePdfImport(next);
      if (disposed) {
        await prepared.destroy();
        return;
      }
      source = prepared;
      sourceCount = prepared.pageCount;
      range = `1-${sourceCount}`;
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
      input.value = '';
    }
  }
  async function insert() {
    if (!source) return;
    busy = true;
    error = '';
    try {
      await onImport(
        source,
        parsePageRange(range, sourceCount),
        selected + 1,
        (page, total) => {
          progressText = tUiFormat('ink.pages.rasterizing', { page, total });
        }
      );
      await source.destroy();
      source = null;
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
</script>

<section
  class="absolute inset-y-0 right-0 z-40 flex w-72 max-w-full flex-col border-l border-border bg-background text-foreground shadow-xl"
  aria-label={tUi('ink.pages.title')}
>
  <header
    class="flex shrink-0 items-center justify-between border-b border-border px-4 py-3"
  >
    <h2 class="text-sm font-medium">
      {tUi('ink.pages.title')}
      <span class="ml-1 text-muted-foreground">{pages.length}</span>
    </h2>
    <button
      bind:this={closeButton}
      type="button"
      class="grid size-9 place-items-center rounded-md hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={tUi('ink.pages.close')}
      onclick={onClose}><X class="size-4" aria-hidden="true" /></button
    >
  </header>
  <p class="px-4 pt-3 text-xs text-muted-foreground">
    {tUi('ink.pages.reorderHint')}
  </p>
  <div
    bind:this={list}
    class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3"
  >
    <div
      class="grid grid-cols-2 gap-3"
      role="list"
      aria-label={tUi('ink.pages.title')}
    >
      {#each pages as page, i (page.id)}
        <div
          role="listitem"
          data-page-card={page.id}
          class="relative min-w-0 rounded-lg border-2 p-1 transition-colors {dropIndex ===
            i && dragging !== page.id
            ? 'border-primary bg-primary/10'
            : selected === i
              ? 'border-primary bg-accent/50'
              : 'border-transparent hover:bg-accent/40'} {dragging === page.id
            ? 'opacity-40'
            : ''}"
        >
          <button
            type="button"
            class="flex h-40 w-full items-center justify-center overflow-hidden rounded bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={tUiFormat('ink.pages.goTo', { page: i + 1 })}
            aria-current={selected === i ? 'page' : undefined}
            onclick={() => select(page.id)}
          >
            <InkPageThumbnail
              {page}
              revision={thumbnailRevision}
              getBackground={thumbnails.get}
              {strokesForPage}
              onVisibility={updateVisible}
            />
          </button>
          <div class="mt-1 flex items-center justify-between">
            <button
              type="button"
              class="grid size-8 touch-none select-none place-items-center rounded cursor-grab hover:bg-accent active:cursor-grabbing disabled:opacity-40"
              aria-label={tUiFormat('ink.pages.reorder', { page: i + 1 })}
              disabled={disabled || busy || pages.length < 2}
              onpointerdown={(e) => startDrag(e, page.id)}
              onpointermove={dragMove}
              onpointerup={(e) => endDrag(e)}
              onpointercancel={(e) => endDrag(e, true)}
              onlostpointercapture={(e) => endDrag(e, true)}
              onkeydown={(e) => moveWithKeyboard(e, page.id, i)}
            >
              <GripVertical
                class="size-4 text-muted-foreground"
                aria-hidden="true"
              />
            </button>
            <span class="text-xs tabular-nums text-muted-foreground"
              >{i + 1}</span
            >
            <button
              type="button"
              class="grid size-8 place-items-center rounded hover:bg-accent disabled:opacity-40"
              aria-label={tUiFormat('ink.pages.options', { page: i + 1 })}
              aria-haspopup="menu"
              aria-expanded={menu?.pageId === page.id}
              disabled={busy || disabled}
              onclick={(e) => openMenu(e, page.id)}
              ><MoreVertical class="size-4" aria-hidden="true" /></button
            >
          </div>
          <span class="sr-only">{page.width / 2} × {page.height / 2}</span>
        </div>
      {/each}
    </div>
  </div>
  <footer class="flex shrink-0 flex-col gap-2 border-t border-border p-3">
    <button
      type="button"
      class="flex h-10 items-center justify-center gap-2 rounded-md border border-border text-sm hover:bg-accent disabled:opacity-50"
      disabled={disabled || busy}
      onclick={() => onBlank(selected + 1)}
      ><Plus class="size-4" aria-hidden="true" />{tUi(
        'ink.pages.blank'
      )}</button
    >
    <label
      class="flex h-10 cursor-pointer items-center justify-center gap-2 rounded-md border border-border text-sm hover:bg-accent"
    >
      <FileUp class="size-4" aria-hidden="true" />{tUi('ink.pages.import')}
      <input
        class="sr-only"
        type="file"
        accept="application/pdf,.pdf"
        disabled={disabled || busy}
        onchange={choose}
      />
    </label>
    {#if source}
      <label class="flex flex-col gap-1 text-xs text-muted-foreground"
        >{tUi('ink.pages.range')}
        <input
          class="h-9 min-w-0 rounded border border-input bg-background px-2 text-sm text-foreground"
          bind:value={range}
          placeholder="1, 3-5"
          disabled={busy}
        />
      </label>
      <button
        type="button"
        class="h-10 rounded-md bg-primary px-3 text-sm text-primary-foreground disabled:opacity-50"
        disabled={disabled || busy}
        onclick={insert}>{tUi('ink.pages.insert')}</button
      >
    {/if}
    {#if busy}<p class="text-xs text-muted-foreground" role="status">
        {progressText || tUi('ink.pages.working')}
      </p>{/if}
    {#if error}<p class="text-xs text-destructive" role="alert">{error}</p>{/if}
  </footer>
</section>
{#if menu}
  <ContextMenu
    x={menu.x}
    y={menu.y}
    items={menuItems}
    ignoreEl={menu.trigger}
    layer="editor"
    onClose={() => (menu = null)}
  />
{/if}

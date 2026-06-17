<script lang="ts">
  /**
   * Joplin-style global note search.
   *
   * Mounted once at the root layout; opens via `openSearch()` (top-bar
   * button, hotkey, mobile top-bar). Type → debounced fetch from the Rust
   * `search_notes` command → results list with title + snippet matches
   * highlighted. Arrow keys move the selection, Enter opens, Esc closes.
   *
   * The dialog fires `requestOpenNote(id)` rather than calling any
   * shell-specific open routine — both DesktopLayout and MobileLayout
   * subscribe to that bus, so a single dialog drives both. On mobile the
   * dialog goes edge-to-edge; on desktop it sits centred at the top.
   */
  import { onDestroy, tick } from 'svelte';
  import { Dialog } from 'bits-ui';
  import { Folder, Search as SearchIcon, X } from '@lucide/svelte';
  import {
    searchNotes,
    TRASH_ID,
    type Collection,
    type SearchHit
  } from '$lib/api';
  import { splitByRanges } from '$lib/api/search-matcher';
  import { noteKindIcon } from '$lib/components/note-kind-icon';
  import { requestOpenNote } from '$lib/stores/open-note-intent.svelte';
  import { tree } from '$lib/stores/tree.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { closeSearch, searchDialog } from './store.svelte';

  let query = $state('');
  let debouncedQuery = $state('');
  let hits = $state<SearchHit[]>([]);
  let loading = $state(false);
  let selectedIndex = $state(0);
  let inputEl: HTMLInputElement | null = $state(null);
  let listEl: HTMLDivElement | null = $state(null);

  // 100ms debounce — covers fast typists without piling up Rust calls.
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    const q = query;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debouncedQuery = q;
    }, 100);
  });
  onDestroy(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
  });

  // Sequence-guarded fetch so a slow earlier query can't clobber a faster
  // recent one. The current "in-flight" id is bumped on every $effect run;
  // any resolved promise older than the current id discards its result.
  let inflightSeq = 0;
  $effect(() => {
    const q = debouncedQuery.trim();
    if (!q) {
      hits = [];
      loading = false;
      selectedIndex = 0;
      return;
    }
    inflightSeq += 1;
    const mine = inflightSeq;
    loading = true;
    searchNotes(q)
      .then((result) => {
        if (mine !== inflightSeq) return;
        hits = result;
        selectedIndex = 0;
        loading = false;
      })
      .catch((err) => {
        if (mine !== inflightSeq) return;
        console.error('[search] failed', err);
        hits = [];
        loading = false;
      });
  });

  /**
   * Wipe the previous session's state so the dialog opens clean every
   * time. Called synchronously from `onOpenChange` when bits-ui
   * transitions to open — this is intentional. The earlier
   * `$effect(() => { if (searchDialog.open) … })` form deferred the
   * reset to the next microtask, which races the user's first keystroke:
   * if they type before the microtask drains, `query = ''` wipes the
   * just-typed character. Doing the reset inline with the open
   * transition removes the race entirely.
   */
  function resetState() {
    query = '';
    debouncedQuery = '';
    hits = [];
    selectedIndex = 0;
  }

  /**
   * bits-ui's FocusScope tries to focus the first tabbable descendant
   * on open. The input usually IS that descendant — but to keep the
   * order deterministic across browsers (and to `select()` any
   * prefilled value), we take the open-focus event ourselves and
   * point focus at the input directly. `tick()` guarantees Svelte's
   * render cycle has committed the dialog DOM and resolved
   * `bind:this={inputEl}` before we call `focus()`.
   */
  async function handleOpenAutoFocus(e: Event) {
    e.preventDefault();
    await tick();
    inputEl?.focus();
  }

  function moveSelection(delta: number) {
    if (hits.length === 0) return;
    selectedIndex = (selectedIndex + delta + hits.length) % hits.length;
    scrollSelectedIntoView();
  }

  function scrollSelectedIntoView() {
    if (!listEl) return;
    const el = listEl.querySelector(
      `[data-result-index="${selectedIndex}"]`
    ) as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  }

  function activate(index: number) {
    const hit = hits[index];
    if (!hit) return;
    closeSearch();
    requestOpenNote(hit.note.id);
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSelection(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activate(selectedIndex);
    }
    // Esc is handled by bits-ui Dialog automatically.
  }

  /** Resolve the folder chain (root → leaf) for a note's parent. */
  function folderPath(parentId: string | null): Collection[] {
    if (!parentId) return [];
    const out: Collection[] = [];
    let cur: string | null = parentId;
    const seen = new Set<string>();
    while (cur !== null && !seen.has(cur)) {
      seen.add(cur);
      const col: Collection | undefined = tree.collectionsById[cur];
      if (!col) break;
      out.push(col);
      cur = col.parent_collection_id;
    }
    return out.reverse();
  }

  function pathLabel(parentId: string | null): string {
    const path = folderPath(parentId);
    if (path.length === 0) return '';
    // Hide the trash root from the label — the dialog already filters
    // trashed notes out of the result set on the Rust side, but a
    // restored note whose folder still sits in trash would otherwise
    // show "Trash / …" here.
    return path
      .filter((c) => c.id !== TRASH_ID)
      .map((c) => c.name)
      .join(' / ');
  }
</script>

<Dialog.Root
  bind:open={searchDialog.open}
  onOpenChange={(o: boolean) => {
    if (o) {
      // Sync reset BEFORE the user can type. See `resetState()` above
      // for why this doesn't live in a $effect.
      resetState();
    } else {
      closeSearch();
    }
  }}
>
  <Dialog.Portal>
    <Dialog.Overlay
      class="fixed inset-0 z-350 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
    />
    <Dialog.Content
      onkeydown={onKeydown}
      onOpenAutoFocus={handleOpenAutoFocus}
      class="fixed left-1/2 top-[8vh] z-350 flex h-[min(72vh,640px)] w-[min(720px,94vw)] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-border bg-background text-foreground shadow-xl focus:outline-none"
    >
      <Dialog.Title class="sr-only">{tUi('search.open')}</Dialog.Title>

      <header class="flex items-center gap-2 border-b border-border px-3 py-2">
        <SearchIcon class="size-4 shrink-0 text-muted-foreground" />
        <input
          bind:this={inputEl}
          bind:value={query}
          type="text"
          placeholder={tUi('search.notes.placeholder')}
          aria-label={tUi('search.notes.label')}
          class="h-9 w-full bg-transparent text-sm placeholder:text-muted-foreground focus:outline-none"
        />
        <Dialog.Close
          class="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={tUi('search.close')}
        >
          <X class="size-4" />
        </Dialog.Close>
      </header>

      <div bind:this={listEl} class="min-h-0 flex-1 overflow-y-auto">
        {#if debouncedQuery.trim().length === 0}
          <p class="px-4 py-8 text-center text-sm text-muted-foreground">
            {tUi('search.empty')}
          </p>
        {:else if loading && hits.length === 0}
          <p class="px-4 py-8 text-center text-sm text-muted-foreground">…</p>
        {:else if hits.length === 0}
          <p class="px-4 py-8 text-center text-sm text-muted-foreground">
            {tUi('search.noResults')}
          </p>
        {:else}
          <ul class="flex flex-col py-1">
            {#each hits as hit, i (hit.note.id)}
              {@const isActive = i === selectedIndex}
              {@const path = pathLabel(hit.note.parent_collection_id)}
              {@const Icon = noteKindIcon(hit.note.note_kind)}
              {@const titleParts = splitByRanges(
                hit.note.title,
                hit.note.title.length > 0 ? hit.title_matches : []
              )}
              {@const snippetParts = splitByRanges(
                hit.snippet,
                hit.snippet_matches
              )}
              <li>
                <button
                  type="button"
                  data-result-index={i}
                  onmouseenter={() => (selectedIndex = i)}
                  onclick={() => activate(i)}
                  class="flex w-full flex-col items-start gap-1 border-l-2 px-3 py-2 text-left text-sm transition-colors {isActive
                    ? 'border-primary bg-accent text-accent-foreground'
                    : 'border-transparent text-foreground hover:bg-accent/60'}"
                >
                  <span class="flex w-full items-center gap-2">
                    <Icon class="size-4 shrink-0 text-muted-foreground" />
                    <span class="truncate font-medium">
                      {#each titleParts as part}
                        {#if part.highlight}
                          <mark class="bg-primary/30 text-foreground rounded-sm"
                            >{part.text}</mark
                          >
                        {:else}{part.text}{/if}
                      {/each}
                    </span>
                  </span>
                  {#if hit.snippet}
                    <span
                      class="line-clamp-2 pl-6 text-xs text-muted-foreground"
                    >
                      {#each snippetParts as part}
                        {#if part.highlight}
                          <mark class="bg-primary/30 text-foreground rounded-sm"
                            >{part.text}</mark
                          >
                        {:else}{part.text}{/if}
                      {/each}
                    </span>
                  {/if}
                  {#if path}
                    <span
                      class="flex items-center gap-1 pl-6 text-[11px] text-muted-foreground"
                    >
                      <Folder class="size-3 shrink-0" />
                      <span class="truncate">{path}</span>
                    </span>
                  {/if}
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>

      <footer
        class="hidden shrink-0 items-center justify-end border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground sm:flex"
      >
        {tUi('search.hint')}
      </footer>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

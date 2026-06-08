<script lang="ts">
  /**
   * Tag editor for a single note.
   *
   * Tags are slash-delimited paths ("work/urgent") so a flat string list
   * is enough on the wire while still expressing a hierarchy. The picker
   * builds a collapsible tree from every tag in use across the app and
   * lets the user pick from existing tags or create new ones.
   *
   * Design notes:
   * - The pill renders the full path; one × removes the whole tag. We
   *   never split a "work/urgent" pill into separate chips because each
   *   leaf is its own logical tag and removing the parent shouldn't
   *   silently drop the child.
   * - Synthetic intermediates (paths that don't actually appear as their
   *   own tag, only as a prefix of others) render as headers but aren't
   *   clickable — picking one would create a tag the user never asked for.
   */
  import { onMount, tick } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { ChevronRight, Plus, X } from 'lucide-svelte';
  import {
    addNoteTag,
    allTagsInUse,
    normalizeTagPath,
    removeNoteTag,
    tree
  } from '$lib/stores/tree.svelte';

  interface Props {
    noteId: string;
  }
  let { noteId }: Props = $props();

  const ADD_TAG_HOTKEY_EVENT = 'mindstream:hotkeys:add-tag';

  const note = $derived(tree.notesById[noteId]);
  const noteTags = $derived(note?.tags ?? []);
  // Touch tree.notesById so the suggestion list refreshes when tags change
  // anywhere; recomputing the union is cheap at note-app scale.
  const allTags = $derived(tree.notesById && allTagsInUse());

  // ---- Tree model ----
  interface TagNode {
    segment: string;
    fullPath: string;
    /** True when this exact path appears in `allTags` (vs. a synthesized
     *  intermediate that only exists because some descendant exists). */
    exists: boolean;
    children: TagNode[];
  }

  function buildTree(tags: string[]): TagNode[] {
    const root: TagNode[] = [];
    const lookup = new Map<string, TagNode>();
    for (const tag of tags) {
      const segments = tag.split('/').filter(Boolean);
      if (segments.length === 0) continue;
      let parentList = root;
      let parentPath = '';
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const path = parentPath ? `${parentPath}/${seg}` : seg;
        let node = lookup.get(path);
        if (!node) {
          node = { segment: seg, fullPath: path, exists: false, children: [] };
          lookup.set(path, node);
          parentList.push(node);
        }
        if (i === segments.length - 1) node.exists = true;
        parentList = node.children;
        parentPath = path;
      }
    }
    const sortLevel = (level: TagNode[]) => {
      level.sort((a, b) =>
        a.segment.localeCompare(b.segment, undefined, { sensitivity: 'base' })
      );
      for (const n of level) sortLevel(n.children);
    };
    sortLevel(root);
    return root;
  }

  /** Filter tree to nodes whose path (or any descendant path) matches `q`. */
  function filterTree(nodes: TagNode[], q: string): TagNode[] {
    if (!q) return nodes;
    const needle = q.toLowerCase();
    const out: TagNode[] = [];
    for (const n of nodes) {
      const childMatches = filterTree(n.children, q);
      const selfMatches = n.fullPath.toLowerCase().includes(needle);
      if (selfMatches || childMatches.length > 0) {
        out.push({ ...n, children: childMatches });
      }
    }
    return out;
  }

  // ---- Picker state ----
  let pickerOpen = $state(false);
  let pickerQuery = $state('');
  let pickerEl: HTMLDivElement | null = $state(null);
  let inputEl: HTMLInputElement | null = $state(null);
  // Folder paths the user has explicitly expanded. Defaults to "all collapsed";
  // when there's a search query we ignore this set and expand matches instead.
  let expanded = $state(new SvelteSet<string>());

  const fullTree = $derived(buildTree(allTags));
  const visibleTree = $derived(filterTree(fullTree, pickerQuery));
  const trimmedQuery = $derived(normalizeTagPath(pickerQuery));
  const queryActive = $derived(pickerQuery.trim().length > 0);
  const canCreate = $derived(
    trimmedQuery.length > 0 &&
      !allTags.some((t) => t.toLowerCase() === trimmedQuery.toLowerCase()) &&
      !noteTags.some((t) => t.toLowerCase() === trimmedQuery.toLowerCase())
  );

  function isExpanded(path: string): boolean {
    if (queryActive) return true; // auto-expand while searching
    return expanded.has(path);
  }

  function toggleExpand(path: string) {
    if (queryActive) return; // expansion is forced; toggling is a no-op
    if (expanded.has(path)) expanded.delete(path);
    else expanded.add(path);
  }

  async function openPicker() {
    pickerOpen = true;
    pickerQuery = '';
    await tick();
    inputEl?.focus();
  }

  function closePicker() {
    pickerOpen = false;
    pickerQuery = '';
  }

  async function handleRemove(tag: string) {
    if (!note) return;
    await removeNoteTag(note.id, tag);
  }

  async function handlePick(path: string) {
    if (!note) return;
    if (noteTags.includes(path)) return;
    await addNoteTag(note.id, path);
    closePicker();
  }

  async function handleSubmitInput() {
    if (!note) return;
    if (!trimmedQuery) return;
    // Re-use existing capitalization if a case-insensitive match exists, so
    // we don't fragment the tag space ("Work" vs "work").
    const existing = allTags.find(
      (t) => t.toLowerCase() === trimmedQuery.toLowerCase()
    );
    await addNoteTag(note.id, existing ?? trimmedQuery);
    closePicker();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closePicker();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmitInput();
    }
  }

  // Click-away closes the picker. Defer one tick so the click that opened
  // us (which triggers this handler synchronously) doesn't immediately close.
  $effect(() => {
    if (!pickerOpen) return;
    const onClickAway = (e: MouseEvent) => {
      if (pickerEl && !pickerEl.contains(e.target as Node)) closePicker();
    };
    let attached = false;
    queueMicrotask(() => {
      window.addEventListener('mousedown', onClickAway);
      attached = true;
    });
    return () => {
      if (attached) window.removeEventListener('mousedown', onClickAway);
    };
  });

  // Reset picker if the active note changes underneath us.
  $effect(() => {
    void noteId;
    closePicker();
  });

  onMount(() => {
    const onAddTagHotkey = () => {
      void openPicker();
    };
    window.addEventListener(ADD_TAG_HOTKEY_EVENT, onAddTagHotkey);
    return () => {
      window.removeEventListener(ADD_TAG_HOTKEY_EVENT, onAddTagHotkey);
    };
  });
</script>

<div class="relative">
  <span
    class="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
  >
    Tags
  </span>
  <div class="mt-2 flex flex-wrap items-center gap-1">
    {#each noteTags as tag (tag)}
      <span
        class="inline-flex h-6 items-center gap-1 rounded-full border border-border bg-background pl-2 pr-0.5 text-xs leading-none"
      >
        {@render path(tag)}
        <button
          type="button"
          class="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          aria-label="Remove tag {tag}"
          onclick={() => handleRemove(tag)}
        >
          <X class="h-3 w-3" />
        </button>
      </span>
    {/each}

    <button
      type="button"
      class="inline-flex h-6 w-6 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
      aria-label="Add tag"
      aria-expanded={pickerOpen}
      onclick={() => (pickerOpen ? closePicker() : openPicker())}
    >
      <Plus class="h-3.5 w-3.5" />
    </button>

    {#if pickerOpen}
      <div
        bind:this={pickerEl}
        role="dialog"
        aria-label="Add tag"
        class="absolute left-0 top-full z-50 mt-2 w-full min-w-50 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-lg"
      >
        <div class="border-b border-border p-2">
          <input
            bind:this={inputEl}
            bind:value={pickerQuery}
            type="text"
            placeholder="Search or create tag…"
            class="h-7 w-full rounded-sm border border-input bg-background px-2 text-xs shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onkeydown={handleKeydown}
          />
          <p class="mt-1 text-[10px] text-muted-foreground">
            Use <code class="font-mono">/</code> for nested tags.
          </p>
        </div>
        <div class="max-h-60 overflow-y-auto py-1">
          {#each visibleTree as node (node.fullPath)}
            {@render row(node, 0)}
          {/each}

          {#if canCreate}
            <button
              type="button"
              class="flex w-full items-center gap-1 px-3 py-1 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground"
              onclick={() => handleSubmitInput()}
            >
              <Plus class="h-3 w-3" />
              <span>Create &ldquo;{@render path(trimmedQuery)}&rdquo;</span>
            </button>
          {/if}

          {#if visibleTree.length === 0 && !canCreate}
            <p class="px-3 py-2 text-xs text-muted-foreground">
              {allTags.length === 0
                ? 'No tags yet. Type one and press Enter.'
                : 'No matches.'}
            </p>
          {/if}
        </div>
      </div>
    {/if}
  </div>
  {#if noteTags.length === 0 && !pickerOpen}
    <p class="mt-1 text-xs text-muted-foreground">No tags yet</p>
  {/if}
</div>

{#snippet row(node: TagNode, depth: number)}
  {@const onNote = noteTags.includes(node.fullPath)}
  {@const hasChildren = node.children.length > 0}
  {@const clickable = node.exists && !onNote}
  <div class="flex items-center gap-0.5 text-xs">
    <button
      type="button"
      class="flex h-6 w-5 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground disabled:opacity-0"
      disabled={!hasChildren || queryActive}
      style="margin-left: {depth * 12}px"
      aria-label={isExpanded(node.fullPath) ? 'Collapse' : 'Expand'}
      onclick={() => toggleExpand(node.fullPath)}
    >
      {#if hasChildren}
        <ChevronRight
          class="h-3 w-3 transition-transform {isExpanded(node.fullPath)
            ? 'rotate-90'
            : ''}"
        />
      {/if}
    </button>
    <button
      type="button"
      class="flex h-6 flex-1 items-center truncate rounded-sm px-2 text-left font-mono leading-none transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-current"
      disabled={!clickable}
      title={node.fullPath}
      onclick={() => handlePick(node.fullPath)}
    >
      <span
        class={onNote
          ? 'text-muted-foreground line-through'
          : !node.exists
            ? 'text-muted-foreground'
            : ''}
      >
        {node.segment}
      </span>
      {#if onNote}
        <span
          class="ml-2 text-[10px] uppercase tracking-wide text-muted-foreground"
        >
          on note
        </span>
      {/if}
    </button>
  </div>
  {#if hasChildren && isExpanded(node.fullPath)}
    {#each node.children as child (child.fullPath)}
      {@render row(child, depth + 1)}
    {/each}
  {/if}
{/snippet}

{#snippet path(tag: string)}
  {@const segments = tag.split('/')}
  <span class="font-mono">
    {#each segments as seg, i (i)}
      {#if i > 0}<span class="mx-1 text-muted-foreground/60">/</span>{/if}{seg}
    {/each}
  </span>
{/snippet}

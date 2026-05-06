<script lang="ts">
  import { Separator } from '$lib/components/ui/separator';
  import { ui } from '$lib/state.svelte';
  import {
    addNoteTag,
    allTagsInUse,
    removeNoteTag,
    tree
  } from '$lib/stores/tree.svelte';
  import { tick } from 'svelte';
  import { Plus, X } from 'lucide-svelte';

  // Summary only — bodies live with the editor and would force every tree
  // refresh through a load_note round trip.
  const note = $derived(ui.activeNoteId ? tree.notesById[ui.activeNoteId] : null);

  // ---- Tag picker state ----
  let pickerOpen = $state(false);
  let pickerQuery = $state('');
  let pickerEl: HTMLDivElement | null = $state(null);
  let inputEl: HTMLInputElement | null = $state(null);
  // Touch tree.notesById in a $derived so the suggestion list refreshes when
  // tags change anywhere; recomputing the union is cheap at note-app scale.
  const allTags = $derived(tree.notesById && allTagsInUse());
  const noteTags = $derived(note?.tags ?? []);
  const suggestions = $derived.by(() => {
    const q = pickerQuery.trim().toLowerCase();
    return allTags
      .filter((t) => !noteTags.includes(t))
      .filter((t) => (q ? t.toLowerCase().includes(q) : true));
  });
  const trimmedQuery = $derived(pickerQuery.trim());
  const canCreate = $derived(
    trimmedQuery.length > 0 &&
      !allTags.some((t) => t.toLowerCase() === trimmedQuery.toLowerCase())
  );

  function fmt(iso: string) {
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
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

  async function handlePick(tag: string) {
    if (!note) return;
    await addNoteTag(note.id, tag);
    closePicker();
  }

  async function handleSubmitInput() {
    if (!note) return;
    const value = pickerQuery.trim();
    if (!value) return;
    // If the typed value matches an existing tag (case-insensitive), prefer
    // the existing capitalization so we don't fragment the tag space.
    const existing = allTags.find(
      (t) => t.toLowerCase() === value.toLowerCase()
    );
    await addNoteTag(note.id, existing ?? value);
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

  // Click-away: close the picker when the user clicks outside it.
  $effect(() => {
    if (!pickerOpen) return;
    const onClickAway = (e: MouseEvent) => {
      if (pickerEl && !pickerEl.contains(e.target as Node)) closePicker();
    };
    // Defer so the click that opened us doesn't immediately close us.
    let attached = false;
    const id = queueMicrotask(() => {
      window.addEventListener('mousedown', onClickAway);
      attached = true;
    });
    void id;
    return () => {
      if (attached) window.removeEventListener('mousedown', onClickAway);
    };
  });

  // Reset picker if the active note changes underneath us.
  $effect(() => {
    void ui.activeNoteId;
    closePicker();
  });
</script>

<aside class="flex h-full w-full flex-col bg-card text-sm">
  <div class="px-3 py-2">
    <span class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      Metadata
    </span>
  </div>
  <Separator />

  <div class="flex-1 overflow-y-auto px-3 py-3">
    {#if note}
      <h3 class="truncate text-base font-semibold">{note.title}</h3>
      <p class="mt-0.5 text-xs text-muted-foreground">
        Modified {fmt(note.modified)}
      </p>

      <Separator class="my-3" />

      <dl class="space-y-2 text-xs">
        <div class="flex justify-between">
          <dt class="text-muted-foreground">Created</dt>
          <dd class="tabular-nums">{fmt(note.created)}</dd>
        </div>
        <div class="flex justify-between">
          <dt class="text-muted-foreground">Note id</dt>
          <dd class="font-mono text-[10px]">{note.id}</dd>
        </div>
        <div class="flex justify-between">
          <dt class="text-muted-foreground">Folder</dt>
          <dd class="font-mono text-[10px]">
            {note.parent_collection_id
              ? (tree.collectionsById[note.parent_collection_id]?.name ?? '—')
              : 'Root'}
          </dd>
        </div>
      </dl>

      <Separator class="my-3" />

      <div>
        <span class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Tags
        </span>
        <div class="relative mt-2 flex flex-wrap items-center gap-1">
          {#each noteTags as tag (tag)}
            <span
              class="inline-flex items-center gap-1 rounded-full border border-border bg-background py-0.5 pl-2 pr-1 text-xs"
            >
              <span class="truncate">{tag}</span>
              <button
                type="button"
                class="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
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
              class="absolute left-0 top-full z-50 mt-2 w-full min-w-[180px] overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-lg"
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
              </div>
              <div class="max-h-48 overflow-y-auto py-1">
                {#each suggestions as tag (tag)}
                  <button
                    type="button"
                    class="flex w-full items-center px-3 py-1 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground"
                    onclick={() => handlePick(tag)}
                  >
                    {tag}
                  </button>
                {/each}
                {#if canCreate}
                  <button
                    type="button"
                    class="flex w-full items-center gap-1 px-3 py-1 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground"
                    onclick={() => handleSubmitInput()}
                  >
                    <Plus class="h-3 w-3" />
                    <span>Create &ldquo;{trimmedQuery}&rdquo;</span>
                  </button>
                {/if}
                {#if suggestions.length === 0 && !canCreate}
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
    {:else}
      <p class="text-xs text-muted-foreground">No note selected.</p>
    {/if}
  </div>
</aside>

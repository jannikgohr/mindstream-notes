<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { Crepe } from '@milkdown/crepe';
  import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
  import { Trash2 } from 'lucide-svelte';
  import { loadNote, saveNote as apiSaveNote, TRASH_ID } from '$lib/api';
  import { tree } from '$lib/stores/tree.svelte';

  interface Props {
    noteId: string;
  }
  let { noteId }: Props = $props();

  /**
   * Debounce the auto-save: wait this long after the last keystroke before
   * hitting Rust. The user said "save after inactivity" — 800ms feels
   * unhurried but doesn't risk losing typing in a crash.
   */
  const SAVE_DEBOUNCE_MS = 800;

  let host: HTMLDivElement | null = $state(null);
  let crepe: Crepe | null = null;
  let crepeReady = $state(false);
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let loading = $state(true);
  let savingState = $state<'idle' | 'pending' | 'saving' | 'saved' | 'error'>(
    'idle'
  );
  let loadError = $state<string | null>(null);

  /**
   * Walks the note's ancestor folder chain to see if any of them is the
   * special trash collection. Direct-parent equality isn't enough — when
   * the user trashes a folder via "move to trash", the folder's notes
   * keep their original parent_collection_id (see the Rust test
   * `moving_a_collection_does_not_delete_its_notes`), so a note buried
   * three folders deep inside a trashed folder still needs to lock.
   * Cycle guard is defensive — the backend rejects parent cycles, but
   * a corrupt local cache shouldn't hang the editor.
   */
  function ancestorIsTrash(parentId: string | null): boolean {
    let current = parentId;
    const seen = new Set<string>();
    while (current) {
      if (current === TRASH_ID) return true;
      if (seen.has(current)) return false;
      seen.add(current);
      current = tree.collectionsById[current]?.parent_collection_id ?? null;
    }
    return false;
  }

  // "Trashed" has four shapes the editor needs to recognise:
  //   1. data.useTrash = true (default) — the note is moved into the
  //      special 'trash' collection, but trashed_at stays NULL.
  //   2. The note's *containing folder* (or any ancestor folder) is in
  //      trash. The note's own parent_collection_id doesn't change in
  //      this case — only an ancestor walk catches it.
  //   3. data.useTrash = false — trashed_at is set AND trashNote() in
  //      tree.svelte.ts removes the row from notesById, so the entry
  //      is just gone from the local tree.
  //   4. The note has been purged remotely while the tab is still open —
  //      same "missing from tree" signature as (3). We treat it as
  //      trashed read-only too, which is safer than letting the user
  //      keep typing into a save that'll fail.
  // Gated on tree.ready so we don't flash the banner during the brief
  // window between editor mount and the initial tree hydration.
  const isTrashed = $derived.by(() => {
    if (!tree.ready) return false;
    const n = tree.notesById[noteId];
    if (!n) return true;
    if (n.trashed === true) return true;
    return ancestorIsTrash(n.parent_collection_id);
  });

  onMount(async () => {
    if (!host) return;
    try {
      const note = await loadNote(noteId);
      if (!host) return; // unmounted while awaiting
      crepe = new Crepe({
        root: host,
        defaultValue: note.body
      });
      crepe.editor.use(listener).config((ctx) => {
        ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
          handleChange(markdown);
        });
      });
      await crepe.create();
      crepeReady = true;
      loading = false;
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
      loading = false;
      console.error('[NoteEditor] load failed', err);
    }
  });

  onDestroy(() => {
    if (saveTimer) clearTimeout(saveTimer);
    crepe?.destroy();
    crepe = null;
    crepeReady = false;
  });

  // Push the trashed state into Crepe whenever either side changes.
  // Re-runs when crepeReady flips (handles the initial-state case for a
  // note that was already trashed when the tab opened) and when isTrashed
  // changes (remote pull, or local restore from another window).
  $effect(() => {
    if (!crepeReady || !crepe) return;
    crepe.setReadonly(isTrashed);
  });

  function handleChange(markdown: string) {
    // setReadonly(true) already prevents user input, but the listener can
    // still fire from programmatic mutations or in-flight changes during
    // the read-only flip. Drop those silently rather than persisting an
    // edit to a trashed note.
    if (isTrashed) return;
    savingState = 'pending';
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        savingState = 'saving';
        await apiSaveNote({ id: noteId, body: markdown });
        // Mirror the new modified timestamp in the local cache so the
        // metadata panel reflects the save without a tree refetch.
        const existing = tree.notesById[noteId];
        if (existing) {
          tree.notesById[noteId] = {
            ...existing,
            modified: new Date().toISOString()
          };
        }
        savingState = 'saved';
      } catch (err) {
        savingState = 'error';
        console.error('[NoteEditor] save failed', err);
      }
    }, SAVE_DEBOUNCE_MS);
  }

  const statusLabel = $derived.by(() => {
    if (isTrashed) return 'Read-only';
    switch (savingState) {
      case 'pending':
        return 'Editing…';
      case 'saving':
        return 'Saving…';
      case 'saved':
        return 'Saved';
      case 'error':
        return 'Save failed';
      default:
        return '';
    }
  });
</script>

<div class="flex h-full w-full flex-col">
  <div
    class="pointer-events-none flex h-5 shrink-0 items-center justify-end px-3 text-[10px] uppercase tracking-wider text-muted-foreground"
    aria-live="polite"
  >
    {statusLabel}
  </div>
  {#if isTrashed}
    <div
      class="flex shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive"
      role="status"
    >
      <Trash2 class="size-3.5 shrink-0" aria-hidden="true" />
      <span>
        This note is in the trash and is read-only. Restore it to edit.
      </span>
    </div>
  {/if}
  <div class="themed-scrollbar relative h-full w-full overflow-y-auto">
    {#if loading}
      <p class="px-6 py-4 text-sm text-muted-foreground">Loading note…</p>
    {:else if loadError}
      <p class="px-6 py-4 text-sm text-destructive">
        Couldn't load note: {loadError}
      </p>
    {/if}
    <div bind:this={host} class="mx-auto max-w-3xl"></div>
  </div>
</div>

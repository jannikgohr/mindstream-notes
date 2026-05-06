<script lang="ts">
  import { Separator } from '$lib/components/ui/separator';
  import TagsSection from '$lib/components/TagsSection.svelte';
  import { ui } from '$lib/state.svelte';
  import { tree } from '$lib/stores/tree.svelte';

  // Summary only — bodies live with the editor and would force every tree
  // refresh through a load_note round trip.
  const note = $derived(ui.activeNoteId ? tree.notesById[ui.activeNoteId] : null);

  function fmt(iso: string) {
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }
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

      <TagsSection noteId={note.id} />
    {:else}
      <p class="text-xs text-muted-foreground">No note selected.</p>
    {/if}
  </div>
</aside>

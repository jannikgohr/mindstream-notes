<script lang="ts">
  import { ui, notes } from '$lib/state.svelte';
  import { Separator } from '$lib/components/ui/separator';

  const note = $derived(
    ui.activeNoteId ? notes.byId[ui.activeNoteId] : null
  );

  function fmt(iso: string) {
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }

  const wordCount = $derived(
    note ? (note.body.match(/\b\w+\b/g)?.length ?? 0) : 0
  );
  const charCount = $derived(note?.body.length ?? 0);
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
          <dt class="text-muted-foreground">Words</dt>
          <dd class="tabular-nums">{wordCount}</dd>
        </div>
        <div class="flex justify-between">
          <dt class="text-muted-foreground">Characters</dt>
          <dd class="tabular-nums">{charCount}</dd>
        </div>
        <div class="flex justify-between">
          <dt class="text-muted-foreground">Note id</dt>
          <dd class="font-mono">{note.id}</dd>
        </div>
      </dl>

      <Separator class="my-3" />

      <div>
        <span class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Tags
        </span>
        <div class="mt-2 flex flex-wrap gap-1">
          {#each note.tags as tag (tag)}
            <span
              class="rounded-full border border-border bg-background px-2 py-0.5 text-xs"
            >
              {tag}
            </span>
          {/each}
          {#if note.tags.length === 0}
            <span class="text-xs text-muted-foreground">No tags yet</span>
          {/if}
        </div>
      </div>
    {:else}
      <p class="text-xs text-muted-foreground">No note selected.</p>
    {/if}
  </div>
</aside>

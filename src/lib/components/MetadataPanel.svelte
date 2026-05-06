<script lang="ts">
  import { Separator } from '$lib/components/ui/separator';
  import TagsSection from '$lib/components/TagsSection.svelte';
  import FolderBreadcrumb from '$lib/components/FolderBreadcrumb.svelte';
  import type { Collection, NoteSummary } from '$lib/api';
  import { ui } from '$lib/state.svelte';
  import { tree } from '$lib/stores/tree.svelte';

  // Summary only — bodies live with the editor and would force every tree
  // refresh through a load_note round trip.
  const note = $derived(ui.activeNoteId ? tree.notesById[ui.activeNoteId] : null);

  /**
   * Walk parent_collection_id from leaf to root and return the chain in
   * root → leaf order. Cycle-safe via a visited set in case the tree is
   * ever in a transient inconsistent state mid-move.
   */
  function getFolderPath(n: NoteSummary): Collection[] {
    const path: Collection[] = [];
    const seen = new Set<string>();
    let id: string | null = n.parent_collection_id;
    while (id && !seen.has(id)) {
      seen.add(id);
      const c = tree.collectionsById[id];
      if (!c) break;
      path.unshift(c);
      id = c.parent_collection_id;
    }
    return path;
  }
  const folderPath = $derived(note ? getFolderPath(note) : []);

  function fmt(iso: string) {
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }
</script>

<aside class="flex h-full w-full min-w-0 flex-col bg-card text-sm">
  <div class="px-3 py-2">
    <span
      class="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
    >
      Metadata
    </span>
  </div>
  <Separator />

  <div class="flex-1 overflow-y-auto px-3 py-3">
    {#if note}
      <h3 class="truncate text-base font-semibold">{note.title}</h3>
      <p class="mt-0.5 truncate text-xs text-muted-foreground">
        Modified {fmt(note.modified)}
      </p>

      <Separator class="my-3" />

      <!--
        Two-column grid: the first track is `max-content`, so every label
        column is as wide as the longest label ("Note id") and every value
        starts at the same x. The second track is `minmax(0, 1fr)` so the
        right cell can shrink below its content width and trigger the
        truncation/breadcrumb collapse.
      -->
      <dl
        class="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-2 gap-y-2 text-xs"
      >
        <dt class="whitespace-nowrap text-muted-foreground">Created</dt>
        <dd class="flex min-w-0 justify-end">
          <span class="truncate tabular-nums">{fmt(note.created)}</span>
        </dd>

        <dt class="whitespace-nowrap text-muted-foreground">Note id</dt>
        <dd class="flex min-w-0 justify-end">
          <span class="truncate font-mono text-[10px]">{note.id}</span>
        </dd>

        <dt class="whitespace-nowrap text-muted-foreground">Folder</dt>
        <dd class="min-w-0 font-mono text-[10px]">
          <FolderBreadcrumb path={folderPath} />
        </dd>
      </dl>

      <Separator class="my-3" />

      <TagsSection noteId={note.id} />
    {:else}
      <p class="text-xs text-muted-foreground">No note selected.</p>
    {/if}
  </div>
</aside>

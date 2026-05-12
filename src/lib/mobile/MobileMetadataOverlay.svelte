<script lang="ts">
  /**
   * Mobile metadata popout. Slides over the editor as a full-bleed sheet
   * with a close button at the top-right. Bound to `ui.rightSidebarOpen`
   * so the same toggle that drives the desktop side panel opens this on
   * mobile — keeps the state model uniform across platforms.
   */
  import { X } from 'lucide-svelte';
  import { Button } from '$lib/components/ui/button';
  import { Separator } from '$lib/components/ui/separator';
  import TagsSection from '$lib/components/TagsSection.svelte';
  import FolderBreadcrumb from '$lib/components/FolderBreadcrumb.svelte';
  import type { Collection, NoteSummary } from '$lib/api';
  import { ui, toggleRightSidebar } from '$lib/state.svelte';
  import { tree } from '$lib/stores/tree.svelte';

  const note = $derived(ui.activeNoteId ? tree.notesById[ui.activeNoteId] : null);

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

{#if ui.rightSidebarOpen}
  <!-- Backdrop dims the editor underneath and absorbs taps to close. -->
  <button
    type="button"
    aria-label="Close note info"
    class="fixed inset-0 z-40 bg-black/40"
    onclick={toggleRightSidebar}
  ></button>

  <div
    class="safe-top safe-bottom safe-x fixed inset-0 z-50 flex flex-col bg-card text-sm shadow-xl"
    role="dialog"
    aria-modal="true"
    aria-label="Note information"
  >
    <header class="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
      <span class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Note info
      </span>
      <Button
        variant="ghost"
        size="icon"
        onclick={toggleRightSidebar}
        title="Close"
        aria-label="Close"
      >
        <X class="size-5" />
      </Button>
    </header>

    <div class="flex-1 overflow-y-auto px-3 py-3">
      {#if note}
        <h3 class="truncate text-base font-semibold">{note.title}</h3>
        <p class="mt-0.5 truncate text-xs text-muted-foreground">
          Modified {fmt(note.modified)}
        </p>

        <Separator class="my-3" />

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
  </div>
{/if}

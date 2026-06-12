<script lang="ts">
  import { CalendarPlus, Edit3, Folder, Star, Tag } from 'lucide-svelte';
  import TagsSection from '$lib/components/TagsSection.svelte';
  import type { Collection, NoteSummary } from '$lib/api';
  import { noteKindIcon } from '$lib/components/note-kind-icon';
  import { ui } from '$lib/state.svelte';
  import { setNoteFavourite, tree } from '$lib/stores/tree.svelte';

  // Summary only — bodies live with the editor and would force every tree
  // refresh through a load_note round trip.
  const note = $derived(
    ui.activeNoteId ? tree.notesById[ui.activeNoteId] : null
  );

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
  const folderLabel = $derived(
    folderPath.length > 0 ? folderPath[folderPath.length - 1].name : 'Root'
  );
  const folderTitle = $derived(
    folderPath.length > 0 ? folderPath.map((c) => c.name).join(' / ') : 'Root'
  );

  // TODO: Render author once notes expose ownership/user attribution metadata.
  // TODO: Render saved versions once note version history is modeled.

  function fmt(iso: string) {
    try {
      return new Intl.DateTimeFormat(undefined, {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
      }).format(new Date(iso));
    } catch {
      return iso;
    }
  }

  function noteKindLabel(kind: string | null | undefined): string {
    switch (kind) {
      case 'markdown':
        return 'Markdown note';
      case 'freeform':
        return 'Drawing note';
      case 'ink':
        return 'Ink note';
      case 'pdf':
        return 'PDF note';
      default:
        return kind ? `${kind} note` : 'Unknown note';
    }
  }
</script>

<aside class="flex h-full w-full min-w-0 flex-col bg-card text-sm">
  <div class="flex-1 overflow-y-auto p-3">
    {#if note}
      {@const NoteIcon = noteKindIcon(note.note_kind)}
      <section
        class="rounded-lg border border-border bg-background p-4 text-foreground shadow-sm"
      >
        <div class="flex min-w-0 items-start justify-between gap-3">
          <div class="min-w-0">
            <h3 class="truncate text-base font-semibold leading-6">
              {note.title}
            </h3>
            <p
              class="mt-0.5 truncate font-mono text-[11px] text-muted-foreground"
            >
              {note.id}
            </p>
          </div>
          <button
            type="button"
            class="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onclick={() => void setNoteFavourite(note.id, !note.favourite)}
            aria-pressed={note.favourite}
            aria-label={note.favourite
              ? 'Remove from favourites'
              : 'Add to favourites'}
            title={note.favourite
              ? 'Remove from favourites'
              : 'Add to favourites'}
          >
            <Star
              class="size-4"
              fill={note.favourite ? 'currentColor' : 'none'}
            />
          </button>
        </div>

        <section class="mt-5">
          <h4
            class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
          >
            Organization
          </h4>
          <dl class="border-y border-border">
            <div
              class="flex min-w-0 items-center justify-between gap-3 border-b border-border py-2 last:border-b-0"
            >
              <dt
                class="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
              >
                <Folder class="size-3.5" />
                Folder
              </dt>
              <dd
                class="max-w-[9rem] truncate rounded-full bg-primary/10 px-2 py-0.5 text-right text-[11px] font-medium text-primary"
                title={folderTitle}
              >
                {folderLabel}
              </dd>
            </div>
            <div
              class="flex min-w-0 items-center justify-between gap-3 border-b border-border py-2 last:border-b-0"
            >
              <dt
                class="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
              >
                <Tag class="size-3.5" />
                Type
              </dt>
              <dd
                class="flex min-w-0 items-center justify-end gap-1.5 text-right text-xs font-medium text-muted-foreground"
              >
                <NoteIcon class="size-3.5 shrink-0" />
                <span class="truncate">{noteKindLabel(note.note_kind)}</span>
              </dd>
            </div>
          </dl>
        </section>

        <section class="mt-5">
          <h4
            class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
          >
            History
          </h4>
          <dl class="border-y border-border">
            <div
              class="flex min-w-0 items-center justify-between gap-3 border-b border-border py-2 last:border-b-0"
            >
              <dt
                class="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
              >
                <CalendarPlus class="size-3.5" />
                Created
              </dt>
              <dd
                class="min-w-0 truncate text-right text-xs font-medium tabular-nums"
              >
                {fmt(note.created)}
              </dd>
            </div>
            <div
              class="flex min-w-0 items-center justify-between gap-3 border-b border-border py-2 last:border-b-0"
            >
              <dt
                class="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
              >
                <Edit3 class="size-3.5" />
                Modified
              </dt>
              <dd
                class="min-w-0 truncate text-right text-xs font-medium tabular-nums"
              >
                {fmt(note.modified)}
              </dd>
            </div>
          </dl>
        </section>

        <div class="mt-5 border-t border-border pt-5">
          <TagsSection noteId={note.id} />
        </div>
      </section>
    {:else}
      <p
        class="rounded-lg border border-border bg-background p-4 text-xs text-muted-foreground"
      >
        No note selected.
      </p>
    {/if}
  </div>
</aside>

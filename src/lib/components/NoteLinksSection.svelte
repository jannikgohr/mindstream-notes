<script lang="ts">
  import {
    ArrowUpRight,
    CornerUpLeft,
    Link2,
    LoaderCircle
  } from '@lucide/svelte';
  import NoteKindIcon from './NoteKindIcon.svelte';
  import {
    loadNoteRelations,
    type NoteRelations
  } from '$lib/notes/note-relations';
  import { requestOpenNote } from '$lib/stores/open-note-intent.svelte';
  import { tree } from '$lib/stores/tree.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';

  interface Props {
    noteId: string;
  }

  let { noteId }: Props = $props();
  let relations = $state<NoteRelations>({ backlinks: [], outgoing: [] });
  let loading = $state(false);
  let failed = $state(false);

  const notesFingerprint = $derived(
    Object.values(tree.notesById)
      .map((note) => `${note.id}:${note.modified}:${note.trashed}`)
      .sort()
      .join('|')
  );

  function notesFor(ids: string[]) {
    return ids
      .map((id) => tree.notesById[id])
      .filter((note) => Boolean(note) && !note.trashed)
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  $effect(() => {
    const id = noteId;
    void notesFingerprint;
    let cancelled = false;
    loading = true;
    failed = false;
    void loadNoteRelations(id, Object.values(tree.notesById))
      .then((next) => {
        if (!cancelled && noteId === id) relations = next;
      })
      .catch((error) => {
        console.warn('[sidebar] failed to load note relations', error);
        if (!cancelled && noteId === id) {
          relations = { backlinks: [], outgoing: [] };
          failed = true;
        }
      })
      .finally(() => {
        if (!cancelled && noteId === id) loading = false;
      });
    return () => {
      cancelled = true;
    };
  });
</script>

{#snippet noteList(ids: string[], emptyLabel: string)}
  {@const notes = notesFor(ids)}
  {#if notes.length === 0}
    <p class="py-1 text-xs text-muted-foreground">{emptyLabel}</p>
  {:else}
    <ul class="space-y-1">
      {#each notes as linkedNote (linkedNote.id)}
        <li>
          <button
            type="button"
            class="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground"
            onclick={() => requestOpenNote(linkedNote.id)}
          >
            <NoteKindIcon
              kind={linkedNote.note_kind}
              class="size-3.5 shrink-0 text-muted-foreground"
            />
            <span class="truncate">{linkedNote.title}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
{/snippet}

<section
  class="rounded-lg border border-border bg-background p-4 text-foreground shadow-sm"
>
  <h3
    class="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
  >
    <Link2 class="size-3.5" />
    {tUi('sidebar.links')}
  </h3>

  {#if loading && relations.backlinks.length === 0 && relations.outgoing.length === 0}
    <p class="flex items-center gap-2 py-1 text-xs text-muted-foreground">
      <LoaderCircle class="size-3.5 animate-spin" />
      {tUi('sidebar.links.loading')}
    </p>
  {:else if failed}
    <p class="py-1 text-xs text-muted-foreground">
      {tUi('sidebar.links.failed')}
    </p>
  {:else}
    <div>
      <h4
        class="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
      >
        <CornerUpLeft class="size-3.5" />
        {tUi('sidebar.backlinks')}
      </h4>
      {@render noteList(relations.backlinks, tUi('sidebar.backlinks.empty'))}
    </div>

    <div class="mt-4 border-t border-border pt-4">
      <h4
        class="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
      >
        <ArrowUpRight class="size-3.5" />
        {tUi('sidebar.outgoingLinks')}
      </h4>
      {@render noteList(relations.outgoing, tUi('sidebar.outgoingLinks.empty'))}
    </div>
  {/if}
</section>

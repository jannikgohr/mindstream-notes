<script lang="ts">
  /**
   * Full-screen editor view. Owns its own header (back arrow + note
   * title); the home shell's top bar and bottom nav are hidden while
   * this is foreground. NoteEditor is shared with desktop — only the
   * surrounding chrome changes per platform.
   */
  import { ArrowLeft, Star } from 'lucide-svelte';
  import { Button } from '$lib/components/ui/button';
  import NoteEditor from '$lib/components/NoteEditor.svelte';
  import { tree } from '$lib/stores/tree.svelte';
  import { ui } from '$lib/state.svelte';
  import { isFavourite, setMobileScreen, toggleFavourite } from './state.svelte';

  const noteId = $derived(ui.activeNoteId);
  const note = $derived(noteId ? tree.notesById[noteId] : null);
  const fav = $derived(noteId ? isFavourite(noteId) : false);

  function back() {
    setMobileScreen('home');
  }
</script>

<div class="flex h-full w-full flex-col">
  <header
    class="flex h-12 shrink-0 select-none items-center gap-1 border-b border-border bg-card px-2"
  >
    <Button
      variant="ghost"
      size="icon"
      onclick={back}
      title="Back"
      aria-label="Back to notes"
    >
      <ArrowLeft class="size-5" />
    </Button>
    <span class="min-w-0 flex-1 truncate text-sm font-medium">
      {note?.title ?? 'Note'}
    </span>
    {#if noteId}
      <Button
        variant="ghost"
        size="icon"
        onclick={() => toggleFavourite(noteId)}
        aria-pressed={fav}
        aria-label={fav ? 'Remove from favourites' : 'Add to favourites'}
        title={fav ? 'Remove from favourites' : 'Add to favourites'}
      >
        <Star class="size-5" fill={fav ? 'currentColor' : 'none'} />
      </Button>
    {/if}
  </header>

  <main class="min-h-0 flex-1 overflow-hidden fullscreen-note">
    {#if noteId}
      <NoteEditor {noteId} />
    {:else}
      <p class="p-6 text-center text-sm text-muted-foreground">
        No note selected.
      </p>
    {/if}
  </main>
</div>

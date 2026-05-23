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
  import FreeformNoteEditor from '$lib/components/FreeformNoteEditor.svelte';
  import DrawingNoteEditor from '$lib/components/DrawingNoteEditor.svelte';
  import UnknownNoteKindError from '$lib/components/UnknownNoteKindError.svelte';
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
      <!-- Snapshot the (non-null inside this block) noteId so the click
           closure captures a plain `string` instead of the reactive
           `string | null` $derived. Two benefits: TypeScript's null-
           flow analyzer is satisfied without an `!` assertion, and the
           handler can't accidentally fire against a different note if
           ui.activeNoteId changes between render and click. -->
      {@const currentNoteId = noteId}
      <Button
        variant="ghost"
        size="icon"
        onclick={() => toggleFavourite(currentNoteId)}
        aria-pressed={fav}
        aria-label={fav ? 'Remove from favourites' : 'Add to favourites'}
        title={fav ? 'Remove from favourites' : 'Add to favourites'}
      >
        <Star class="size-5" fill={fav ? 'currentColor' : 'none'} />
      </Button>
    {/if}
  </header>

  <main class="min-h-0 flex-1 overflow-hidden fullscreen-note">
    {#if !noteId}
      <p class="p-6 text-center text-sm text-muted-foreground">
        No note selected.
      </p>
    {:else if !note}
      <!-- Tree hasn't hydrated this note yet — show a placeholder
           instead of falling through to NoteEditor with the wrong
           kind. The mobile list calls openNote() which awaits the
           post-create loadTree, but a deep-link / restore-on-launch
           could race the initial hydration. -->
      <p class="p-6 text-center text-sm text-muted-foreground">
        Loading note…
      </p>
    {:else if note.note_kind === 'freeform'}
      <FreeformNoteEditor {noteId} />
    {:else if note.note_kind === 'ink'}
      <DrawingNoteEditor {noteId} />
    {:else if note.note_kind === 'markdown'}
      <NoteEditor {noteId} />
    {:else}
      <!-- Schema we don't recognise (a newer-app-version peer pushed
           a row with a new kind). Refuse rather than silently
           rendering NoteEditor — saving would overwrite the body
           with markdown and lose the original content. -->
      <UnknownNoteKindError {noteId} />
    {/if}
  </main>
</div>

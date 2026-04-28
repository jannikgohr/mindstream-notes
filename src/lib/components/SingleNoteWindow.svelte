<script lang="ts">
  /**
   * Layout used by spawned Tauri windows that show a single note. No file
   * tree, no metadata sidebar, no dock — just the editor and a small title
   * bar so the window is dismissable.
   *
   * The `noteId` is passed in from the route; if the note isn't in the
   * in-memory store yet we render a friendly placeholder. Once Rust-side
   * persistence lands the editor will load the real body via load_note.
   */
  import NoteEditor from './NoteEditor.svelte';
  import { notes } from '$lib/state.svelte';

  interface Props {
    noteId: string;
  }
  let { noteId }: Props = $props();

  const note = $derived(notes.byId[noteId]);
</script>

<div class="flex h-full w-full flex-col bg-background text-foreground">
  <header
    class="flex h-9 shrink-0 items-center border-b border-border bg-card px-3 text-xs font-medium text-muted-foreground"
  >
    {note?.title ?? 'Note'}
  </header>

  <main class="min-h-0 flex-1 overflow-hidden">
    {#if note}
      <NoteEditor noteId={note.id} />
    {:else}
      <div class="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        Note <code class="mx-1 rounded bg-muted px-1.5 py-0.5">{noteId}</code>
        isn't loaded in this window yet. Once disk persistence is wired up
        (see <code>save_note</code> / <code>load_note</code> in
        <code>src-tauri/src/lib.rs</code>) it'll be hydrated from the vault
        directory automatically.
      </div>
    {/if}
  </main>
</div>

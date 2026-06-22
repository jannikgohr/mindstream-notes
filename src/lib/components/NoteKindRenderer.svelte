<script lang="ts">
  import { onDestroy } from 'svelte';
  import { loadNoteKindComponent } from './note-editor/lazy-components';

  interface Props {
    noteId: string;
    noteKind: string | null | undefined;
  }

  let { noteId, noteKind }: Props = $props();

  let LoadedComponent = $state<any | null>(null);
  let loadError = $state<string | null>(null);
  let loadToken = 0;
  let destroyed = false;

  $effect(() => {
    const token = ++loadToken;
    LoadedComponent = null;
    loadError = null;

    void loadNoteKindComponent(noteKind)
      .then((component) => {
        if (destroyed || token !== loadToken) return;
        LoadedComponent = component;
      })
      .catch((err) => {
        if (destroyed || token !== loadToken) return;
        console.error('[NoteKindRenderer] failed to load editor', err);
        loadError = 'Unable to load this editor.';
      });
  });

  onDestroy(() => {
    destroyed = true;
    loadToken += 1;
  });
</script>

{#if loadError}
  <div
    class="flex h-full items-center justify-center p-6 text-sm text-destructive"
  >
    {loadError}
  </div>
{:else if LoadedComponent}
  <LoadedComponent {noteId} />
{:else}
  <div
    class="flex h-full items-center justify-center p-6 text-sm text-muted-foreground"
  >
    Loading editor...
  </div>
{/if}

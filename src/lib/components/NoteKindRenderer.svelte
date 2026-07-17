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

  // Both props are funnelled through $derived so the effect below re-runs on
  // *value* changes only. A caller may read `noteKind` off a live note object
  // — MobileEditor passes `note.note_kind` straight out of `tree.notesById` —
  // and every autosave replaces that object wholesale. Reading the prop from
  // inside the effect would subscribe it to the object's identity, so each
  // save would re-run it, null out LoadedComponent, and remount the editor,
  // stealing focus mid-keystroke. $derived compares with === and stops the
  // propagation when the kind string is unchanged.
  //
  // `noteId` is a dependency too: the lazy editors resolve their note once in
  // onMount and never react to the prop changing, so switching notes has to
  // remount even when both are the same kind.
  const currentNoteId = $derived(noteId);
  const currentKind = $derived(noteKind);

  $effect(() => {
    void currentNoteId;
    const kind = currentKind;
    const token = ++loadToken;
    LoadedComponent = null;
    loadError = null;

    void loadNoteKindComponent(kind)
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

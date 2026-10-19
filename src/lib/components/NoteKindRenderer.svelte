<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { loadNoteKindComponent } from './note-editor/lazy-components';
  import { tree } from '$lib/stores/tree.svelte';
  import { pluginById, pluginNoteKind } from '$lib/plugins/registry.svelte';

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
  const currentKind = $derived(noteKind ?? tree.notesById[noteId]?.note_kind);
  // The same applies to the plugin registry. Every device-settings change
  // re-registers each plugin with a fresh object, and resolving any kind —
  // markdown included — scans all of them. Reduce that to the plugin owning
  // this kind and its manifest checksum, so only a real change of owner
  // remounts the editor.
  const pluginOwner = $derived.by(() => {
    const ref = pluginNoteKind(currentKind);
    if (!ref) return null;
    return `${ref.pluginId}:${pluginById(ref.pluginId)?.checksum ?? ''}`;
  });

  $effect(() => {
    void currentNoteId;
    void pluginOwner;
    const kind = currentKind;
    const token = ++loadToken;
    LoadedComponent = null;
    loadError = null;

    // The loader resolves the kind against the registry synchronously; keep
    // that read out of this effect's dependencies.
    void untrack(() => loadNoteKindComponent(kind))
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
  <LoadedComponent {noteId} noteKind={currentKind} />
{:else}
  <div
    class="flex h-full items-center justify-center p-6 text-sm text-muted-foreground"
  >
    Loading editor...
  </div>
{/if}

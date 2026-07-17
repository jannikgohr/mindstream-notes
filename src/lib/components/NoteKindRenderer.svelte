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

  /**
   * The kind, memoized by VALUE.
   *
   * Reading the `noteKind` prop straight from the effect below re-runs it
   * whenever the prop EXPRESSION re-evaluates, not only when the kind actually
   * changes — and `MobileEditor` passes `note.note_kind`, where `note` is
   * derived from the tree store and is replaced by a fresh object on every save
   * and every sync. That made the effect null `LoadedComponent` and remount the
   * whole editor for a kind that was still 'markdown', which on mobile became a
   * self-sustaining loop: the remounted NoteEditor writes to the tree on mount,
   * which re-fires this effect, roughly twice a second. It also reset any
   * per-note editor state (e.g. the view mode) each time round.
   *
   * A `$derived` only notifies when its value differs, so the effect now runs
   * once per genuine kind change. `DesktopLayout` was never affected — it
   * passes a string literal per panel type.
   */
  const kind = $derived(noteKind);

  $effect(() => {
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

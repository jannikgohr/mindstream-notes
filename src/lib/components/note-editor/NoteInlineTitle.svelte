<script lang="ts">
  /**
   * The note's title, shown as the document's heading above the editor
   * body and editable in place. Without it a note opens on its first
   * paragraph and the title only appears in the tab and the details panel.
   *
   * Commits through the same `renameNote` path as the file tree: Enter or
   * blur saves, Escape reverts, and an empty title is never saved. Enter
   * also hands the caret to the body so typing can continue.
   */
  import { renameNote, tree } from '$lib/stores/tree.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';

  interface Props {
    noteId: string;
    readonly?: boolean;
    onEnter?: () => void;
  }
  let { noteId, readonly = false, onEnter }: Props = $props();

  const saved = $derived(tree.notesById[noteId]?.title ?? '');
  let draft = $state<string | null>(null);
  let field = $state<HTMLTextAreaElement>();

  // The field wraps long titles, so it grows with its content.
  function fit() {
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${field.scrollHeight}px`;
  }
  $effect(() => {
    void saved;
    void draft;
    fit();
  });

  async function commit() {
    if (draft === null) return;
    const next = draft.replace(/\s+/g, ' ').trim();
    draft = null;
    if (!next || next === saved) return;
    try {
      await renameNote(noteId, next);
    } catch (error) {
      console.error('[NoteInlineTitle] rename failed', error);
    }
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      void commit();
      onEnter?.();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      draft = null;
      field?.blur();
    }
  }
</script>

<textarea
  bind:this={field}
  class="note-inline-title"
  rows="1"
  spellcheck="false"
  aria-label={tUi('editor.inlineTitle.label')}
  {readonly}
  value={draft ?? saved}
  oninput={(event) => (draft = event.currentTarget.value)}
  onkeydown={onKeydown}
  onblur={() => void commit()}
></textarea>

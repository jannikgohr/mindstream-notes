<script lang="ts">
  /**
   * Editor for `note_kind === 'ink'` notes.
   *
   * The canonical ink surface is now the Svelte/Pointer Events canvas in
   * `InkWebNoteEditor` on every platform. Android's native drawing bridge is
   * kept for the follow-up live-ink overlay step, but this component no longer
   * opens the Rust/egui SurfaceView as the source of truth.
   */
  import InkWebNoteEditor from '$lib/components/InkWebNoteEditor.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';

  interface Props {
    noteId: string;
  }

  let { noteId }: Props = $props();
</script>

<InkWebNoteEditor {noteId} ariaLabel={tUi('editor.ink.desktopPanelLabel')} />

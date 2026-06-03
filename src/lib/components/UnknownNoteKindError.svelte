<script lang="ts">
  /**
   * Rendered in place of an editor when a note's `note_kind` isn't in
   * this app version's `KNOWN_NOTE_KINDS`. Typically means a newer
   * device on the same account synced a row using an editor type that
   * shipped later — we refuse to open it rather than fall back to the
   * markdown editor, which would corrupt the body on the next save.
   *
   * The `noteId` prop matches the rest of the editor surface so this
   * can drop in as a SvelteRenderer panel in dockview, the popout
   * window's `<main>`, or MobileEditor's `<main>` without any
   * adaptation.
   */
  import { AlertTriangle } from 'lucide-svelte';
  import { tree } from '$lib/stores/tree.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';

  interface Props {
    noteId: string;
  }
  let { noteId }: Props = $props();

  const kind = $derived(tree.notesById[noteId]?.note_kind ?? '(unknown)');
  const title = $derived(tree.notesById[noteId]?.title ?? noteId);
</script>

<div class="flex h-full w-full items-center justify-center p-6">
  <div
    class="flex max-w-md flex-col items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-5 text-sm"
    role="alert"
  >
    <div class="flex items-center gap-2 text-destructive">
      <AlertTriangle class="size-4 shrink-0" aria-hidden="true" />
      <span class="font-semibold">{tUi('editor.unknownKind.title')}</span>
    </div>
    <p class="text-foreground">
      {tUi('editor.unknownKind.message')}
    </p>
    <dl
      class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-muted-foreground"
    >
      <dt>{tUi('editor.unknownKind.titleLabel')}</dt>
      <dd class="break-words font-medium text-foreground">{title}</dd>
      <dt>{tUi('editor.unknownKind.kindLabel')}</dt>
      <dd>
        <code class="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">
          {kind}
        </code>
      </dd>
    </dl>
  </div>
</div>

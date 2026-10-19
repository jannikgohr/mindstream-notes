<script lang="ts">
  import PdfNoteViewer from './PdfNoteViewer.svelte';
  import InkWebNoteEditor from './InkWebNoteEditor.svelte';
  import { preparePdfHandwriting } from '$lib/ink/pdf-import';
  import type { InkPage } from '$lib/ink/page';
  import { tUi, tUiFormat } from '$lib/settings/i18n.svelte';
  let { noteId }: { noteId: string } = $props();
  let pages = $state<InkPage[] | null>(null);
  let writing = $state(false);
  let busy = $state(false);
  let progress = $state('');
  let error = $state('');
  let generation = $state(0);
  let inkEditor = $state<{ flush(): Promise<void> } | null>(null);
  let reader = $state<{ flush(): Promise<void> } | null>(null);
  async function write() {
    if (busy) return;
    busy = true;
    error = '';
    try {
      await reader?.flush();
      pages = await preparePdfHandwriting(noteId, (page, total) => {
        progress = tUiFormat('ink.pages.rasterizing', { page, total });
      });
      writing = true;
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
  async function read() {
    if (busy) return;
    busy = true;
    error = '';
    try {
      await inkEditor?.flush();
      writing = false;
      generation++;
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  {#if busy}<p class="p-2 text-sm" role="status">
      {progress || tUi('ink.pages.working')}
    </p>{/if}
  {#if error}<p class="p-2 text-sm text-destructive" role="alert">
      {error}
    </p>{/if}
  <div class="min-h-0 flex-1">
    {#if writing && pages}
      <InkWebNoteEditor
        bind:this={inkEditor}
        {noteId}
        ariaLabel={tUi('ink.pdf.write')}
        seedPages={pages}
        allowPageEditing={false}
        onBack={read}
      />
    {:else}
      {#key generation}<PdfNoteViewer
          bind:this={reader}
          {noteId}
          onHandwriting={write}
        />{/key}
    {/if}
  </div>
</div>

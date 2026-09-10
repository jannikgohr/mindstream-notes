<script lang="ts">
  /**
   * The "Import notes" dialog: pick a source, confirm what was detected and
   * where it should land, then watch the run.
   *
   * Three stages in one dialog rather than a wizard, because the middle stage
   * is the only one with real choices and all of its defaults are already
   * correct — the common path is open, glance, Import.
   *
   * One instance lives in the root layout; callers use `openImportDialog()`
   * from the sibling `.svelte.ts`.
   */

  import { AlertDialog } from 'bits-ui';
  import { FileText, FolderOpen, Loader2 } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import * as api from '$lib/api';
  import type {
    DetectedSource,
    ImportSourceKind,
    UnresolvedLinksPolicy
  } from '$lib/api';
  import { listen, TauriEventName } from '$lib/api/events';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { tree } from '$lib/stores/tree.svelte';
  import { formatBytes } from '$lib/utils';
  import { importNotesQueue } from './import-notes-dialog.svelte';
  import {
    folderOptions,
    sourceKindLabelKey,
    uniqueFolderName
  } from './import-notes-helpers';

  type Stage = 'choose-source' | 'configure' | 'running';

  const current = $derived(importNotesQueue.items[0] ?? null);

  let stage = $state<Stage>('choose-source');
  let detected = $state<DetectedSource | null>(null);
  let kind = $state<ImportSourceKind>('gfm');
  let destination = $state<string | null>(null);
  let folderName = $state('');
  let importAttachments = $state(true);
  let maxAttachmentBytes = $state(api.DEFAULT_MAX_ATTACHMENT_BYTES);
  let unresolvedLinks = $state<UnresolvedLinksPolicy>('plain-text');
  let errorMessage = $state<string | null>(null);
  let progress = $state<{ done: number; total: number } | null>(null);
  let cancelling = $state(false);

  const folders = $derived(folderOptions(tree.collectionsById));

  /**
   * Reset every time a fresh request reaches the head of the queue, so a
   * second import doesn't inherit the first one's answers.
   */
  $effect(() => {
    if (!current) return;
    stage = 'choose-source';
    detected = null;
    errorMessage = null;
    progress = null;
    cancelling = false;
    importAttachments = true;
    maxAttachmentBytes = api.DEFAULT_MAX_ATTACHMENT_BYTES;
    unresolvedLinks = 'plain-text';
    destination = null;
  });

  // Progress arrives as an app event because the run is a single long command;
  // the subscription only exists while the dialog is mounted.
  $effect(() => {
    const unlisten = listen(TauriEventName.ImportProgress, (payload) => {
      if (payload.phase === 'importing' || payload.phase === 'done') {
        progress = { done: payload.done, total: payload.total };
      }
    });
    return () => {
      void unlisten.then((off) => off());
    };
  });

  function finish(report: api.ImportReport | null) {
    const item = importNotesQueue.items[0];
    if (!item) return;
    importNotesQueue.items = importNotesQueue.items.slice(1);
    item.resolve(report);
  }

  async function choose(pick: () => Promise<string | null>) {
    errorMessage = null;
    let path: string | null;
    try {
      path = await pick();
    } catch (err) {
      errorMessage = toMessage(err);
      return;
    }
    // Cancelled picker — stay on this stage rather than closing, so the user
    // can try the other button.
    if (!path) return;
    try {
      const result = await api.detectImportSource(path);
      if (!result) {
        errorMessage = tUi('data.importNotes.error.unsupportedPlatform');
        return;
      }
      detected = result;
      kind = result.kind;
      folderName = uniqueFolderName(
        result.suggested_name,
        tree.collectionsById,
        null
      );
      stage = 'configure';
    } catch (err) {
      errorMessage = toMessage(err);
    }
  }

  async function start() {
    if (!detected) return;
    stage = 'running';
    errorMessage = null;
    progress = { done: 0, total: 0 };
    try {
      const report = await api.runImport({
        source_path: detected.path,
        kind,
        destination_collection_id: destination,
        // Always a new folder: an import is easiest to undo when it is one
        // thing to trash. The select above chooses that folder's parent.
        create_folder_named: folderName.trim() || detected.suggested_name,
        import_attachments: importAttachments,
        max_attachment_bytes: maxAttachmentBytes,
        unresolved_links: unresolvedLinks
      });
      finish(report);
    } catch (err) {
      errorMessage = toMessage(err);
      stage = 'configure';
    }
  }

  async function cancelRun() {
    cancelling = true;
    try {
      await api.cancelImport();
    } catch {
      // The run either already finished or never started; either way the
      // report is about to arrive and will say what landed.
      cancelling = false;
    }
  }

  function toMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  const percent = $derived(
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.done / progress.total) * 100))
      : null
  );
</script>

<AlertDialog.Root
  open={current !== null}
  onOpenChange={(open: boolean) => {
    // A run in flight owns the dialog: closing it would leave the import
    // going with nowhere to report back to.
    if (!open && stage !== 'running') finish(null);
  }}
>
  <AlertDialog.Portal>
    <AlertDialog.Overlay
      class="fixed inset-0 z-[400] bg-scrim backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
    />
    <AlertDialog.Content
      class="fixed left-1/2 top-1/2 z-[400] w-[min(560px,94vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card p-5 text-card-foreground shadow-xl focus:outline-none"
    >
      <AlertDialog.Title class="text-base font-semibold">
        {tUi('data.importNotes.title')}
      </AlertDialog.Title>

      {#if stage === 'choose-source'}
        <AlertDialog.Description class="mt-1 text-xs text-muted-foreground">
          {tUi('data.importNotes.chooseSource.description')}
        </AlertDialog.Description>
        <div class="mt-4 grid gap-2 sm:grid-cols-2">
          <Button
            variant="outline"
            class="h-auto flex-col items-start gap-1 p-3 text-left"
            onclick={() => choose(api.pickImportFolder)}
          >
            <span class="flex items-center gap-2 font-medium">
              <FolderOpen class="size-4" />
              {tUi('data.importNotes.chooseSource.folder')}
            </span>
            <span class="text-xs font-normal text-muted-foreground">
              {tUi('data.importNotes.chooseSource.folderHint')}
            </span>
          </Button>
          <Button
            variant="outline"
            class="h-auto flex-col items-start gap-1 p-3 text-left"
            onclick={() => choose(api.pickImportFile)}
          >
            <span class="flex items-center gap-2 font-medium">
              <FileText class="size-4" />
              {tUi('data.importNotes.chooseSource.file')}
            </span>
            <span class="text-xs font-normal text-muted-foreground">
              {tUi('data.importNotes.chooseSource.fileHint')}
            </span>
          </Button>
        </div>
      {:else if stage === 'configure' && detected}
        <AlertDialog.Description
          class="mt-1 break-all text-xs text-muted-foreground"
        >
          {detected.path}
        </AlertDialog.Description>

        <div class="mt-4 grid gap-3 text-sm">
          <label class="grid gap-1">
            <span class="text-xs text-muted-foreground">
              {tUi('data.importNotes.field.format')}
            </span>
            <select
              bind:value={kind}
              class="h-8 rounded-md border border-input bg-background px-2 text-sm"
            >
              {#each api.IMPORT_SOURCE_KINDS as option (option)}
                <option value={option}>{tUi(sourceKindLabelKey(option))}</option
                >
              {/each}
            </select>
          </label>

          <label class="grid gap-1">
            <span class="text-xs text-muted-foreground">
              {tUi('data.importNotes.field.folderName')}
            </span>
            <input
              bind:value={folderName}
              class="h-8 rounded-md border border-input bg-background px-2 text-sm"
            />
          </label>

          <label class="grid gap-1">
            <span class="text-xs text-muted-foreground">
              {tUi('data.importNotes.field.destination')}
            </span>
            <select
              bind:value={destination}
              class="h-8 rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value={null}>
                {tUi('data.importNotes.destination.root')}
              </option>
              {#each folders as folder (folder.id)}
                <option value={folder.id}>
                  {' '.repeat(folder.depth * 2)}{folder.name}
                </option>
              {/each}
            </select>
          </label>

          <label class="grid gap-1">
            <span class="text-xs text-muted-foreground">
              {tUi('data.importNotes.field.unresolvedLinks')}
            </span>
            <select
              bind:value={unresolvedLinks}
              class="h-8 rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="plain-text">
                {tUi('data.importNotes.unresolved.plainText')}
              </option>
              <option value="create-placeholder">
                {tUi('data.importNotes.unresolved.placeholder')}
              </option>
            </select>
          </label>

          <label class="flex items-center gap-2">
            <input type="checkbox" bind:checked={importAttachments} />
            <span>{tUi('data.importNotes.field.attachments')}</span>
          </label>

          {#if importAttachments}
            <label class="grid gap-1">
              <span class="text-xs text-muted-foreground">
                {tUi('data.importNotes.field.attachmentCap').replace(
                  '{size}',
                  formatBytes(maxAttachmentBytes)
                )}
              </span>
              <input
                type="range"
                min={1024 * 1024}
                max={200 * 1024 * 1024}
                step={1024 * 1024}
                bind:value={maxAttachmentBytes}
              />
            </label>
          {/if}
        </div>
      {:else if stage === 'running'}
        <AlertDialog.Description class="mt-1 text-xs text-muted-foreground">
          {#if progress && progress.total > 0}
            {tUi('data.importNotes.running.counted')
              .replace('{done}', String(progress.done))
              .replace('{total}', String(progress.total))}
          {:else}
            {tUi('data.importNotes.running.scanning')}
          {/if}
        </AlertDialog.Description>
        <div class="mt-4 h-2 overflow-hidden rounded-full bg-muted">
          <div
            class="h-full bg-primary transition-[width] duration-200"
            style={`width: ${percent ?? 5}%`}
          ></div>
        </div>
      {/if}

      {#if errorMessage}
        <p
          class="mt-3 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
        >
          {errorMessage}
        </p>
      {/if}

      <div class="mt-5 flex flex-wrap justify-end gap-2">
        {#if stage === 'running'}
          <Button variant="ghost" disabled={cancelling} onclick={cancelRun}>
            {#if cancelling}
              <Loader2 class="mr-1 size-3.5 animate-spin" />
            {/if}
            {tUi('data.importNotes.button.stop')}
          </Button>
        {:else}
          <Button variant="ghost" onclick={() => finish(null)}>
            {tUi('data.importNotes.button.cancel')}
          </Button>
          {#if stage === 'configure'}
            <Button variant="default" onclick={start}>
              {tUi('data.importNotes.button.import')}
            </Button>
          {/if}
        {/if}
      </div>
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>

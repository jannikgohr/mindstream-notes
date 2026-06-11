<script lang="ts">
  /**
   * Three-way "what should I do with this backup?" dialog. Renders a
   * preview of the backup + the current vault and offers Restore /
   * Merge / Cancel. One instance lives in the root layout; callers use
   * `pickImportChoice()` from the sibling `.svelte.ts` file.
   */

  import { AlertDialog } from 'bits-ui';
  import { Button } from '$lib/components/ui/button';
  import { importChoiceQueue } from './import-choice-dialog.svelte';
  import type { ImportChoice } from './import-choice-dialog.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';

  const current = $derived(importChoiceQueue.items[0] ?? null);

  function resolveWith(choice: ImportChoice) {
    const item = importChoiceQueue.items[0];
    if (!item) return;
    importChoiceQueue.items = importChoiceQueue.items.slice(1);
    item.resolve(choice);
  }

  function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function formatAccount(
    a: { username: string | null; server_url: string | null } | null
  ): string {
    if (!a) return tUi('data.import.account.localOnly');
    const u = a.username ?? tUi('data.import.account.unknownUser');
    const s = a.server_url ?? '';
    return s ? `${u} · ${s}` : u;
  }
</script>

<AlertDialog.Root
  open={current !== null}
  onOpenChange={(open: boolean) => {
    if (!open) resolveWith('cancel');
  }}
>
  <AlertDialog.Portal>
    <AlertDialog.Overlay
      class="fixed inset-0 z-[400] bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
    />
    <AlertDialog.Content
      class="fixed left-1/2 top-1/2 z-[400] w-[min(520px,94vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card p-5 text-card-foreground shadow-xl focus:outline-none"
    >
      {#if current}
        <AlertDialog.Title class="text-base font-semibold">
          {tUi('data.import.title')}
        </AlertDialog.Title>
        <AlertDialog.Description class="mt-1 text-xs text-muted-foreground">
          {tUi('data.import.description')
            .replace('{version}', current.preview.backup_app_version)
            .replace('{createdAt}', current.preview.backup_created_at)}
        </AlertDialog.Description>

        <div class="mt-4 grid grid-cols-3 gap-2 text-sm">
          <div class="font-medium"></div>
          <div class="font-medium">{tUi('data.import.column.backup')}</div>
          <div class="font-medium">{tUi('data.import.column.current')}</div>

          <div class="text-muted-foreground">
            {tUi('data.import.row.notes')}
          </div>
          <div>{current.preview.backup_counts.notes}</div>
          <div>{current.preview.current_counts.notes}</div>

          <div class="text-muted-foreground">
            {tUi('data.import.row.folders')}
          </div>
          <div>{current.preview.backup_counts.folders}</div>
          <div>{current.preview.current_counts.folders}</div>

          <div class="text-muted-foreground">
            {tUi('data.import.row.assets')}
          </div>
          <div>{formatBytes(current.preview.backup_counts.assets_bytes)}</div>
          <div>{formatBytes(current.preview.current_counts.assets_bytes)}</div>

          <div class="text-muted-foreground">
            {tUi('data.import.row.account')}
          </div>
          <div class="break-all text-xs">
            {formatAccount(current.preview.backup_account)}
          </div>
          <div class="break-all text-xs">
            {formatAccount(current.preview.current_account)}
          </div>
        </div>

        <div
          class="mt-3 rounded border border-border bg-muted/30 p-3 text-xs text-muted-foreground"
        >
          {#if current.preview.same_account}
            {tUi('data.import.notice.sameAccount')}
          {:else}
            {tUi('data.import.notice.differentAccount')}
          {/if}
        </div>

        <div class="mt-5 flex flex-wrap justify-end gap-2">
          <AlertDialog.Cancel onclick={() => resolveWith('cancel')}>
            {#snippet child({ props })}
              <Button variant="ghost" {...props}>
                {tUi('data.import.button.cancel')}
              </Button>
            {/snippet}
          </AlertDialog.Cancel>
          <Button variant="default" onclick={() => resolveWith('merge')}>
            {tUi('data.import.button.merge')}
          </Button>
          <Button variant="destructive" onclick={() => resolveWith('restore')}>
            {tUi('data.import.button.restore')}
          </Button>
        </div>
      {/if}
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>

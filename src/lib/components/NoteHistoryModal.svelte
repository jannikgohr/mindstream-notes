<script lang="ts">
  /**
   * Desktop modal for inspecting a history version: three tabs — the current
   * note (read-only), a rendered-prose diff, and the selected old version
   * (read-only) — plus Restore / Cancel. Clicking outside or pressing Escape
   * cancels (handled by the Dialog's onOpenChange). Mobile keeps the inline
   * detail view in NoteHistorySection instead of this modal.
   */
  import { Dialog, Tabs } from 'bits-ui';
  import { X } from '@lucide/svelte';
  import ReadonlyNoteView from './history/ReadonlyNoteView.svelte';
  import MilkdownDiffView from './history/MilkdownDiffView.svelte';
  import { Button } from '$lib/components/ui/button';
  import { formatNoteDateTime } from '$lib/date-time';
  import { tUi } from '$lib/settings/i18n.svelte';

  interface Props {
    created: string;
    oldMarkdown: string;
    currentMarkdown: string;
    restoring?: boolean;
    onClose: () => void;
    onRestore: () => void;
  }
  let {
    created,
    oldMarkdown,
    currentMarkdown,
    restoring = false,
    onClose,
    onRestore
  }: Props = $props();

  let tab = $state<'current' | 'diff' | 'old'>('diff');
  const oldLabel = $derived(
    tUi('history.modal.oldTab').replace('{date}', formatNoteDateTime(created))
  );
</script>

<Dialog.Root
  open={true}
  onOpenChange={(o: boolean) => {
    if (!o) onClose();
  }}
>
  <Dialog.Portal>
    <Dialog.Overlay
      class="fixed inset-0 z-350 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
    />
    <Dialog.Content
      class="fixed left-1/2 top-1/2 z-350 grid h-[80vh] w-[min(900px,92vw)] -translate-x-1/2 -translate-y-1/2 grid-rows-[auto_auto_1fr_auto] overflow-hidden rounded-lg border border-border bg-background text-foreground shadow-xl focus:outline-none"
    >
      <header
        class="flex items-center justify-between gap-3 border-b border-border bg-card px-4 py-3"
      >
        <Dialog.Title class="text-base font-semibold">
          {tUi('history.modal.title')}
        </Dialog.Title>
        <Dialog.Close
          class="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={tUi('history.back')}
        >
          <X class="size-4" />
        </Dialog.Close>
      </header>

      <Tabs.Root bind:value={tab} class="contents">
        <Tabs.List
          class="flex gap-1 border-b border-border bg-card/40 px-3 pt-2"
        >
          {#each [['current', tUi('history.modal.currentTab')], ['diff', tUi('history.modal.diffTab')], ['old', oldLabel]] as [value, label] (value)}
            <Tabs.Trigger
              {value}
              class="max-w-[16rem] truncate rounded-t-md border border-transparent px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground data-[state=active]:border-border data-[state=active]:border-b-background data-[state=active]:bg-background data-[state=active]:text-foreground"
            >
              {label}
            </Tabs.Trigger>
          {/each}
        </Tabs.List>

        <div class="min-h-0 overflow-hidden p-4">
          <Tabs.Content value="current" class="h-full focus:outline-none">
            {#if tab === 'current'}
              <ReadonlyNoteView markdown={currentMarkdown} />
            {/if}
          </Tabs.Content>
          <Tabs.Content value="diff" class="h-full focus:outline-none">
            {#if tab === 'diff'}
              <MilkdownDiffView {oldMarkdown} newMarkdown={currentMarkdown} />
            {/if}
          </Tabs.Content>
          <Tabs.Content value="old" class="h-full focus:outline-none">
            {#if tab === 'old'}
              <ReadonlyNoteView markdown={oldMarkdown} />
            {/if}
          </Tabs.Content>
        </div>
      </Tabs.Root>

      <footer class="flex justify-end gap-2 border-t border-border px-4 py-3">
        <Button variant="ghost" onclick={onClose} disabled={restoring}>
          {tUi('history.restoreConfirmCancel')}
        </Button>
        <Button onclick={onRestore} disabled={restoring}>
          {tUi('history.restore')}
        </Button>
      </footer>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

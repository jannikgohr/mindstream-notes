<script lang="ts">
  /**
   * Modal that renders a plugin's long-form documentation (markdown) read-only
   * with Milkdown, reusing the history ReadonlyNoteView. Opened from the
   * "View documentation" button in the plugin overview; stacks above the
   * settings dialog.
   */
  import { Dialog } from 'bits-ui';
  import { X } from '@lucide/svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import ReadonlyNoteView from '$lib/components/history/ReadonlyNoteView.svelte';

  interface Props {
    open: boolean;
    title: string;
    markdown: string;
  }
  let { open = $bindable(), title, markdown }: Props = $props();
</script>

<Dialog.Root bind:open>
  <Dialog.Portal>
    <Dialog.Overlay
      class="fixed inset-0 z-[400] bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
    />
    <Dialog.Content
      class="fixed left-1/2 top-1/2 z-[400] grid h-[80vh] w-[min(760px,92vw)] -translate-x-1/2 -translate-y-1/2 grid-rows-[auto_1fr] overflow-hidden rounded-lg border border-border bg-background text-foreground shadow-xl focus:outline-none"
    >
      <header
        class="flex items-center justify-between gap-3 border-b border-border bg-card px-4 py-3"
      >
        <Dialog.Title class="truncate text-base font-semibold">
          {title}
        </Dialog.Title>
        <Dialog.Close
          class="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={tUi('close')}
        >
          <X class="size-4" />
        </Dialog.Close>
      </header>

      <div class="themed-scrollbar min-h-0 overflow-y-auto px-6 py-4">
        {#if open}
          <div class="docs-md">
            <ReadonlyNoteView {markdown} />
          </div>
        {/if}
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  /* The reused read-only view scrolls internally with an unthemed bar; let this
     dialog's themed-scrollbar container own the scrolling instead. */
  .docs-md :global(.milkdown-readonly) {
    height: auto;
    overflow: visible;
  }
</style>

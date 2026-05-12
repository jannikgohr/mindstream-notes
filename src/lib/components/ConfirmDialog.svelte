<script lang="ts" module>
  /**
   * Themed replacement for `window.confirm`. One instance lives in the
   * root layout; everything else calls the exported `confirm()` to pop
   * the dialog and await a boolean.
   *
   *   if (await confirm({
   *     title: 'Delete note',
   *     message: `"${title}" will be removed permanently.`,
   *     confirmLabel: 'Delete',
   *     destructive: true
   *   })) { … }
   *
   * Module-level state + a singleton component is the simplest way to
   * provide an imperative API without making every caller stash its
   * own dialog instance. Concurrent calls are queued so a second
   * `confirm()` while one is still open waits for the user's first
   * decision.
   */

  interface ConfirmOptions {
    title: string;
    message?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    /** Renders the confirm button with the destructive (red) variant. */
    destructive?: boolean;
  }

  interface PendingConfirm extends ConfirmOptions {
    resolve: (ok: boolean) => void;
  }

  const queue = $state<{ items: PendingConfirm[] }>({ items: [] });

  export function confirm(opts: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => {
      queue.items = [...queue.items, { ...opts, resolve }];
    });
  }
</script>

<script lang="ts">
  import { AlertDialog } from 'bits-ui';
  import { Button } from '$lib/components/ui/button';

  // The head of the queue is the dialog we render right now. When the
  // user dismisses it (resolves the promise), we slice it off and the
  // next one — if any — slides into place.
  const current = $derived(queue.items[0] ?? null);

  function resolveWith(answer: boolean) {
    const item = queue.items[0];
    if (!item) return;
    queue.items = queue.items.slice(1);
    item.resolve(answer);
  }
</script>

<AlertDialog.Root
  open={current !== null}
  onOpenChange={(open: boolean) => {
    // Treat Escape / outside-tap as cancel.
    if (!open) resolveWith(false);
  }}
>
  <AlertDialog.Portal>
    <AlertDialog.Overlay
      class="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
    />
    <AlertDialog.Content
      class="fixed left-1/2 top-1/2 z-50 w-[min(420px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card p-5 text-card-foreground shadow-xl focus:outline-none"
    >
      {#if current}
        <AlertDialog.Title class="text-base font-semibold">
          {current.title}
        </AlertDialog.Title>
        {#if current.message}
          <AlertDialog.Description class="mt-2 text-sm text-muted-foreground">
            {current.message}
          </AlertDialog.Description>
        {/if}

        <div class="mt-5 flex justify-end gap-2">
          <AlertDialog.Cancel onclick={() => resolveWith(false)}>
            {#snippet child({ props })}
              <Button variant="ghost" {...props}>
                {current.cancelLabel ?? 'Cancel'}
              </Button>
            {/snippet}
          </AlertDialog.Cancel>
          <AlertDialog.Action onclick={() => resolveWith(true)}>
            {#snippet child({ props })}
              <Button
                variant={current.destructive ? 'destructive' : 'default'}
                {...props}
              >
                {current.confirmLabel ?? 'Confirm'}
              </Button>
            {/snippet}
          </AlertDialog.Action>
        </div>
      {/if}
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>

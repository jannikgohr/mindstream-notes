<script lang="ts">
  /**
   * Themed replacement for `window.confirm`. One instance lives in the
   * root layout; everything else calls `confirm()` from
   * `./confirm-dialog.svelte.ts` to pop the dialog and await a boolean.
   *
   * Queue + imperative API are in the sibling .svelte.ts file (see the
   * comment there for why); this file is just the visual shell.
   */

  import { AlertDialog } from 'bits-ui';
  import { Button } from '$lib/components/ui/button';
  import { confirmQueue } from './confirm-dialog.svelte';

  // The head of the queue is the dialog we render right now. When the
  // user dismisses it (resolves the promise), we slice it off and the
  // next one — if any — slides into place.
  const current = $derived(confirmQueue.items[0] ?? null);

  function resolveWith(answer: boolean) {
    const item = confirmQueue.items[0];
    if (!item) return;
    confirmQueue.items = confirmQueue.items.slice(1);
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
    <!--
      z-[60] (vs the rest of the app's z-50 modals) so the confirm/alert
      dialog is always painted above any open Dialog — including the
      Settings dialog, which would otherwise win the tie because
      bits-ui re-asserts the open Dialog's stack when a sibling portal
      mounts. This is intentional: confirm/alert is the *blocking*
      modal — by definition the user can't act on anything else until
      they dismiss it, so it owns the topmost paint slot.
    -->
    <AlertDialog.Overlay
      class="fixed inset-0 z-[60] bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
    />
    <AlertDialog.Content
      class="fixed left-1/2 top-1/2 z-[60] w-[min(420px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card p-5 text-card-foreground shadow-xl focus:outline-none"
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
          {#if current.infoOnly}
            <!-- Info-only mode (`alert()` callers): single button. We
                 still resolve the queue's `resolve(true)` so the
                 alert() wrapper's promise settles; the value is
                 discarded by that wrapper. -->
            <AlertDialog.Action onclick={() => resolveWith(true)}>
              {#snippet child({ props })}
                <Button variant="default" {...props}>
                  {current.confirmLabel ?? 'OK'}
                </Button>
              {/snippet}
            </AlertDialog.Action>
          {:else}
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
          {/if}
        </div>
      {/if}
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>

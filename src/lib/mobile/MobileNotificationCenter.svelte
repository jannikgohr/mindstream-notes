<script lang="ts">
  /**
   * Mobile notification centre — a full-screen surface driven by the
   * unified options menu (MobileOptionsMenu), which owns the trigger,
   * the unread indicator and the nav-stack entry. This component is just
   * the controlled sheet: `open` shows it, and any dismissal (X button,
   * backdrop, Escape) reports back through `onClose` so the menu can
   * collapse the surface and sync the history stack.
   */
  import { onMount } from 'svelte';
  import { Dialog } from 'bits-ui';
  import { X } from '@lucide/svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import {
    notificationState,
    scanForUpdateNotifications
  } from '$lib/notifications/store.svelte';
  import LazyNotificationWidget from '$lib/notifications/LazyNotificationWidget.svelte';

  let { open = false, onClose }: { open?: boolean; onClose: () => void } =
    $props();

  onMount(() => {
    void scanForUpdateNotifications();
  });
</script>

<Dialog.Root
  {open}
  onOpenChange={(o: boolean) => {
    if (!o) onClose();
  }}
>
  <Dialog.Portal>
    <Dialog.Content
      class="safe-top safe-bottom safe-x fixed inset-0 z-50 flex flex-col bg-background text-foreground focus:outline-none"
    >
      <header
        class="flex h-12 shrink-0 items-center justify-between border-b border-border bg-card px-2"
      >
        <div class="w-9 shrink-0"></div>
        <Dialog.Title class="truncate text-sm font-semibold">
          {tUi('notifications.title')}
        </Dialog.Title>
        <Dialog.Close
          class="flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={tUi('close')}
        >
          <X class="size-5" />
        </Dialog.Close>
      </header>

      <section class="flex-1 overflow-y-auto px-2 py-2">
        {#if notificationState.items.length === 0}
          <p class="px-4 py-8 text-center text-sm text-muted-foreground">
            {tUi('notifications.empty')}
          </p>
        {:else}
          <div class="space-y-1">
            {#each notificationState.items as notification (notification.id)}
              <LazyNotificationWidget
                {notification}
                onClose={() => onClose()}
              />
            {/each}
          </div>
        {/if}
      </section>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

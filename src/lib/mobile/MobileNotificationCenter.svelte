<script lang="ts">
  import { onMount } from 'svelte';
  import { Dialog } from 'bits-ui';
  import { Bell, Loader2, X } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import { tUi } from '$lib/settings/i18n.svelte';
  import {
    notificationState,
    scanForUpdateNotifications
  } from '$lib/notifications/store.svelte';
  import {
    FALLBACK_NOTIFICATION_WIDGET,
    NOTIFICATION_WIDGETS
  } from '$lib/notifications/widgets';

  let open = $state(false);

  const notificationCount = $derived(notificationState.items.length);
  const countLabel = $derived(
    notificationCount > 99 ? '99+' : notificationCount
  );

  function close() {
    open = false;
  }

  onMount(() => {
    void scanForUpdateNotifications();
  });
</script>

<Dialog.Root bind:open>
  <Button
    variant="ghost"
    onclick={() => (open = true)}
    title={tUi('notifications.open')}
    aria-label={tUi('notifications.open')}
    aria-expanded={open}
    class="relative size-12 shrink-0 rounded-full border border-input p-0 [&_svg]:size-8"
  >
    {#if notificationState.updateScanPending}
      <Loader2 class="animate-spin" strokeWidth={1} />
    {:else}
      <Bell strokeWidth={1} />
    {/if}
    {#if notificationCount > 0}
      <span
        class="absolute right-1 top-1 min-w-4 rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground"
      >
        {countLabel}
      </span>
    {/if}
  </Button>

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
              {@const Widget =
                NOTIFICATION_WIDGETS[notification.widgetType] ??
                FALLBACK_NOTIFICATION_WIDGET}
              <Widget {notification} onClose={close} />
            {/each}
          </div>
        {/if}
      </section>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

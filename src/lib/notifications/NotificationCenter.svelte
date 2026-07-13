<script lang="ts">
  import { onMount } from 'svelte';
  import { Loader2 } from '@lucide/svelte';
  import { Bell } from '@jis3r/icons';
  import { Button } from '$lib/components/ui/button';
  import { tUi } from '$lib/settings/i18n.svelte';
  import {
    notificationState,
    scanForCollectionInviteNotifications,
    scanForUpdateNotifications
  } from './store.svelte';
  import LazyNotificationWidget from './LazyNotificationWidget.svelte';

  let open = $state(false);
  let root: HTMLDivElement | null = $state(null);

  const notificationCount = $derived(notificationState.items.length);
  const countLabel = $derived(
    notificationCount > 99 ? '99+' : notificationCount
  );

  function toggle() {
    open = !open;
  }

  function close() {
    open = false;
  }

  function handleDocumentPointerDown(event: PointerEvent) {
    if (!open || !root) return;
    if (event.target instanceof Node && !root.contains(event.target)) {
      open = false;
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') open = false;
  }

  onMount(() => {
    void scanForUpdateNotifications();
    void scanForCollectionInviteNotifications();
    document.addEventListener('pointerdown', handleDocumentPointerDown, true);
    document.addEventListener('keydown', handleKeydown);
    return () => {
      document.removeEventListener(
        'pointerdown',
        handleDocumentPointerDown,
        true
      );
      document.removeEventListener('keydown', handleKeydown);
    };
  });
</script>

<div bind:this={root} class="relative">
  <Button
    class="relative"
    variant="ghost"
    size="icon"
    onclick={toggle}
    title={tUi('notifications.open')}
    aria-label={tUi('notifications.open')}
    aria-expanded={open}
  >
    {#if notificationState.updateScanPending}
      <Loader2 class="size-4 animate-spin" />
    {:else}
      <Bell size={16} />
    {/if}
    {#if notificationCount > 0}
      <span
        class="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground"
      >
        {countLabel}
      </span>
    {/if}
  </Button>

  {#if open}
    <div
      class="absolute right-0 top-[calc(100%+0.375rem)] z-300 w-80 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-lg"
    >
      <div class="border-b border-border px-3 py-2">
        <p class="text-sm font-semibold">{tUi('notifications.title')}</p>
      </div>

      <div class="max-h-96 overflow-y-auto p-1">
        {#if notificationState.items.length === 0}
          <p class="px-3 py-5 text-center text-xs text-muted-foreground">
            {tUi('notifications.empty')}
          </p>
        {:else}
          {#each notificationState.items as notification (notification.id)}
            <LazyNotificationWidget {notification} onClose={close} />
          {/each}
        {/if}
      </div>
    </div>
  {/if}
</div>

<script lang="ts">
  import { Share2, X } from '@lucide/svelte';
  import { tooltip } from '$lib/actions/tooltip';
  import { Button } from '$lib/components/ui/button';
  import { acceptShareBundle, declineShareBundle } from '$lib/api/sharing';
  import { loadTree } from '$lib/stores/tree.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import {
    dismissNotification,
    scanForCollectionInviteNotifications
  } from './store.svelte';
  import type { AppNotification, ShareBundleNotificationData } from './types';

  interface Props {
    notification: AppNotification<ShareBundleNotificationData>;
    onClose?: () => void;
  }

  let { notification, onClose }: Props = $props();
  let pending = $state(false);
  let error = $state<string | null>(null);

  const accessLabel = $derived(
    notification.data.accessLevel === 'admin'
      ? tUi('sharing.access.admin')
      : notification.data.accessLevel === 'read_write'
        ? tUi('sharing.access.readWrite')
        : notification.data.accessLevel === 'read_only'
          ? tUi('sharing.access.readOnly')
          : null
  );

  const title = $derived(
    tUi('notifications.shareBundle.title')
      .replace(
        '{sender}',
        notification.data.senderUsername ??
          tUi('notifications.invite.senderFallback')
      )
      .replace('{name}', notification.data.name)
  );

  async function accept(event: MouseEvent) {
    event.stopPropagation();
    pending = true;
    error = null;
    try {
      await acceptShareBundle(notification.data.manifestCollectionUid);
      dismissNotification(notification.id);
      await loadTree();
      void scanForCollectionInviteNotifications();
      onClose?.();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      pending = false;
    }
  }

  async function decline(event: MouseEvent) {
    event.stopPropagation();
    pending = true;
    error = null;
    try {
      await declineShareBundle(notification.data.manifestCollectionUid);
      dismissNotification(notification.id);
      void scanForCollectionInviteNotifications();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      pending = false;
    }
  }

  function dismiss(event: MouseEvent) {
    event.stopPropagation();
    dismissNotification(notification.id);
  }
</script>

<div class="rounded-md px-3 py-2 hover:bg-accent/60">
  <div class="flex items-start gap-2">
    <Share2 class="mt-0.5 size-4 shrink-0 text-primary" />
    <div class="min-w-0 flex-1">
      <p class="text-sm font-medium">{title}</p>
      {#if accessLabel}
        <p class="mt-0.5 text-xs text-muted-foreground">{accessLabel}</p>
      {/if}
      {#if !notification.data.complete}
        <p class="mt-1 text-xs text-destructive">
          {tUi('notifications.shareBundle.incomplete')}
        </p>
      {/if}
      {#if error}
        <p class="mt-1 text-xs text-destructive">{error}</p>
      {/if}
      <div class="mt-2 flex items-center gap-1.5">
        <Button
          class="h-7 px-2 text-xs"
          size="sm"
          disabled={pending || !notification.data.complete}
          onclick={accept}
        >
          {tUi('notifications.invite.accept')}
        </Button>
        <Button
          class="h-7 px-2 text-xs"
          variant="ghost"
          size="sm"
          disabled={pending}
          onclick={decline}
        >
          {tUi('notifications.invite.decline')}
        </Button>
      </div>
    </div>
    <button
      type="button"
      class="rounded-md p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      use:tooltip={tUi('notifications.dismiss')}
      aria-label={tUi('notifications.dismiss')}
      onclick={dismiss}
    >
      <X class="size-3.5" />
    </button>
  </div>
</div>

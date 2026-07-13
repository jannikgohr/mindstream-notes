<script lang="ts">
  import { Share2, X } from '@lucide/svelte';
  import { tooltip } from '$lib/actions/tooltip';
  import { Button } from '$lib/components/ui/button';
  import {
    acceptCollectionInvitation,
    rejectCollectionInvitation
  } from '$lib/api/sharing';
  import { loadTree } from '$lib/stores/tree.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import {
    dismissNotification,
    scanForCollectionInviteNotifications
  } from './store.svelte';
  import type {
    AppNotification,
    CollaborationInviteNotificationData
  } from './types';

  interface Props {
    notification: AppNotification<CollaborationInviteNotificationData>;
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
        : tUi('sharing.access.readOnly')
  );

  async function accept(event: MouseEvent) {
    event.stopPropagation();
    pending = true;
    error = null;
    try {
      await acceptCollectionInvitation(notification.data.invitationId);
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

  async function reject(event: MouseEvent) {
    event.stopPropagation();
    pending = true;
    error = null;
    try {
      await rejectCollectionInvitation(notification.data.invitationId);
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
      <p class="text-sm font-medium">
        {tUi('notifications.invite.title').replace(
          '{sender}',
          notification.data.senderUsername ??
            tUi('notifications.invite.senderFallback')
        )}
      </p>
      <p class="mt-0.5 text-xs text-muted-foreground">
        {accessLabel} · {notification.data.collectionUid}
      </p>
      {#if error}
        <p class="mt-1 text-xs text-destructive">{error}</p>
      {/if}
      <div class="mt-2 flex items-center gap-1.5">
        <Button
          class="h-7 px-2 text-xs"
          size="sm"
          disabled={pending}
          onclick={accept}
        >
          {tUi('notifications.invite.accept')}
        </Button>
        <Button
          class="h-7 px-2 text-xs"
          variant="ghost"
          size="sm"
          disabled={pending}
          onclick={reject}
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

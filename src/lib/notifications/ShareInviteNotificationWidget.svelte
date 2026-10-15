<script lang="ts">
  import { Share2, TriangleAlert, X } from '@lucide/svelte';
  import { tooltip } from '$lib/actions/tooltip';
  import { Button } from '$lib/components/ui/button';
  import { acceptShare, declineShare } from '$lib/api/sharing';
  import { runSync } from '$lib/sync/runner';
  import { tUi, tUiFormat } from '$lib/settings/i18n.svelte';
  import { describeRefusal } from '$lib/account/refusal';
  import KeyFingerprint from '$lib/sharing/KeyFingerprint.svelte';
  import {
    dismissNotification,
    scanForShareInviteNotifications
  } from './store.svelte';
  import type { AppNotification, ShareInviteNotificationData } from './types';

  interface Props {
    notification: AppNotification<ShareInviteNotificationData>;
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

  const senderLabel = $derived(
    notification.data.senderUsername ??
      tUi('notifications.invite.senderFallback')
  );

  // The folder's name comes with the invitation. Only an older server
  // leaves it out, and then the invitation is shown without one.
  const title = $derived(
    notification.data.name === null
      ? tUi('notifications.shareInvite.untitled').replace(
          '{sender}',
          senderLabel
        )
      : tUi('notifications.shareInvite.title')
          .replace('{sender}', senderLabel)
          .replace('{name}', notification.data.name)
  );

  // The invitation comes from a key that is not the one this device
  // remembers for its sender. It can still be accepted, by someone who has
  // been shown that.
  const changedKey = $derived(
    notification.data.senderKey?.standing === 'changed'
      ? notification.data.senderKey
      : null
  );

  async function accept(event: MouseEvent) {
    event.stopPropagation();
    pending = true;
    error = null;
    try {
      await acceptShare(notification.data.invitationId, {
        trustChangedKey: changedKey !== null
      });
      dismissNotification(notification.id);
      // Accepting creates nothing here. The folder arrives with a sync, so
      // ask for one now and do not make the user wait for the next tick.
      void runSync().catch((err) => {
        console.debug('[notifications] sync after accepting a share', err);
      });
      void scanForShareInviteNotifications();
      onClose?.();
    } catch (err) {
      error = describeRefusal(err);
      // The key may have changed since this was listed. Listing again shows
      // it, with what to compare.
      void scanForShareInviteNotifications();
    } finally {
      pending = false;
    }
  }

  async function decline(event: MouseEvent) {
    event.stopPropagation();
    pending = true;
    error = null;
    try {
      await declineShare(notification.data.invitationId);
      dismissNotification(notification.id);
      void scanForShareInviteNotifications();
    } catch (err) {
      error = describeRefusal(err);
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
      <p class="mt-0.5 text-xs text-muted-foreground">{accessLabel}</p>
      {#if changedKey}
        <div
          class="mt-2 space-y-1.5 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs"
          data-testid="share-invite-key-changed"
        >
          <p class="flex items-start gap-1.5 font-medium text-destructive">
            <TriangleAlert class="mt-0.5 size-3.5 shrink-0" />
            <span>
              {tUiFormat('sharing.key.changed.sender', { name: senderLabel })}
            </span>
          </p>
          <p>{tUiFormat('sharing.key.compare', { name: senderLabel })}</p>
          <KeyFingerprint
            label={tUi('sharing.key.now')}
            value={changedKey.fingerprint}
          />
          {#if changedKey.known_fingerprint}
            <KeyFingerprint
              label={tUi('sharing.key.before')}
              value={changedKey.known_fingerprint}
            />
          {/if}
        </div>
      {/if}
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
          {tUi(
            changedKey
              ? 'notifications.invite.acceptAnyway'
              : 'notifications.invite.accept'
          )}
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

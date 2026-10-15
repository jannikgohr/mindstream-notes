<script lang="ts">
  /**
   * Joining a shared folder by an invite link.
   *
   * Two steps, so nobody joins something unseen: the pasted link is looked
   * at first, which shows who invites to what and with which rights, and
   * only then joined. Looking takes the link and nothing else. Joining
   * takes an account on the link's server.
   */
  import { Link, X } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import {
    claimShareLink,
    openShareLink,
    type ShareLinkPreview
  } from '$lib/api/sharing';
  import { describeRefusal, refusalReason } from '$lib/account/refusal';
  import { parseInviteLink, serverName } from '$lib/sharing/invite-link';
  import { runSync } from '$lib/sync/runner';
  import { tUi, tUiFormat } from '$lib/settings/i18n.svelte';
  import {
    closeJoinLinkDialog,
    joinLinkDialog
  } from './join-link-dialog.svelte';
  import { pushToast } from './toast.svelte';

  let link = $state(joinLinkDialog.link);
  let preview = $state<ShareLinkPreview | null>(null);
  let pending = $state(false);
  let error = $state<string | null>(null);

  const shaped = $derived(parseInviteLink(link) !== null);
  const accessLabel = $derived(
    preview?.access_level === 'read_write'
      ? tUi('sharing.access.readWrite')
      : tUi('sharing.access.readOnly')
  );
  const title = $derived(
    preview === null
      ? ''
      : preview.name === null
        ? tUiFormat('sharing.join.invitesUntitled', {
            sender: preview.sender_username
          })
        : tUiFormat('sharing.join.invites', {
            sender: preview.sender_username,
            name: preview.name
          })
  );

  /** A sentence for a refusal, with the one case this dialog knows better
   *  than the general wording: a link the server does not know. */
  function describe(err: unknown): string {
    return refusalReason(err) === 'does_not_exist'
      ? tUi('sharing.join.gone')
      : describeRefusal(err);
  }

  function edited() {
    // Another link is another question.
    preview = null;
    error = null;
  }

  async function look(event: SubmitEvent) {
    event.preventDefault();
    if (!shaped || pending) return;
    pending = true;
    error = null;
    try {
      preview = await openShareLink(link.trim());
    } catch (err) {
      console.error('[JoinLink] open failed', err);
      error = describe(err);
    } finally {
      pending = false;
    }
  }

  async function join() {
    if (preview === null || pending) return;
    pending = true;
    error = null;
    try {
      await claimShareLink(link.trim());
      pushToast(
        preview.name === null
          ? tUi('sharing.join.joinedUntitled')
          : tUiFormat('sharing.join.joined', { name: preview.name }),
        { variant: 'success' }
      );
      // Joining creates nothing here. The folder arrives with a sync.
      void runSync().catch((err) => {
        console.debug('[JoinLink] sync after joining', err);
      });
      closeJoinLinkDialog();
    } catch (err) {
      console.error('[JoinLink] claim failed', err);
      error = describe(err);
    } finally {
      pending = false;
    }
  }
</script>

<div
  class="fixed inset-0 z-400 flex items-center justify-center bg-scrim p-4"
  role="presentation"
  onclick={(event) => {
    if (event.target === event.currentTarget) closeJoinLinkDialog();
  }}
>
  <div
    class="w-full max-w-sm rounded-md border border-border bg-popover text-popover-foreground shadow-xl"
    role="dialog"
    aria-modal="true"
    aria-labelledby="join-link-title"
  >
    <header
      class="flex items-center justify-between border-b border-border px-4 py-3"
    >
      <div class="flex min-w-0 items-center gap-2">
        <Link class="size-4 shrink-0 text-primary" />
        <h2 id="join-link-title" class="truncate text-sm font-semibold">
          {tUi('sharing.join.title')}
        </h2>
      </div>
      <button
        type="button"
        class="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={tUi('close')}
        onclick={closeJoinLinkDialog}
      >
        <X class="size-4" />
      </button>
    </header>

    <div class="space-y-3 p-4">
      <form class="space-y-1.5" onsubmit={look}>
        <label class="block space-y-1.5">
          <span class="text-xs font-medium text-muted-foreground"
            >{tUi('sharing.join.linkLabel')}</span
          >
          <Input
            bind:value={link}
            autocomplete="off"
            spellcheck={false}
            placeholder={tUi('sharing.join.linkPlaceholder')}
            class="h-8"
            oninput={edited}
          />
        </label>
        {#if preview === null}
          <div class="flex justify-end">
            <Button size="sm" type="submit" disabled={!shaped || pending}>
              {tUi('sharing.join.look')}
            </Button>
          </div>
        {/if}
      </form>

      {#if preview !== null}
        <div
          class="space-y-1 rounded-md border border-border p-3"
          data-testid="join-link-preview"
        >
          <p class="text-sm font-medium">{title}</p>
          <p class="text-xs text-muted-foreground">
            {accessLabel} · {serverName(preview.server_url)}
          </p>
          {#if preview.already_member}
            <p class="text-xs">{tUi('sharing.join.alreadyMember')}</p>
          {:else if !preview.signed_in}
            <p class="text-xs">
              {tUiFormat('sharing.join.signInFirst', {
                server: serverName(preview.server_url)
              })}
            </p>
            {#if preview.can_signup}
              <p class="text-xs text-muted-foreground">
                {tUi('sharing.join.canSignup')}
              </p>
            {/if}
          {/if}
        </div>
        {#if preview.signed_in && !preview.already_member}
          <div class="flex justify-end">
            <Button size="sm" type="button" disabled={pending} onclick={join}>
              {tUi('sharing.join.join')}
            </Button>
          </div>
        {/if}
      {/if}

      {#if error}
        <p
          class="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
        >
          {error}
        </p>
      {/if}
    </div>
  </div>
</div>

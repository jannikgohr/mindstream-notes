<script lang="ts">
  import { Settings2, Share2, X } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import {
    inviteCollection,
    type CollectionShareAccessLevel
  } from '$lib/api/sharing';
  import { loadTree, tree } from '$lib/stores/tree.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import {
    closeCollectionShareDialog,
    setShareDialogView,
    shareDialog
  } from './share-dialog.svelte';
  import { parseRecipients } from './share-recipients';
  import { pushToast } from './toast.svelte';

  interface InviteFailure {
    username: string;
    reason: string;
  }

  let username = $state('');
  let accessLevel = $state<CollectionShareAccessLevel>('read_write');
  let pending = $state(false);
  let error = $state<string | null>(null);
  /** Per-recipient invite failures from the last submit (best-effort batch:
   *  the valid recipients still get invited, these are the ones that didn't). */
  let failures = $state<InviteFailure[]>([]);

  const recipients = $derived(parseRecipients(username));

  const collectionId = $derived(shareDialog.collectionId);
  const collection = $derived(
    collectionId ? tree.collectionsById[collectionId] : null
  );
  // Once a folder is shared, offer the switch to the manage-access view.
  const alreadyShared = $derived(collection?.shared_by_me === true);

  /**
   * Invite every recipient in the field (comma-separated) at the chosen access
   * level. Best-effort: each invite is independent, so a typo in one name never
   * blocks the others — the backend already resolves each recipient's profile
   * before creating anything, so an unknown username fails that one invite
   * without leaving a broken share behind.
   *
   * On completion: a success toast names everyone invited, the field is
   * rewritten to hold only the names that FAILED (so the user can fix and
   * resubmit without retyping the whole list), and those failures are listed
   * inline with the backend's reason for each.
   */
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    const targets = recipients;
    if (!collectionId || targets.length === 0) return;

    pending = true;
    error = null;
    failures = [];

    const invited: string[] = [];
    const failed: InviteFailure[] = [];

    for (const recipient of targets) {
      try {
        await inviteCollection({
          collection_id: collectionId,
          username: recipient,
          access_level: accessLevel
        });
        invited.push(recipient);
      } catch (err) {
        failed.push({
          username: recipient,
          reason: err instanceof Error ? err.message : String(err)
        });
      }
    }

    // Only a successful invite mutates the share (new member, re-homed subtree),
    // so refresh the tree only when at least one landed.
    if (invited.length > 0) {
      await loadTree();
      pushToast(
        tUi('sharing.toast.invited').replace('{names}', invited.join(', ')),
        { variant: 'success' }
      );
    }

    failures = failed;
    // Keep the failed names for a quick retry; clear the field on a clean run.
    username = failed.map((f) => f.username).join(', ');
    pending = false;
  }
</script>

{#if collectionId}
  <div
    class="fixed inset-0 z-400 flex items-center justify-center bg-black/35 p-4"
    role="presentation"
    onclick={(event) => {
      if (event.target === event.currentTarget) closeCollectionShareDialog();
    }}
  >
    <div
      class="w-full max-w-sm rounded-md border border-border bg-popover text-popover-foreground shadow-xl"
      role="dialog"
      aria-modal="true"
      aria-labelledby="share-collection-title"
    >
      <header
        class="flex items-center justify-between border-b border-border px-4 py-3"
      >
        <div class="flex min-w-0 items-center gap-2">
          <Share2 class="size-4 shrink-0 text-primary" />
          <h2
            id="share-collection-title"
            class="truncate text-sm font-semibold"
          >
            {tUi('sharing.dialog.title').replace(
              '{name}',
              collection?.name ?? tUi('sharing.dialog.folderFallback')
            )}
          </h2>
        </div>
        <button
          type="button"
          class="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={tUi('close')}
          onclick={closeCollectionShareDialog}
        >
          <X class="size-4" />
        </button>
      </header>

      <form class="space-y-3 p-4" onsubmit={submit}>
        <label class="block space-y-1.5">
          <span class="text-xs font-medium text-muted-foreground"
            >{tUi('sharing.dialog.userLabel')}</span
          >
          <Input
            bind:value={username}
            autocomplete="off"
            placeholder={tUi('sharing.dialog.userPlaceholder')}
            class="h-8"
          />
          <span class="block text-xs text-muted-foreground">
            {tUi('sharing.dialog.userHint')}
          </span>
        </label>

        <label class="block space-y-1.5">
          <span class="text-xs font-medium text-muted-foreground"
            >{tUi('sharing.dialog.permissionLabel')}</span
          >
          <select
            bind:value={accessLevel}
            class="h-8 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="read_only">{tUi('sharing.access.readOnly')}</option>
            <option value="read_write">{tUi('sharing.access.readWrite')}</option
            >
            <option value="admin">{tUi('sharing.access.admin')}</option>
          </select>
        </label>

        {#if error}
          <p
            class="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
          >
            {error}
          </p>
        {/if}

        {#if failures.length > 0}
          <div
            class="space-y-1 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
          >
            <p class="font-medium">
              {tUi('sharing.dialog.inviteFailedHeading')}
            </p>
            <ul class="space-y-0.5">
              {#each failures as failure (failure.username)}
                <li>
                  <span class="font-medium">{failure.username}</span> — {failure.reason}
                </li>
              {/each}
            </ul>
          </div>
        {/if}

        <div class="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onclick={closeCollectionShareDialog}
          >
            {tUi('sharing.dialog.cancel')}
          </Button>
          <Button
            size="sm"
            type="submit"
            disabled={pending || recipients.length === 0}
          >
            {tUi('sharing.dialog.invite')}
          </Button>
        </div>
      </form>

      {#if alreadyShared}
        <div class="border-t border-border px-4 py-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            class="gap-1.5"
            onclick={() => setShareDialogView('access')}
          >
            <Settings2 class="size-3.5" />
            {tUi('sharing.dialog.toManage')}
          </Button>
        </div>
      {/if}
    </div>
  </div>
{/if}

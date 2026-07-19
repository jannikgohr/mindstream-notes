<script lang="ts">
  import { onMount } from 'svelte';
  import { Users, UserMinus, UserPlus, X } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import {
    getCollectionShareState,
    listCollectionMembers,
    removeCollectionMember,
    setCollectionMemberAccess,
    type CollectionMember,
    type CollectionShareAccessLevel,
    type CollectionShareState
  } from '$lib/api/sharing';
  import { authSession } from '$lib/api/auth.svelte';
  import { tree } from '$lib/stores/tree.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import {
    closeCollectionShareDialog,
    setShareDialogView,
    shareDialog
  } from './share-dialog.svelte';
  import { confirm } from './confirm-dialog.svelte';
  import { pushToast } from './toast.svelte';

  let members = $state<CollectionMember[]>([]);
  let shareState = $state<CollectionShareState | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  /** Username currently being mutated, so its row controls disable in flight. */
  let busy = $state<string | null>(null);

  const collectionId = $derived(shareDialog.collectionId);
  const collection = $derived(
    collectionId ? tree.collectionsById[collectionId] : null
  );
  // Only the owner can change levels / remove people.
  const canManage = $derived(shareState?.shared_by_me === true);
  const myUsername = $derived(authSession.current?.username ?? null);

  function isSelf(username: string): boolean {
    return (
      myUsername !== null && username.toLowerCase() === myUsername.toLowerCase()
    );
  }

  function accessLabel(level: CollectionShareAccessLevel): string {
    if (level === 'admin') return tUi('sharing.access.admin');
    if (level === 'read_write') return tUi('sharing.access.readWrite');
    return tUi('sharing.access.readOnly');
  }

  async function refresh() {
    if (!collectionId) return;
    loading = true;
    error = null;
    try {
      const [state, list] = await Promise.all([
        getCollectionShareState(collectionId),
        listCollectionMembers(collectionId)
      ]);
      shareState = state;
      members = list;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  async function changeAccess(
    username: string,
    accessLevel: CollectionShareAccessLevel
  ) {
    if (!collectionId) return;
    busy = username;
    try {
      await setCollectionMemberAccess({
        collection_id: collectionId,
        username,
        access_level: accessLevel
      });
      await refresh();
    } catch (err) {
      console.error('[ManageAccess] change access failed', username, err);
      pushToast(tUi('sharing.access.changeFailed'), { variant: 'error' });
    } finally {
      busy = null;
    }
  }

  async function remove(username: string) {
    if (!collectionId) return;
    if (
      !(await confirm({
        title: tUi('sharing.access.removeConfirm.title'),
        message: tUi('sharing.access.removeConfirm.message').replace(
          '{name}',
          username
        ),
        confirmLabel: tUi('sharing.access.removeConfirm.confirm'),
        destructive: true
      }))
    ) {
      return;
    }
    busy = username;
    try {
      await removeCollectionMember({ collection_id: collectionId, username });
      await refresh();
    } catch (err) {
      console.error('[ManageAccess] remove member failed', username, err);
      pushToast(tUi('sharing.access.removeFailed'), { variant: 'error' });
    } finally {
      busy = null;
    }
  }

  onMount(() => {
    void refresh();
  });
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
      aria-labelledby="manage-access-title"
    >
      <header
        class="flex items-center justify-between border-b border-border px-4 py-3"
      >
        <div class="flex min-w-0 items-center gap-2">
          <Users class="size-4 shrink-0 text-primary" />
          <h2 id="manage-access-title" class="truncate text-sm font-semibold">
            {tUi('sharing.access.dialogTitle').replace(
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

      <div class="p-4">
        {#if loading}
          <p class="text-xs text-muted-foreground">{tUi('fileTree.loading')}</p>
        {:else if error}
          <p
            class="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
          >
            {tUi('sharing.access.loadFailed')}
          </p>
        {:else if members.length === 0}
          <p class="text-xs text-muted-foreground">
            {tUi('sharing.access.empty')}
          </p>
        {:else}
          <ul class="space-y-2">
            {#each members as member (member.username)}
              {@const self = isSelf(member.username)}
              <li class="flex items-center gap-2 text-sm">
                <span class="min-w-0 flex-1 truncate">
                  {member.username}
                  {#if self}
                    <span class="text-muted-foreground"
                      >({tUi('sharing.access.you')})</span
                    >
                  {/if}
                </span>
                {#if canManage && !self}
                  <select
                    class="h-7 rounded-md border border-input bg-background px-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                    value={member.access_level}
                    disabled={busy === member.username}
                    onchange={(e) =>
                      void changeAccess(
                        member.username,
                        e.currentTarget.value as CollectionShareAccessLevel
                      )}
                  >
                    <option value="read_only"
                      >{tUi('sharing.access.readOnly')}</option
                    >
                    <option value="read_write"
                      >{tUi('sharing.access.readWrite')}</option
                    >
                    <option value="admin">{tUi('sharing.access.admin')}</option>
                  </select>
                  <button
                    type="button"
                    class="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                    disabled={busy === member.username}
                    aria-label={tUi('sharing.access.remove')}
                    title={tUi('sharing.access.remove')}
                    onclick={() => void remove(member.username)}
                  >
                    <UserMinus class="size-3.5" />
                  </button>
                {:else}
                  <span class="shrink-0 text-xs text-muted-foreground">
                    {accessLabel(member.access_level)}
                  </span>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </div>

      <div class="flex items-center border-t border-border px-4 py-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          class="gap-1.5"
          onclick={() => setShareDialogView('invite')}
        >
          <UserPlus class="size-3.5" />
          {tUi('sharing.access.toInvite')}
        </Button>
      </div>
    </div>
  </div>
{/if}

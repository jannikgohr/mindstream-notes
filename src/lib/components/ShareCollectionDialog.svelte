<script lang="ts">
  import { onMount } from 'svelte';
  import { Share2, X } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import {
    getCollectionShareState,
    inviteCollection,
    type CollectionShareAccessLevel,
    type CollectionShareState
  } from '$lib/api/sharing';
  import { loadTree, tree } from '$lib/stores/tree.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import {
    closeCollectionShareDialog,
    shareDialog
  } from './share-dialog.svelte';

  let username = $state('');
  let accessLevel = $state<CollectionShareAccessLevel>('read_write');
  let pending = $state(false);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let shareState = $state<CollectionShareState | null>(null);

  const collectionId = $derived(shareDialog.collectionId);
  const collection = $derived(
    collectionId ? tree.collectionsById[collectionId] : null
  );

  async function refresh() {
    if (!collectionId) return;
    loading = true;
    error = null;
    try {
      shareState = await getCollectionShareState(collectionId);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!collectionId || !username.trim()) return;
    pending = true;
    error = null;
    try {
      shareState = await inviteCollection({
        collection_id: collectionId,
        username: username.trim(),
        access_level: accessLevel
      });
      username = '';
      await loadTree();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      pending = false;
    }
  }

  function accessLabel(level: CollectionShareAccessLevel): string {
    if (level === 'admin') return tUi('sharing.access.admin');
    if (level === 'read_write') return tUi('sharing.access.readWrite');
    return tUi('sharing.access.readOnly');
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
            autocomplete="username"
            placeholder={tUi('sharing.dialog.userPlaceholder')}
            class="h-8"
          />
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
            disabled={pending || !username.trim()}
          >
            {tUi('sharing.dialog.invite')}
          </Button>
        </div>
      </form>

      <div class="border-t border-border px-4 py-3">
        <p class="text-xs font-medium text-muted-foreground">
          {tUi('sharing.dialog.people')}
        </p>
        {#if loading}
          <p class="mt-2 text-xs text-muted-foreground">
            {tUi('fileTree.loading')}
          </p>
        {:else if shareState?.members.length}
          <ul class="mt-2 space-y-1">
            {#each shareState.members as member (member.username)}
              <li class="flex items-center justify-between gap-2 text-xs">
                <span class="truncate">{member.username}</span>
                <span class="shrink-0 text-muted-foreground">
                  {accessLabel(member.access_level)}
                </span>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="mt-2 text-xs text-muted-foreground">
            {tUi('sharing.dialog.onlyYou')}
          </p>
        {/if}
      </div>
    </div>
  </div>
{/if}

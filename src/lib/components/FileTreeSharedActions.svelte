<script lang="ts">
  /**
   * The action row of the Shared view, shaped like the create toolbar in
   * Home: a wide main button with icon buttons beside it. Signed in, the main
   * button starts a new shared folder and the link button joins one.
   * Sharing needs an account, so signed out the row offers sign-in instead.
   */
  import { FolderPlus, Link, LogIn } from '@lucide/svelte';
  import { authSession } from '$lib/api/auth.svelte';
  import { Button } from '$lib/components/ui/button';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { openSettings } from '$lib/settings/store.svelte';
  import { FILE_TREE_MAIN_ACTION_CLASS } from './file-tree-toolbar-preferences';
  import { openJoinLinkDialog } from './join-link-dialog.svelte';

  interface Props {
    /** Start the inline name field for a new folder at the Shared root. */
    onNewSharedFolder: () => void;
  }

  let { onNewSharedFolder }: Props = $props();
</script>

{#if authSession.current}
  <div class="min-w-0 flex-1">
    <Button
      variant="ghost"
      size="sm"
      onclick={onNewSharedFolder}
      title={tUi('sharing.newFolder.action')}
      class={FILE_TREE_MAIN_ACTION_CLASS}
    >
      <FolderPlus class="size-3.5" />
      <span class="min-w-0 truncate">{tUi('sharing.newFolder.action')}</span>
    </Button>
  </div>
  <Button
    variant="ghost"
    size="icon"
    onclick={() => openJoinLinkDialog()}
    title={tUi('sharing.menu.joinByLink')}
    aria-label={tUi('sharing.menu.joinByLink')}
    class="size-7 shrink-0 text-muted-foreground"
  >
    <Link class="size-3.5" />
  </Button>
{:else}
  <Button
    variant="ghost"
    size="sm"
    onclick={() => openSettings('account')}
    title={tUi('sharing.signInToShare')}
    class={FILE_TREE_MAIN_ACTION_CLASS}
  >
    <LogIn class="size-3.5" />
    <span class="min-w-0 truncate">{tUi('sharing.signInToShare')}</span>
  </Button>
{/if}

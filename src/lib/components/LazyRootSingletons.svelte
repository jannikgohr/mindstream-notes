<script lang="ts">
  import { confirmQueue } from './confirm-dialog.svelte';
  import { exportResultQueue } from './export-result-dialog.svelte';
  import { importChoiceQueue } from './import-choice-dialog.svelte';
  import { importNotesQueue } from './import-notes-dialog.svelte';
  import { shortcutHelp } from '$lib/hotkeys/help.svelte';
  import { searchDialog } from '$lib/search/store.svelte';
  import { commandPalette } from '$lib/command-palette/store.svelte';
  import { updaterProgress } from '$lib/updater/progress.svelte';
  import { shareDialog } from './share-dialog.svelte';
  import { joinLinkDialog } from './join-link-dialog.svelte';
  import { toasts } from './toast.svelte';
  import { createLazyComponent } from './lazy-component.svelte';
  import PluginMenuHost from './PluginMenuHost.svelte';

  const ConfirmDialog = createLazyComponent({
    load: () => import('./ConfirmDialog.svelte'),
    when: () => confirmQueue.items.length > 0
  });

  const ImportChoiceDialog = createLazyComponent({
    load: () => import('./ImportChoiceDialog.svelte'),
    when: () => importChoiceQueue.items.length > 0
  });

  const ImportNotesDialog = createLazyComponent({
    load: () => import('./ImportNotesDialog.svelte'),
    when: () => importNotesQueue.items.length > 0
  });

  const ExportResultDialog = createLazyComponent({
    load: () => import('./ExportResultDialog.svelte'),
    when: () => exportResultQueue.items.length > 0
  });

  const UpdaterProgressDialog = createLazyComponent({
    load: () => import('$lib/updater/ProgressDialog.svelte'),
    when: () => updaterProgress.active
  });

  const ShortcutHelpDialog = createLazyComponent({
    load: () => import('./ShortcutHelpDialog.svelte'),
    when: () => shortcutHelp.open
  });

  const SearchDialog = createLazyComponent({
    load: () => import('$lib/search/SearchDialog.svelte'),
    when: () => searchDialog.open
  });

  const CommandPalette = createLazyComponent({
    load: () => import('$lib/command-palette/CommandPalette.svelte'),
    when: () => commandPalette.open
  });

  const ShareCollectionDialog = createLazyComponent({
    load: () => import('./ShareCollectionDialog.svelte'),
    when: () =>
      shareDialog.collectionId !== null && shareDialog.view === 'invite'
  });

  const JoinSharedFolderDialog = createLazyComponent({
    load: () => import('./JoinSharedFolderDialog.svelte'),
    when: () => joinLinkDialog.open
  });

  const ManageAccessDialog = createLazyComponent({
    load: () => import('./ManageAccessDialog.svelte'),
    when: () =>
      shareDialog.collectionId !== null && shareDialog.view === 'access'
  });

  const ToastHost = createLazyComponent({
    load: () => import('./ToastHost.svelte'),
    when: () => toasts.items.length > 0,
    // Retain the empty host so the last toast can finish its exit transition.
    keepMountedWhenInactive: true
  });
</script>

{#if ConfirmDialog.component}
  <ConfirmDialog.component />
{/if}
{#if ImportChoiceDialog.component}
  <ImportChoiceDialog.component />
{/if}
{#if ImportNotesDialog.component}
  <ImportNotesDialog.component />
{/if}
{#if ExportResultDialog.component}
  <ExportResultDialog.component />
{/if}
{#if UpdaterProgressDialog.component}
  <UpdaterProgressDialog.component />
{/if}
{#if ShortcutHelpDialog.component}
  <ShortcutHelpDialog.component />
{/if}
{#if SearchDialog.component}
  <SearchDialog.component />
{/if}
{#if CommandPalette.component}
  <CommandPalette.component />
{/if}
{#if ShareCollectionDialog.component}
  <ShareCollectionDialog.component />
{/if}
{#if ManageAccessDialog.component}
  <ManageAccessDialog.component />
{/if}
{#if JoinSharedFolderDialog.component}
  {#key joinLinkDialog.opened}
    <JoinSharedFolderDialog.component />
  {/key}
{/if}
{#if ToastHost.component}
  <ToastHost.component />
{/if}
<PluginMenuHost />

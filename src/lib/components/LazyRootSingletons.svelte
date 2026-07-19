<script lang="ts">
  import { confirmQueue } from './confirm-dialog.svelte';
  import { exportResultQueue } from './export-result-dialog.svelte';
  import { importChoiceQueue } from './import-choice-dialog.svelte';
  import { shortcutHelp } from '$lib/hotkeys/help.svelte';
  import { searchDialog } from '$lib/search/store.svelte';
  import { updaterProgress } from '$lib/updater/progress.svelte';
  import { shareDialog } from './share-dialog.svelte';
  import { toasts } from './toast.svelte';

  let ConfirmDialog = $state<any | null>(null);
  let ExportResultDialog = $state<any | null>(null);
  let ImportChoiceDialog = $state<any | null>(null);
  let UpdaterProgressDialog = $state<any | null>(null);
  let ShortcutHelpDialog = $state<any | null>(null);
  let SearchDialog = $state<any | null>(null);
  let ShareCollectionDialog = $state<any | null>(null);
  let ManageAccessDialog = $state<any | null>(null);
  let ToastHost = $state<any | null>(null);

  let confirmToken = 0;
  let exportToken = 0;
  let importToken = 0;
  let updaterToken = 0;
  let shortcutToken = 0;
  let searchToken = 0;
  let shareToken = 0;
  let manageToken = 0;
  let toastToken = 0;

  $effect(() => {
    const active = confirmQueue.items.length > 0;
    const token = ++confirmToken;
    if (!active) {
      ConfirmDialog = null;
      return;
    }
    void import('./ConfirmDialog.svelte').then((mod) => {
      if (token === confirmToken && confirmQueue.items.length > 0) {
        ConfirmDialog = mod.default;
      }
    });
  });

  $effect(() => {
    const active = importChoiceQueue.items.length > 0;
    const token = ++importToken;
    if (!active) {
      ImportChoiceDialog = null;
      return;
    }
    void import('./ImportChoiceDialog.svelte').then((mod) => {
      if (token === importToken && importChoiceQueue.items.length > 0) {
        ImportChoiceDialog = mod.default;
      }
    });
  });

  $effect(() => {
    const active = exportResultQueue.items.length > 0;
    const token = ++exportToken;
    if (!active) {
      ExportResultDialog = null;
      return;
    }
    void import('./ExportResultDialog.svelte').then((mod) => {
      if (token === exportToken && exportResultQueue.items.length > 0) {
        ExportResultDialog = mod.default;
      }
    });
  });

  $effect(() => {
    const active = updaterProgress.active;
    const token = ++updaterToken;
    if (!active) {
      UpdaterProgressDialog = null;
      return;
    }
    void import('$lib/updater/ProgressDialog.svelte').then((mod) => {
      if (token === updaterToken && updaterProgress.active) {
        UpdaterProgressDialog = mod.default;
      }
    });
  });

  $effect(() => {
    const active = shortcutHelp.open;
    const token = ++shortcutToken;
    if (!active) {
      ShortcutHelpDialog = null;
      return;
    }
    void import('./ShortcutHelpDialog.svelte').then((mod) => {
      if (token === shortcutToken && shortcutHelp.open) {
        ShortcutHelpDialog = mod.default;
      }
    });
  });

  $effect(() => {
    const active = searchDialog.open;
    const token = ++searchToken;
    if (!active) {
      SearchDialog = null;
      return;
    }
    void import('$lib/search/SearchDialog.svelte').then((mod) => {
      if (token === searchToken && searchDialog.open) {
        SearchDialog = mod.default;
      }
    });
  });

  $effect(() => {
    const active =
      shareDialog.collectionId !== null && shareDialog.view === 'invite';
    const token = ++shareToken;
    if (!active) {
      ShareCollectionDialog = null;
      return;
    }
    void import('./ShareCollectionDialog.svelte').then((mod) => {
      if (
        token === shareToken &&
        shareDialog.collectionId !== null &&
        shareDialog.view === 'invite'
      ) {
        ShareCollectionDialog = mod.default;
      }
    });
  });

  $effect(() => {
    const active =
      shareDialog.collectionId !== null && shareDialog.view === 'access';
    const token = ++manageToken;
    if (!active) {
      ManageAccessDialog = null;
      return;
    }
    void import('./ManageAccessDialog.svelte').then((mod) => {
      if (
        token === manageToken &&
        shareDialog.collectionId !== null &&
        shareDialog.view === 'access'
      ) {
        ManageAccessDialog = mod.default;
      }
    });
  });

  $effect(() => {
    const active = toasts.items.length > 0;
    const token = ++toastToken;
    if (!active) {
      // Keep the host mounted through the fade-out of the last toast: unmounting
      // the moment the array empties would cut its exit transition. The store
      // has already removed the item, so an empty host renders nothing.
      return;
    }
    void import('./ToastHost.svelte').then((mod) => {
      if (token === toastToken && toasts.items.length > 0) {
        ToastHost = mod.default;
      }
    });
  });
</script>

{#if ConfirmDialog}
  <ConfirmDialog />
{/if}
{#if ImportChoiceDialog}
  <ImportChoiceDialog />
{/if}
{#if ExportResultDialog}
  <ExportResultDialog />
{/if}
{#if UpdaterProgressDialog}
  <UpdaterProgressDialog />
{/if}
{#if ShortcutHelpDialog}
  <ShortcutHelpDialog />
{/if}
{#if SearchDialog}
  <SearchDialog />
{/if}
{#if ShareCollectionDialog}
  <ShareCollectionDialog />
{/if}
{#if ManageAccessDialog}
  <ManageAccessDialog />
{/if}
{#if ToastHost}
  <ToastHost />
{/if}

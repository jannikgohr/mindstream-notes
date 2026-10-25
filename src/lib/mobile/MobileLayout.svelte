<script lang="ts">
  /**
   * Mobile shell.
   *
   *   Home screen      → top bar (vault tile, search, notifications,
   *                      settings)
   *                    → one row: folder breadcrumb, sort, list/grid
   *                    → note list / grid for the active bucket
   *                    → create bar (default kind, pinned kinds, menu)
   *                    → bottom nav (Home / Shared / Favourites / Trash)
   *
   *   Editor screen    → MobileEditor (its own header, no FAB/nav)
   *
   * Screen switching is driven by `mobileState.screen`; tapping a note
   * flips it to 'editor', the editor's back arrow flips it back. The
   * shared `ui.activeNoteId` carries which note is open.
   *
   * The shell wraps everything in safe-area padding so it doesn't paint
   * under the Android status bar or gesture bar with edge-to-edge on.
   */
  import { onMount } from 'svelte';
  import { isTauri } from '$lib/api/core';
  import { nativeDeviceUi } from '$lib/native-device-ui.svelte';
  import {
    Feather,
    FilePlus2,
    FileText,
    FileUp,
    FolderPlus,
    PencilRuler,
    SquareKanban
  } from '@lucide/svelte';
  import { noteTypeEnabled } from '$lib/notes/note-types';
  import {
    CORE_FILE_TREE_ACTION_IDS,
    loadFileTreeToolbarPreferences,
    moveFileTreeToolbarAction,
    normalizeFileTreeToolbarPreferences,
    saveFileTreeToolbarPreferences,
    type CoreFileTreeActionId
  } from '$lib/components/file-tree-toolbar-preferences';
  import { templateMenuEntries, runTemplateEntry } from '$lib/plugins/menu';
  import { visiblePluginToolbarButtons } from '$lib/plugins/toolbar-visibility.svelte';
  import { pluginToolbarButtons } from '$lib/plugins/registry.svelte';
  import { resolvePluginString } from '$lib/plugins/plugin-i18n';
  import { runPluginButton } from '$lib/plugins/effects';
  import type { IconComponent } from '$lib/settings/icons';
  import MobileTopBar from './MobileTopBar.svelte';
  import MobileBreadcrumb from './MobileBreadcrumb.svelte';
  import MobileToolbar from './MobileToolbar.svelte';
  import MobileNoteList from './MobileNoteList.svelte';
  import { mobileBatchSelection } from './state.svelte';
  import MobileFab from './MobileFab.svelte';
  import type { FabAction, FabSection } from './MobileFab.svelte';
  import MobileBottomNav from './MobileBottomNav.svelte';
  import MobileEditor from './MobileEditor.svelte';
  import LazyMobileSettingsDialog from './LazyMobileSettingsDialog.svelte';
  import NameInputSheet from './NameInputSheet.svelte';
  import {
    createCollectionIn,
    createNoteIn,
    importPdfIn,
    loadTree,
    tree
  } from '$lib/stores/tree.svelte';
  import { subscribeOpenNoteRequest } from '$lib/stores/open-note-intent.svelte';
  import { takeOnboardingNote } from '$lib/onboarding/store.svelte';
  import { startPdfSearchIndexing } from '$lib/pdf/search-index-backfill';
  import { pruneHistoryOnStartup } from '$lib/history/retention';
  import { tUi } from '$lib/settings/i18n.svelte';
  import {
    installMobileHistoryNav,
    migrateLegacyFavourites,
    mobileState,
    navigateToEditor
  } from './state.svelte';

  $effect(() => {
    void nativeDeviceUi.revision;
    if (isTauri() && nativeDeviceUi.initialized)
      mobileState.displayMode = nativeDeviceUi.displayMode;
  });

  onMount(() => {
    const onboardingNote = takeOnboardingNote();
    if (onboardingNote) void loadTree().then(() => openNote(onboardingNote));
    if (!tree.ready) {
      void loadTree().then(() => migrateLegacyFavourites());
    } else {
      void migrateLegacyFavourites();
    }
    // Backfill PDF search text for un-indexed PDFs in the background so their
    // content is searchable without opening each one (see search-index-backfill).
    startPdfSearchIndexing();
    // Sweep note history past the user's retention window.
    void pruneHistoryOnStartup();
    // Install the browser-history shim so the Android system back
    // button pops into our `setMobileScreen('home')` path instead of
    // falling through WryActivity's `super.onBackPressed()` (which
    // would finish the activity and close the app). Returns the
    // unsubscribe — combined with the intent-bus unsubscribe via the
    // wrapper below so both cleanups run on unmount.
    const unsubHistory = installMobileHistoryNav();
    // Same intent-bus subscription as DesktopLayout — a wikilink click
    // in the open editor needs a way to ask the shell to surface a
    // different note. Mobile's "open" is just a screen switch + active
    // note swap; the editor's $effect tears down and re-mounts.
    const unsubIntent = subscribeOpenNoteRequest((id) => openNote(id));
    return () => {
      unsubHistory();
      unsubIntent();
    };
  });

  function openNote(id: string) {
    navigateToEditor(id);
  }

  // Notes/folders created in 'trash', 'shared', or 'favourite' don't have
  // a sensible parent — fall back to the root of the home view.
  function targetParent(): string | null {
    if (mobileState.view !== 'home') return null;
    return mobileState.currentFolderId;
  }

  // Tracks which create flow has its NameInputSheet open. null = no
  // sheet showing; commit lives in commitCreate().
  // 'drawing' creates a drawing canvas via createNoteIn(..., 'freeform').
  // 'ink' creates a handwritten note via createNoteIn(..., 'ink').
  let createPrompt = $state<
    'note' | 'drawing' | 'ink' | 'kanban' | 'folder' | null
  >(null);
  let pdfInput = $state<HTMLInputElement | null>(null);

  function createNote() {
    createPrompt = 'note';
  }

  function createDrawing() {
    createPrompt = 'drawing';
  }

  function createInk() {
    createPrompt = 'ink';
  }

  function createKanban() {
    createPrompt = 'kanban';
  }

  function createFolder() {
    createPrompt = 'folder';
  }

  function importPdf() {
    if (pdfInput) pdfInput.value = '';
    pdfInput?.click();
  }

  async function onPdfPicked(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const id = await importPdfIn(targetParent(), file);
    openNote(id);
  }

  async function commitCreate(name: string) {
    const kind = createPrompt;
    createPrompt = null;
    if (!kind) return;
    const parent = targetParent();
    if (
      kind === 'note' ||
      kind === 'drawing' ||
      kind === 'ink' ||
      kind === 'kanban'
    ) {
      const id = await createNoteIn(
        parent,
        name,
        kind === 'drawing'
          ? 'freeform'
          : kind === 'ink'
            ? 'ink'
            : kind === 'kanban'
              ? 'kanban'
              : 'markdown'
      );
      openNote(id);
    } else {
      await createCollectionIn(parent, name);
    }
  }

  // Mobile keeps its own layout, using the same action IDs as desktop.
  // The first enabled kind is the default main button, the
  // rest of the toolbar section are pinned quick buttons, and More is menu
  // only. Labels go through tUi() inside $derived so a language switch
  // refreshes them without a remount.
  const pluginCreateActions = $derived<FabAction[]>(
    visiblePluginToolbarButtons('file-tree').map(({ pluginId, button }) => ({
      id: `plugin:${pluginId}:${button.id}`,
      label: resolvePluginString(pluginId, button.labelKey ?? button.id),
      icon: FileText as unknown as IconComponent,
      pluginIcon: button.icon ? { pluginId, file: button.icon } : undefined,
      onSelect: (anchor) => {
        const rect = anchor.getBoundingClientRect();
        void runPluginButton(
          pluginId,
          button,
          { x: rect.left, y: rect.top },
          {
            defaultParentId: targetParent()
          }
        );
      }
    }))
  );
  const availableCreateIds = $derived([
    ...CORE_FILE_TREE_ACTION_IDS,
    ...pluginToolbarButtons('file-tree').map(
      ({ pluginId, button }) => `plugin:${pluginId}:${button.id}`
    )
  ]);
  let createOrder = $state(
    loadFileTreeToolbarPreferences(CORE_FILE_TREE_ACTION_IDS, 'mobile')
  );
  $effect(() => {
    void nativeDeviceUi.revision;
    if (!isTauri() || nativeDeviceUi.initialized)
      createOrder = loadFileTreeToolbarPreferences(
        availableCreateIds,
        'mobile'
      );
  });

  const createKinds = $derived<Record<CoreFileTreeActionId, FabAction | null>>({
    note: {
      id: 'note',
      label: tUi('fab.newNote'),
      icon: FilePlus2 as unknown as IconComponent,
      onSelect: createNote
    },
    folder: {
      id: 'folder',
      label: tUi('fab.newFolder'),
      icon: FolderPlus as unknown as IconComponent,
      onSelect: createFolder
    },
    drawing: noteTypeEnabled('freeform')
      ? {
          id: 'drawing',
          label: tUi('fab.newDrawing'),
          icon: PencilRuler as unknown as IconComponent,
          onSelect: createDrawing
        }
      : null,
    ink: noteTypeEnabled('ink')
      ? {
          id: 'ink',
          label: tUi('fab.newInk'),
          icon: Feather as unknown as IconComponent,
          onSelect: createInk
        }
      : null,
    kanban: noteTypeEnabled('kanban')
      ? {
          id: 'kanban',
          label: tUi('fab.newKanban'),
          icon: SquareKanban as unknown as IconComponent,
          onSelect: createKanban
        }
      : null,
    pdf: noteTypeEnabled('pdf')
      ? {
          id: 'pdf',
          label: tUi('fab.importPdf'),
          icon: FileUp as unknown as IconComponent,
          onSelect: importPdf
        }
      : null
  });

  const createActionMap = $derived(
    new Map(
      [...Object.values(createKinds), ...pluginCreateActions]
        .filter((action): action is FabAction => !!action)
        .map((action) => [action.id, action])
    )
  );
  const createActions = $derived(
    [...createOrder.toolbar, ...createOrder.more]
      .map((id) => createActionMap.get(id))
      .filter((action): action is FabAction => !!action)
  );

  // Templates (premade + user) create + open directly (auto-titled), so they
  // skip the name sheet the built-in kinds use.
  const templateActions = $derived<FabAction[]>(
    templateMenuEntries().map((entry) => ({
      id:
        entry.kind === 'plugin'
          ? `plugin-template:${entry.pluginId}:${entry.templateId}`
          : `user-template:${entry.noteId}`,
      label: entry.label,
      icon: FileText as unknown as IconComponent,
      onSelect: () => void runTemplateEntry(entry, targetParent())
    }))
  );

  // The bar section leads `createActions`; it always holds the default.
  const createBarCount = $derived(
    Math.max(
      1,
      createActions.filter((action) => createOrder.toolbar.includes(action.id))
        .length
    )
  );

  function saveCreateOrder(next: typeof createOrder) {
    createOrder = normalizeFileTreeToolbarPreferences(next, availableCreateIds);
    void saveFileTreeToolbarPreferences(createOrder, 'mobile');
  }

  /** Sort a kind: the bar section's first kind is the default. */
  function moveCreate(id: string, section: FabSection, beforeId?: string) {
    saveCreateOrder(
      moveFileTreeToolbarAction(createOrder, id, section, beforeId)
    );
  }

  /** Pin or unpin a kind: it moves between the toolbar section and More. */
  function togglePinnedCreate(id: string) {
    const pinned = createOrder.toolbar.includes(id);
    saveCreateOrder(
      moveFileTreeToolbarAction(createOrder, id, pinned ? 'more' : 'toolbar')
    );
  }

  // Hide create affordances when the active bucket isn't a place where
  // creating notes makes sense (favourites is a virtual filter, trash
  // is read-only, shared has no model yet).
  const fabVisible = $derived(
    mobileState.view === 'home' &&
      mobileState.screen === 'home' &&
      !mobileBatchSelection.active
  );

  const showHome = $derived(mobileState.screen === 'home');
</script>

<div data-app-shell class="safe-x flex h-full w-full flex-col">
  {#if showHome}
    <div class="safe-top flex shrink-0 flex-col bg-surface-0">
      <MobileTopBar />
    </div>

    <div class="relative flex min-h-0 flex-1 flex-col">
      <div class="flex shrink-0 items-center gap-2 px-3 pb-1 pt-1.5">
        <MobileBreadcrumb />
        <MobileToolbar />
      </div>
      <MobileNoteList onOpenNote={openNote} reserveFabSpace={fabVisible} />
      {#if fabVisible}
        <MobileFab
          actions={createActions}
          barCount={createBarCount}
          extras={templateActions}
          onMove={moveCreate}
          onTogglePin={togglePinnedCreate}
        />
      {/if}
    </div>

    <div class="safe-bottom shrink-0 bg-surface-0">
      <MobileBottomNav />
    </div>
  {:else}
    <div class="safe-top safe-bottom flex h-full w-full flex-col">
      <MobileEditor />
    </div>
  {/if}
</div>

{#if createPrompt === 'note'}
  <NameInputSheet
    title={tUi('fab.newNote')}
    placeholder={tUi('fab.placeholder.noteTitle')}
    submitLabel={tUi('fab.submit.create')}
    onSubmit={(n) => void commitCreate(n)}
    onClose={() => (createPrompt = null)}
  />
{:else if createPrompt === 'drawing'}
  <NameInputSheet
    title={tUi('fab.newDrawing')}
    placeholder={tUi('fab.placeholder.drawingTitle')}
    submitLabel={tUi('fab.submit.create')}
    onSubmit={(n) => void commitCreate(n)}
    onClose={() => (createPrompt = null)}
  />
{:else if createPrompt === 'ink'}
  <NameInputSheet
    title={tUi('fab.newInk')}
    placeholder={tUi('fab.placeholder.inkTitle')}
    submitLabel={tUi('fab.submit.create')}
    onSubmit={(n) => void commitCreate(n)}
    onClose={() => (createPrompt = null)}
  />
{:else if createPrompt === 'kanban'}
  <NameInputSheet
    title={tUi('fab.newKanban')}
    placeholder={tUi('fab.placeholder.kanbanTitle')}
    submitLabel={tUi('fab.submit.create')}
    onSubmit={(n) => void commitCreate(n)}
    onClose={() => (createPrompt = null)}
  />
{:else if createPrompt === 'folder'}
  <NameInputSheet
    title={tUi('fab.newFolder')}
    placeholder={tUi('fab.placeholder.folderName')}
    submitLabel={tUi('fab.submit.create')}
    onSubmit={(n) => void commitCreate(n)}
    onClose={() => (createPrompt = null)}
  />
{/if}

<LazyMobileSettingsDialog />

<input
  bind:this={pdfInput}
  class="hidden"
  type="file"
  accept="application/pdf,.pdf"
  onchange={(e) => void onPdfPicked(e)}
/>

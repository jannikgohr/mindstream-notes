<script lang="ts">
  /**
   * Mobile shell.
   *
   *   Home screen      → top bar (search + settings)
   *                    → breadcrumb of the current folder path
   *                    → sort + display-mode toolbar
   *                    → note list / grid for the active bucket
   *                    → FAB stack (new note + expandable plus)
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
  import { FilePlus2, FolderPlus, Pencil } from 'lucide-svelte';
  import type { IconComponent } from '$lib/settings/icons';
  import MobileTopBar from './MobileTopBar.svelte';
  import MobileBreadcrumb from './MobileBreadcrumb.svelte';
  import MobileToolbar from './MobileToolbar.svelte';
  import MobileNoteList from './MobileNoteList.svelte';
  import MobileFab, { type FabAction } from './MobileFab.svelte';
  import MobileBottomNav from './MobileBottomNav.svelte';
  import MobileEditor from './MobileEditor.svelte';
  import MobileSettingsDialog from './MobileSettingsDialog.svelte';
  import NameInputSheet from './NameInputSheet.svelte';
  import {
    createCollectionIn,
    createNoteIn,
    loadTree,
    tree
  } from '$lib/stores/tree.svelte';
  import { setActiveNote } from '$lib/state.svelte';
  import { subscribeOpenNoteRequest } from '$lib/stores/open-note-intent.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import {
    migrateLegacyFavourites,
    mobileState,
    setMobileScreen
  } from './state.svelte';

  onMount(() => {
    if (!tree.ready) {
      void loadTree().then(() => migrateLegacyFavourites());
    } else {
      void migrateLegacyFavourites();
    }
    // Same intent-bus subscription as DesktopLayout — a wikilink click
    // in the open editor needs a way to ask the shell to surface a
    // different note. Mobile's "open" is just a screen switch + active
    // note swap; the editor's $effect tears down and re-mounts.
    return subscribeOpenNoteRequest((id) => openNote(id));
  });

  function openNote(id: string) {
    setActiveNote(id);
    setMobileScreen('editor');
  }

  // Notes/folders created in 'trash', 'shared', or 'favourite' don't have
  // a sensible parent — fall back to the root of the home view.
  function targetParent(): string | null {
    if (mobileState.view !== 'home') return null;
    return mobileState.currentFolderId;
  }

  // Tracks which create flow has its NameInputSheet open. null = no
  // sheet showing; commit lives in commitCreate().
  // 'drawing' creates a freeform note via createNoteIn(..., 'freeform').
  let createPrompt = $state<'note' | 'drawing' | 'folder' | null>(null);

  function createNote() {
    createPrompt = 'note';
  }

  function createDrawing() {
    createPrompt = 'drawing';
  }

  function createFolder() {
    createPrompt = 'folder';
  }

  async function commitCreate(name: string) {
    const kind = createPrompt;
    createPrompt = null;
    if (!kind) return;
    const parent = targetParent();
    if (kind === 'note' || kind === 'drawing') {
      const id = await createNoteIn(
        parent,
        name,
        kind === 'drawing' ? 'freeform' : 'markdown'
      );
      openNote(id);
    } else {
      await createCollectionIn(parent, name);
    }
  }

  // Both actions resolve their labels via tUi() inside $derived so a
  // language switch refreshes the FAB without forcing a remount. The
  // primary action is $derived too (rather than a plain const) for the
  // same reason — its label feeds aria-label / tooltip on the button.
  const primaryAction = $derived<FabAction>({
    id: 'new-note',
    label: tUi('fab.newNote'),
    icon: FilePlus2 as unknown as IconComponent,
    onSelect: createNote
  });

  // Extend by appending FabAction entries here.
  const secondaryActions = $derived<FabAction[]>(
    mobileState.view === 'trash'
      ? []
      : [
          {
            id: 'new-drawing',
            label: tUi('fab.newDrawing'),
            icon: Pencil as unknown as IconComponent,
            onSelect: createDrawing
          },
          {
            id: 'new-folder',
            label: tUi('fab.newFolder'),
            icon: FolderPlus as unknown as IconComponent,
            onSelect: createFolder
          }
        ]
  );

  // Hide create affordances when the active bucket isn't a place where
  // creating notes makes sense (favourites is a virtual filter, trash
  // is read-only, shared has no model yet).
  const fabVisible = $derived(
    mobileState.view === 'home' && mobileState.screen === 'home'
  );

  const showHome = $derived(mobileState.screen === 'home');
</script>

<div class="safe-x flex h-full w-full flex-col">
  {#if showHome}
    <div class="safe-top flex shrink-0 flex-col bg-card">
      <MobileTopBar />
    </div>

    <div class="relative flex min-h-0 flex-1 flex-col">
      <MobileBreadcrumb />
      <MobileToolbar />
      <MobileNoteList onOpenNote={openNote} />
      {#if fabVisible}
        <MobileFab primary={primaryAction} actions={secondaryActions} />
      {/if}
    </div>

    <div class="safe-bottom shrink-0 bg-card">
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
{:else if createPrompt === 'folder'}
  <NameInputSheet
    title={tUi('fab.newFolder')}
    placeholder={tUi('fab.placeholder.folderName')}
    submitLabel={tUi('fab.submit.create')}
    onSubmit={(n) => void commitCreate(n)}
    onClose={() => (createPrompt = null)}
  />
{/if}

<MobileSettingsDialog />

<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { createMenuBuilder } from './file-explorer-menu';
  import {
    ChevronRight,
    Feather,
    FileText,
    Folder,
    FolderOpen,
    PencilRuler,
    Share2,
    Trash2
  } from '@lucide/svelte';
  import { authSession } from '$lib/api/auth.svelte';
  import FileTreeSharedActions from './FileTreeSharedActions.svelte';
  import { shareNewFolder } from './new-shared-folder';
  import FavouriteStar from './FavouriteStar.svelte';
  import NoteKindIcon from './NoteKindIcon.svelte';
  import { pluginToolbarButtons } from '$lib/plugins/registry.svelte';
  import {
    pluginTemplateDefaultTitle,
    pluginTemplateNoteKind,
    runPluginTemplate
  } from '$lib/plugins/menu';
  import { tooltip } from '$lib/actions/tooltip';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Separator } from '$lib/components/ui/separator';
  import { Surface } from '$lib/components/ui/surface';
  import ContextMenu from './ContextMenu.svelte';
  import type { MenuItem } from './context-menu-types';
  import { menuItemForShortcut } from './context-menu-shortcuts';
  import { alert, confirm } from './confirm-dialog.svelte';
  import SortControl from './SortControl.svelte';
  import TagFilterControl from './TagFilterControl.svelte';
  import VaultSwitcher from './VaultSwitcher.svelte';
  import PluginIcon from '$lib/plugins/PluginIcon.svelte';
  import PluginSidebarView from '$lib/plugins/PluginSidebarView.svelte';
  import { resolvePluginString } from '$lib/plugins/plugin-i18n';
  import { pluginSidebarViews } from '$lib/plugins/registry.svelte';
  import type { PluginSidebarViewRef } from '$lib/plugins/registry.svelte';
  import {
    sendSidebarViewAction,
    sidebarViewForSource,
    sidebarViewSource
  } from '$lib/plugins/sidebar-views';
  import FileTreeCreateToolbar from './FileTreeCreateToolbar.svelte';
  import {
    FILE_TREE_MAIN_ACTION_CLASS,
    type CoreFileTreeActionId
  } from './file-tree-toolbar-preferences';
  import {
    expandedFoldersToSave,
    loadExpandedFolders,
    saveExpandedFolders
  } from './file-tree-expansion';
  import { profilesState } from '$lib/stores/profiles.svelte';
  import { sortTree } from '$lib/sort';
  import {
    clearTagFilter,
    filterNodesByTags,
    tagFilter
  } from '$lib/stores/tag-filter.svelte';
  import {
    tree,
    createCollectionIn,
    createNoteIn,
    emptyTrash,
    importPdfIn,
    leaveSharedCollection,
    moveManyTo,
    renameCollection,
    renameNote,
    setNoteFavourite,
    stopSharingCollection
  } from '$lib/stores/tree.svelte';
  import { trashWithUndo } from './trash-with-undo';
  import { setSortDirection, setSortStrategy, ui } from '$lib/state.svelte';
  import { tUi, tUiFormat } from '$lib/settings/i18n.svelte';
  import type { TreeNode } from '$lib/api';
  import {
    collectionIsSharedByMe,
    collectionIsSharedRoot,
    collectionScopeIsReadOnly,
    itemSharedRootId,
    nodesForDesktopSource,
    noteIsUnderTrash,
    sharedFolderIsEditable,
    sharedMoveIsLegal,
    type DesktopNoteSource
  } from '$lib/stores/note-source.svelte';
  import { pushToast, dismissToast, updateToast } from './toast.svelte';
  import { toastRefusal } from '$lib/account/refusal';
  import { flushPendingEditorSaves } from '$lib/editor/suspend-flush';
  import {
    FILE_EXPLORER_SOURCES,
    defaultDraftText,
    dragPayloadFromTransfer,
    draftKindToNoteKind,
    draftHasName,
    emptyStateMessageForSource,
    dragItemsForStart,
    itemFromSelectionKey,
    nodeKey,
    selectedItemsFromKeys,
    selectionKeyForItem,
    treeDropEffect,
    updateSelectionForClick,
    visibleSelectionKeys,
    type Draft,
    type DraftKind,
    type Drag,
    type MenuTarget,
    type Rename,
    type SelectionKey,
    type TreeItemRef
  } from './file-explorer-helpers';
  import { toErrorMessage } from '$lib/api/errors';
  import { droppedPdfFiles, isFileDrag, PDF_ACCEPT } from '$lib/file-drop';
  import { importDroppedPdfs } from '$lib/file-drop-import';

  interface Props {
    source?: DesktopNoteSource;
    onSourceChange?: (source: DesktopNoteSource) => void;
    onOpenNote: (id: string) => void;
    /** A plain click on a note row. Falls back to `onOpenNote`. */
    onPreviewNote?: (id: string) => void;
    onOpenNoteRight?: (id: string) => void;
    onOpenNoteBelow?: (id: string) => void;
    onOpenInNewWindow?: (id: string) => void;
  }
  let {
    source = 'home',
    onSourceChange,
    onOpenNote,
    onPreviewNote,
    onOpenNoteRight,
    onOpenNoteBelow,
    onOpenInNewWindow
  }: Props = $props();

  let expanded = $state<Record<string, boolean>>({});

  // Open folders survive a restart. The saved list is read once the vault's
  // settings have loaded, and merged so that a folder opened before then
  // stays open. Saving waits for that read, or it would write over the list.
  let expansionRestored = $state(false);
  let lastSavedExpansion: string | null = null;
  $effect(() => {
    if (expansionRestored || !profilesState.loaded) return;
    const saved = loadExpandedFolders();
    for (const id of saved) expanded[id] = true;
    lastSavedExpansion = JSON.stringify(saved);
    expansionRestored = true;
  });
  $effect(() => {
    if (!expansionRestored || !tree.ready) return;
    const folders = new Set(Object.keys(tree.collectionsById));
    const ids = expandedFoldersToSave(expanded, (id) => folders.has(id));
    const value = JSON.stringify(ids);
    if (value === lastSavedExpansion) return;
    const timer = setTimeout(() => {
      lastSavedExpansion = value;
      saveExpandedFolders(ids).catch((err) =>
        console.warn('[file-tree] saving open folders failed', err)
      );
    }, 300);
    return () => clearTimeout(timer);
  });

  const sortedTree = $derived(
    sortTree(
      tree.tree,
      ui.sortStrategy,
      {
        notesById: tree.notesById,
        collectionsById: tree.collectionsById
      },
      ui.sortDirection
    )
  );

  const pluginView = $derived(sidebarViewForSource(source));
  // A disabled plugin takes its view with it; fall back to Home.
  $effect(() => {
    if (source.startsWith('plugin:') && !pluginView) onSourceChange?.('home');
  });

  const allSourceNodes = $derived(
    nodesForDesktopSource(
      source,
      sortedTree,
      tree.notesById,
      tree.collectionsById
    )
  );
  const sourceNodes = $derived(
    filterNodesByTags(allSourceNodes, tree.notesById, tagFilter.tags)
  );

  // Folders open while a tag filter is on, so its matches show. A folder
  // closed meanwhile stays closed until the filter changes; the saved open
  // folders are left alone.
  const filtering = $derived(tagFilter.tags.length > 0);
  const filterKey = $derived(tagFilter.tags.join('\n'));
  let closedWhileFiltering = $state<{
    key: string;
    ids: Record<string, true>;
  }>({ key: '', ids: {} });
  const openFolders = $derived.by(() => {
    if (!filtering) return expanded;
    const closed =
      closedWhileFiltering.key === filterKey ? closedWhileFiltering.ids : {};
    const open: Record<string, boolean> = {};
    const walk = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        if (node.kind !== 'folder') continue;
        if (!closed[node.id]) open[node.id] = true;
        walk(node.children);
      }
    };
    walk(sourceNodes);
    return open;
  });
  // Home-only gates: the top toolbar create buttons, the root-level draft, and
  // the drop-to-root target. None of these apply in the Shared view (you can't
  // create a new shared root, and a root drop = pulling an item out of its share
  // into your vault, which is out of scope here).
  const canCreate = $derived(source === 'home');
  // Favourites can create notes too, at the vault root, favourited on
  // creation so they land in the list being looked at. Folders can't be
  // favourited, so that view offers note types only.
  const canCreateNotes = $derived(source === 'home' || source === 'favourites');
  const canReorganize = $derived(source === 'home');
  // Dropped PDFs import into the folder under the pointer, in Home only: the
  // other views fall through to the window-level import at the vault root.
  const fileDropAccept = $derived(canCreate ? PDF_ACCEPT : undefined);
  // Emptying the trash removes everything in it, filtered out or not.
  const trashItemCount = $derived(
    source === 'trash' ? allSourceNodes.length : 0
  );

  // ---------- Per-scope edit capabilities (Shared view) ----------
  // In Home everything is editable as before. In the Shared view an item is only
  // editable when it lives inside a shared root the user received at read_write /
  // admin (see collectionScopeIsReadOnly); read-only scopes stay locked. The
  // shared *root anchor* itself can't be renamed/deleted/moved by a recipient —
  // only its contents — so structural ops exclude it (collectionIsSharedRoot).
  function sharedItemEditable(item: TreeItemRef): boolean {
    const root = itemSharedRootId(item, tree.notesById, tree.collectionsById);
    return !!root && !collectionScopeIsReadOnly(root, tree.collectionsById);
  }
  function isSharedAnchor(folderId: string): boolean {
    const folder = tree.collectionsById[folderId];
    return folder
      ? collectionIsSharedRoot(folder, tree.collectionsById)
      : false;
  }
  /** Can this note/folder be renamed / deleted in the current source? */
  function itemEditable(item: TreeItemRef): boolean {
    if (source === 'home') return true;
    if (source !== 'shared') return false;
    return sharedItemEditable(item);
  }
  /** Can this note/folder be dragged in the current source? */
  function canDragItem(item: TreeItemRef): boolean {
    if (source === 'home') return canReorganize;
    if (source !== 'shared') return false;
    if (item.kind === 'folder' && isSharedAnchor(item.id)) return false;
    return sharedItemEditable(item);
  }
  /** Can a new note/folder be created inside `parentId`? */
  function canStartDraft(parentId: string | null): boolean {
    if (source === 'home') return true;
    if (source === 'favourites') return parentId === null;
    if (source !== 'shared') return false;
    // The root of Shared takes one thing: a new folder to share.
    if (parentId === null) return !!authSession.current;
    return (
      parentId !== null &&
      sharedFolderIsEditable(parentId, tree.collectionsById)
    );
  }

  // ---------- Inline draft entry (replaces window.prompt) ----------
  // 'note' = markdown note, 'drawing' = freeform note, 'ink' =
  // native ink note. They share the draft / commit code path because
  // the only difference at the data layer is the note_kind we pass to
  // createNoteIn; the UX (inline input for the title) is identical.
  let draft = $state<Draft | null>(null);
  let rename = $state<Rename | null>(null);
  let nameInput = $state<HTMLInputElement | null>(null);
  let pdfInput = $state<HTMLInputElement | null>(null);
  let pdfImportParentId = $state<string | null>(null);
  let emptyTrashPending = $state(false);
  let emptyTrashAnimation = $state(0);
  let emptyTrashParticleCount = $state(0);
  let explorerRoot = $state<HTMLElement | null>(null);
  let treeEl = $state<HTMLElement | null>(null);
  let selectedKeys = $state<SelectionKey[]>([]);
  let selectionAnchor = $state<SelectionKey | null>(null);
  let activeKey = $state<SelectionKey | null>(null);

  const selectedKeySet = $derived(new Set(selectedKeys));
  const selectedCount = $derived(selectedKeys.length);
  let selectedSource = $state<DesktopNoteSource | null>(null);

  function clearFileTreeInteractionState(blurFocusedControl = false) {
    selectedKeys = [];
    selectionAnchor = null;
    activeKey = null;
    if (!blurFocusedControl || !explorerRoot) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && explorerRoot.contains(active)) {
      active.blur();
    }
  }

  $effect(() => {
    if (!nameInput) return;
    queueMicrotask(() => {
      nameInput?.focus();
      nameInput?.select();
    });
  });

  $effect(() => {
    if (selectedSource === null) {
      selectedSource = source;
      return;
    }
    if (selectedSource === source) return;
    selectedSource = source;
    clearFileTreeInteractionState();
  });

  function startDraft(kind: DraftKind, parentId: string | null) {
    if (!canStartDraft(parentId)) return;
    if (parentId) expanded[parentId] = true;
    const text = defaultDraftText(kind);
    draft = {
      kind,
      parentId,
      text,
      initialText: text,
      favourite: source === 'favourites' || undefined,
      share: (source === 'shared' && parentId === null) || undefined
    };
  }
  // Name-first creation of a plugin-template note (e.g. a Typst document): seed
  // the inline draft with the template's default title, then render + create on
  // commit with the typed name (see commitDraft).
  function startPluginTemplateDraft(
    pluginId: string,
    templateId: string,
    parentId: string | null
  ) {
    if (!canStartDraft(parentId)) return;
    if (parentId) expanded[parentId] = true;
    const text = pluginTemplateDefaultTitle(pluginId, templateId);
    draft = {
      kind: 'note',
      parentId,
      text,
      initialText: text,
      template: {
        pluginId,
        templateId,
        noteKind: pluginTemplateNoteKind(pluginId, templateId) ?? 'markdown'
      }
    };
  }
  let pdfImportFavourite = false;
  function startPdfImport(parentId: string | null) {
    if (!canStartDraft(parentId)) return;
    pdfImportParentId = parentId;
    pdfImportFavourite = source === 'favourites';
    if (pdfInput) pdfInput.value = '';
    pdfInput?.click();
  }
  async function onPdfPicked(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const id = await importPdfIn(pdfImportParentId, file);
    pdfImportParentId = null;
    if (pdfImportFavourite) await setNoteFavourite(id, true);
    onOpenNote(id);
  }
  function cancelDraft() {
    draft = null;
  }
  async function commitDraft() {
    if (!draft) return;
    const text = draft.text.trim();
    if (!text) {
      draft = null;
      return;
    }
    const { kind, parentId, template, favourite, share } = draft;
    draft = null;
    if (template) {
      // The template renderer creates the note (of its plugin note kind) with
      // the typed title and opens it per the plugin's open-on-create setting.
      await runPluginTemplate(
        template.pluginId,
        template.templateId,
        parentId,
        text
      );
      return;
    }
    const noteKind = draftKindToNoteKind(kind);
    if (noteKind) {
      const id = await createNoteIn(parentId, text, noteKind);
      if (favourite) await setNoteFavourite(id, true);
      onOpenNote(id);
    } else {
      const id = await createCollectionIn(parentId, text);
      if (share) shareNewFolder(id, text);
    }
  }
  function onDraftKey(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commitDraft();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelDraft();
    }
  }
  function onDraftBlur() {
    setTimeout(() => {
      if (!draft) return;
      if (!draftHasName(draft)) cancelDraft();
      else void commitDraft();
    }, 0);
  }

  function startRename(kind: 'note' | 'folder', id: string, current: string) {
    rename = { kind, id, new_name: current };
  }
  function cancelRename() {
    rename = null;
  }
  async function commitRename() {
    if (!rename) return;
    const next = rename.new_name.trim();
    if (!next) {
      rename = null;
      return;
    }
    const { kind, id } = rename;
    rename = null;
    if (kind === 'note') await renameNote(id, next);
    else await renameCollection(id, next);
  }
  function onRenameKey(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commitRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelRename();
    }
  }
  function onRenameBlur() {
    setTimeout(() => {
      if (!rename) return;
      if (!rename.new_name.trim()) cancelRename();
      else void commitRename();
    }, 0);
  }

  // ---------- Context menu ----------
  let menuOpen = $state(false);
  let menuX = $state(0);
  let menuY = $state(0);
  let currentMenuItems = $state<(MenuItem | 'separator')[]>([]);
  let menuToken = 0;

  async function openMenu(e: MouseEvent, target: MenuTarget) {
    e.preventDefault();
    e.stopPropagation();
    selectTargetForContextMenu(target);
    const token = ++menuToken;
    const batchItems = selectedItemsForTarget(target);
    // What the root offers where nothing can be created is the builder's
    // call: nothing in most views, joining by a link in the shared one.
    const items =
      batchItems.length > 1
        ? await menuItemsForBatch(batchItems)
        : await menuItemsForTarget(target);
    if (token !== menuToken) return;
    if (items.length === 0) return;
    menuX = e.clientX;
    menuY = e.clientY;
    currentMenuItems = items;
    menuOpen = true;
  }
  function closeMenu() {
    menuToken += 1;
    menuOpen = false;
    currentMenuItems = [];
  }

  function runCreateToolbarAction(action: CoreFileTreeActionId) {
    if (action === 'pdf') startPdfImport(null);
    else startDraft(action, null);
  }

  const runningExports = new SvelteSet<string>();

  async function runNoteExporter(
    id: string,
    label: string,
    run: () => Promise<void>
  ) {
    const key = `${id}:${label}`;
    if (runningExports.has(key)) return;
    runningExports.add(key);
    const toast = pushToast(tUiFormat('fileTree.exporting', { label }), {
      variant: 'progress',
      durationMs: 0
    });
    try {
      await flushPendingEditorSaves();
      await run();
    } catch (err) {
      dismissToast(toast);
      console.error('[FileExplorer] note export failed', id, err);
      await alert({
        title: tUiFormat('fileTree.exportFailed', { label }),
        message: toErrorMessage(err)
      });
    } finally {
      dismissToast(toast);
      runningExports.delete(key);
    }
  }

  const convertingPdfs = new SvelteSet<string>();
  async function convertPdfNote(id: string) {
    if (convertingPdfs.has(id)) return;
    convertingPdfs.add(id);
    const toast = pushToast(tUi('ink.pdf.converting'), {
      variant: 'progress',
      durationMs: 0
    });
    try {
      await flushPendingEditorSaves();
      const { convertPdfToInk } = await import('$lib/ink/pdf-import');
      onOpenNote(
        await convertPdfToInk(id, (page, total) => {
          updateToast(
            toast,
            tUiFormat('ink.pages.rasterizing', { page, total })
          );
        })
      );
    } catch (error) {
      pushToast(toErrorMessage(error), { variant: 'error' });
    } finally {
      convertingPdfs.delete(id);
      dismissToast(toast);
    }
  }

  async function startEmptyTrash() {
    if (emptyTrashPending || trashItemCount === 0) return;
    if (
      await confirm({
        title: tUi('fileTree.emptyTrash'),
        message: tUiFormat('fileTree.confirm.emptyTrash', {
          count: trashItemCount
        }),
        confirmLabel: tUi('fileTree.emptyTrash'),
        destructive: true
      })
    ) {
      emptyTrashPending = true;
      try {
        const removed = await emptyTrash();
        const removedCount = removed.notes + removed.folders;
        if (removedCount > 0) {
          emptyTrashParticleCount = Math.min(removedCount, 6);
          emptyTrashAnimation += 1;
        }
      } finally {
        emptyTrashPending = false;
      }
    }
  }

  async function leaveShared(id: string) {
    const name =
      tree.collectionsById[id]?.name ?? tUi('sharing.dialog.folderFallback');
    if (
      !(await confirm({
        title: tUi('sharing.leave.title'),
        message: tUi('sharing.leave.message').replace('{name}', name),
        confirmLabel: tUi('sharing.leave.confirm'),
        destructive: true
      }))
    ) {
      return;
    }
    try {
      await leaveSharedCollection(id);
    } catch (err) {
      console.error('[FileExplorer] leave shared folder failed', id, err);
      pushToast(tUi('sharing.leave.failed'), { variant: 'error' });
    }
  }

  async function stopSharing(id: string) {
    const name =
      tree.collectionsById[id]?.name ?? tUi('sharing.dialog.folderFallback');
    if (
      !(await confirm({
        title: tUi('sharing.stop.title'),
        message: tUi('sharing.stop.message').replace('{name}', name),
        confirmLabel: tUi('sharing.stop.confirm'),
        destructive: true
      }))
    ) {
      return;
    }
    try {
      await stopSharingCollection(id);
    } catch (err) {
      console.error('[FileExplorer] stop sharing failed', id, err);
      pushToast(tUi('sharing.stop.failed'), { variant: 'error' });
    }
  }

  const menuBuilder = createMenuBuilder({
    get source() {
      return source;
    },
    get sourceNodes() {
      return sourceNodes;
    },
    get expanded() {
      return expanded;
    },
    get selectedKeys() {
      return selectedKeys;
    },
    get selectedKeySet() {
      return selectedKeySet;
    },
    get selectedCount() {
      return selectedCount;
    },
    get selectionAnchor() {
      return selectionAnchor;
    },
    get activeKey() {
      return activeKey;
    },
    get canCreate() {
      return canCreate;
    },
    get canReorganize() {
      return canReorganize;
    },
    get emptyTrashPending() {
      return emptyTrashPending;
    },
    get trashItemCount() {
      return trashItemCount;
    },
    get rename() {
      return rename;
    },
    isSharedAnchor,
    sharedItemEditable,
    startDraft,
    startPluginTemplateDraft,
    startPdfImport,
    convertPdfNote,
    startRename,
    startEmptyTrash,
    leaveShared,
    stopSharing,
    runNoteExporter,
    // Getters: these are props, so the menu must read whatever the
    // explorer was handed most recently, not what it had at mount.
    get onOpenNote() {
      return onOpenNote;
    },
    get onOpenNoteRight() {
      return onOpenNoteRight;
    },
    get onOpenNoteBelow() {
      return onOpenNoteBelow;
    },
    get onOpenInNewWindow() {
      return onOpenInNewWindow;
    }
  });
  const { menuItemsForTarget, menuItemsForBatch } = menuBuilder;

  function selectNodeFromClick(e: MouseEvent, node: TreeNode): boolean {
    const key = nodeKey(node) as SelectionKey;
    const result = updateSelectionForClick(
      selectedKeys,
      key,
      visibleSelectionKeys(sourceNodes, openFolders),
      selectionAnchor,
      activeKey,
      {
        toggle: e.ctrlKey || e.metaKey,
        range: e.shiftKey
      }
    );
    selectedKeys = result.selected;
    selectionAnchor = result.anchor;
    activeKey = result.active;
    return e.ctrlKey || e.metaKey || e.shiftKey;
  }

  function selectTargetForContextMenu(target: MenuTarget) {
    if (target.kind === 'root') return;
    const key = selectionKeyForItem(target);
    if (selectedKeySet.has(key)) return;
    selectedKeys = [key];
    selectionAnchor = key;
    activeKey = key;
  }

  function selectedItemsForTarget(target: MenuTarget): TreeItemRef[] {
    if (target.kind === 'root') return [];
    const key = selectionKeyForItem(target);
    if (selectedKeySet.has(key) && selectedCount > 1) {
      return selectedItemsFromKeys(selectedKeys);
    }
    return [target];
  }

  async function onTreeKeydown(e: KeyboardEvent) {
    if (menuOpen || !explorerRoot?.contains(document.activeElement)) return;
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (e.key !== 'F2' && e.key !== 'Delete') return;
    const eventTarget = e.target;
    if (
      eventTarget instanceof HTMLElement &&
      (eventTarget.matches('input, textarea, select') ||
        eventTarget.isContentEditable)
    ) {
      return;
    }
    const targetKey =
      activeKey && (selectedKeys.length === 0 || selectedKeySet.has(activeKey))
        ? activeKey
        : (selectedKeys.at(-1) ?? null);
    if (!targetKey) return;

    e.preventDefault();
    e.stopPropagation();
    const target = itemFromSelectionKey(targetKey);
    const selected = selectedItemsFromKeys(selectedKeys);
    const items =
      selected.length > 1
        ? await menuItemsForBatch(selected)
        : await menuItemsForTarget(target);
    menuItemForShortcut(items, e.key)?.onSelect?.();
  }

  // ---------- Drag and drop ----------
  let drag = $state<Drag>(null);
  let dragOver = $state<string | null>(null);

  function setDragPayload(e: DragEvent, item: TreeItemRef): Drag {
    if (!e.dataTransfer) return null;
    const items = dragItemsForStart(item, selectedKeys);
    const key = selectionKeyForItem(item);
    if (!selectedKeySet.has(key)) {
      selectedKeys = [key];
      selectionAnchor = key;
      activeKey = key;
    }
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-tree-items', JSON.stringify(items));
    if (item.kind === 'note') {
      e.dataTransfer.setData('application/x-note-id', item.id);
    } else {
      e.dataTransfer.setData('application/x-folder-id', item.id);
    }
    e.dataTransfer.setData('text/plain', item.id);
    return { ...item, items };
  }

  function onNoteDragStart(e: DragEvent, noteId: string) {
    if (!canDragItem({ kind: 'note', id: noteId })) return;
    if (!e.dataTransfer) return;
    drag = setDragPayload(e, { kind: 'note', id: noteId });
  }
  function onFolderDragStart(e: DragEvent, folderId: string) {
    if (!canDragItem({ kind: 'folder', id: folderId })) return;
    if (!e.dataTransfer) return;
    e.stopPropagation();
    drag = setDragPayload(e, { kind: 'folder', id: folderId });
  }
  function onDragEnd() {
    drag = null;
    dragOver = null;
    springOpen(null);
  }
  function draggedItems(): TreeItemRef[] {
    if (!drag) return [];
    return drag.items ?? [{ kind: drag.kind, id: drag.id }];
  }

  // A collapsed folder hovered mid-drag opens, so the drop can reach the
  // folders inside it.
  const SPRING_OPEN_MS = 500;
  let springFolderId: string | null = null;
  let springTimer: ReturnType<typeof setTimeout> | undefined;
  function springOpen(folderId: string | null) {
    if (folderId === springFolderId) return;
    clearTimeout(springTimer);
    springFolderId = folderId;
    if (folderId) {
      springTimer = setTimeout(
        () => (expanded[folderId] = true),
        SPRING_OPEN_MS
      );
    }
  }

  /** Home takes any tree drag; Shared only its own, to explain a refusal. */
  function acceptsTreeDrag(): boolean {
    return canReorganize || (source === 'shared' && drag !== null);
  }
  function canDropOn(targetFolderId: string | null): boolean {
    // A drag from another window carries no readable payload until the drop.
    if (!drag) return canReorganize;
    const items = draggedItems();
    const effect = treeDropEffect(
      items,
      targetFolderId,
      tree.notesById,
      tree.collectionsById
    );
    if (effect !== 'move') return false;
    if (source !== 'shared') return canReorganize;
    return sharedMoveIsLegal(
      items,
      targetFolderId,
      tree.notesById,
      tree.collectionsById
    );
  }
  // Files dragged in from the OS. The tree only declares itself a drop zone
  // (see `fileDropAccept`) where a note can be created, and the window-level
  // router in $lib/file-drop only lets a drop through when it holds a PDF.
  function onFileDragOver(e: DragEvent, parentId: string | null) {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    dragOver = !canStartDraft(parentId)
      ? null
      : parentId
        ? `f:${parentId}`
        : 'root';
  }
  function onFileDrop(e: DragEvent, parentId: string | null) {
    e.preventDefault();
    e.stopPropagation();
    dragOver = null;
    springOpen(null);
    const pdfs = droppedPdfFiles(e);
    if (pdfs.length === 0 || !canStartDraft(parentId)) return;
    if (parentId) expanded[parentId] = true;
    void importDroppedPdfs(pdfs, parentId, onOpenNote);
  }
  /** A drop on a note lands next to it. */
  function noteParentId(noteId: string): string | null {
    return tree.notesById[noteId]?.parent_collection_id ?? null;
  }

  /**
   * Every row resolves its drag to a folder (null: the root) and stops it
   * there, so the root never lights up for a drag over a row. Only a drop
   * that would move something highlights its target.
   */
  function onTreeDragOver(
    e: DragEvent,
    targetFolderId: string | null,
    springFolder: string | null = null
  ) {
    if (!e.dataTransfer) return;
    if (isFileDrag(e)) {
      springOpen(springFolder);
      return onFileDragOver(e, targetFolderId);
    }
    if (!acceptsTreeDrag()) return;
    e.preventDefault();
    e.stopPropagation();
    springOpen(springFolder);
    const legal = canDropOn(targetFolderId);
    e.dataTransfer.dropEffect = legal ? 'move' : 'none';
    dragOver = !legal ? null : targetFolderId ? `f:${targetFolderId}` : 'root';
  }
  function onDragOverFolder(e: DragEvent, node: TreeNode) {
    const into =
      drag &&
      treeDropEffect(
        draggedItems(),
        node.id,
        tree.notesById,
        tree.collectionsById
      );
    const springs =
      node.kind === 'folder' &&
      node.children.length > 0 &&
      into !== 'into-itself';
    onTreeDragOver(e, node.id, springs ? node.id : null);
  }
  function onDragLeave() {
    dragOver = null;
  }
  async function onTreeDrop(e: DragEvent, targetFolderId: string | null) {
    if (isFileDrag(e)) return onFileDrop(e, targetFolderId);
    if (!acceptsTreeDrag()) return;
    e.preventDefault();
    e.stopPropagation();
    const payload = dragPayloadFromTransfer(e.dataTransfer);
    onDragEnd();
    if (!payload) return;
    const items = payload.items ?? [{ kind: payload.kind, id: payload.id }];
    const effect = treeDropEffect(
      items,
      targetFolderId,
      tree.notesById,
      tree.collectionsById
    );
    if (effect === 'unchanged') return;
    // Shared view: reject anything that isn't an intra-scope move into an
    // editable folder, and tell the user why instead of silently no-oping.
    if (
      source === 'shared' &&
      !sharedMoveIsLegal(
        items,
        targetFolderId,
        tree.notesById,
        tree.collectionsById
      )
    ) {
      pushToast(tUi('fileTree.move.blockedShared'), { variant: 'error' });
      return;
    }
    if (effect === 'into-itself') return;
    await moveManyTo(items, targetFolderId).catch(toastRefusal);
  }

  function toggleFolder(id: string) {
    if (!filtering) {
      expanded[id] = !expanded[id];
      return;
    }
    const ids =
      closedWhileFiltering.key === filterKey
        ? { ...closedWhileFiltering.ids }
        : {};
    if (ids[id]) delete ids[id];
    else ids[id] = true;
    closedWhileFiltering = { key: filterKey, ids };
  }
  function emptyStateMessage(): string {
    if (filtering) return tUi('tagFilter.noMatches');
    return emptyStateMessageForSource(source, tUi('fileTree.emptyRoot'));
  }

  function onTreePointerDown(e: PointerEvent) {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (target.closest('[data-file-tree-node], button, input')) return;
    clearFileTreeInteractionState(true);
  }

  onMount(() => {
    const onDocumentPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (explorerRoot?.contains(target)) return;
      clearFileTreeInteractionState(true);
    };
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      void onTreeKeydown(event);
    };
    // The file-drop router swallows a drop the tree can't use (no PDF in
    // it) before any row handler runs, which would leave the hover
    // highlight stuck. An OS drag fires no `dragend` here either.
    const onWindowFileDrop = (event: DragEvent) => {
      if (isFileDrag(event)) dragOver = null;
    };
    // Rows hand the spring timer between them, but nothing in the tree sees
    // the pointer leave it.
    const onWindowDragOver = (event: DragEvent) => {
      if (event.target instanceof Node && treeEl?.contains(event.target))
        return;
      springOpen(null);
    };
    document.addEventListener('pointerdown', onDocumentPointerDown, {
      capture: true
    });
    document.addEventListener('keydown', onDocumentKeyDown);
    window.addEventListener('drop', onWindowFileDrop, true);
    window.addEventListener('dragover', onWindowDragOver, true);
    return () => {
      document.removeEventListener('pointerdown', onDocumentPointerDown, {
        capture: true
      });
      document.removeEventListener('keydown', onDocumentKeyDown);
      window.removeEventListener('drop', onWindowFileDrop, true);
      window.removeEventListener('dragover', onWindowDragOver, true);
      clearTimeout(springTimer);
    };
  });
</script>

<Surface
  as="aside"
  variant="panel"
  bind:ref={explorerRoot}
  class="file-explorer flex h-full w-full flex-col bg-surface-0 text-xs"
  oncontextmenu={(e) => openMenu(e, { kind: 'root' })}
>
  <div
    class="px-3 pb-1 pt-2"
    role="presentation"
    oncontextmenu={(e) => {
      e.preventDefault();
      e.stopPropagation();
    }}
  >
    <VaultSwitcher />
  </div>
  <!-- Fixed height: each view puts a different action here, or none, and
       the navigation below must not move when the view changes. -->
  <div class="flex h-12 shrink-0 items-center gap-1 px-3 pb-3 pt-1">
    {#if canCreateNotes}
      <FileTreeCreateToolbar
        pluginButtons={pluginToolbarButtons('file-tree')}
        onCreate={runCreateToolbarAction}
        notesOnly={source === 'favourites'}
      />
    {:else if source === 'trash'}
      <Button
        variant="ghost"
        size="sm"
        onclick={() => void startEmptyTrash()}
        disabled={trashItemCount === 0 || emptyTrashPending}
        title={tUi('fileTree.emptyTrash')}
        class="{FILE_TREE_MAIN_ACTION_CLASS} relative overflow-hidden text-destructive hover:text-destructive"
      >
        {#if emptyTrashAnimation > 0}
          {#key emptyTrashAnimation}
            <span class="trash-suck-particles" aria-hidden="true">
              {#each Array.from( { length: emptyTrashParticleCount } ) as _, i (i)}
                <span
                  class="trash-suck-particle"
                  style="--i: {i}; --x: {(i -
                    (emptyTrashParticleCount - 1) / 2) *
                    5}px;"
                ></span>
              {/each}
            </span>
          {/key}
        {/if}
        <Trash2 class="size-3.5" />
        <span class="min-w-0 truncate">{tUi('fileTree.emptyTrash')}</span>
      </Button>
    {:else if source === 'shared'}
      <FileTreeSharedActions
        onNewSharedFolder={() => startDraft('folder', null)}
      />
    {:else if pluginView}
      {#each (pluginView.view.actions ?? []).filter((action) => !action.inline) as action, i (action.id)}
        {@const label = resolvePluginString(
          pluginView.pluginId,
          action.labelKey
        )}
        <Button
          variant="ghost"
          size={i === 0 ? 'sm' : 'icon'}
          onclick={() => sendSidebarViewAction(source, action.id)}
          title={label}
          aria-label={label}
          class={i === 0
            ? FILE_TREE_MAIN_ACTION_CLASS
            : 'size-7 shrink-0 text-muted-foreground'}
        >
          <PluginIcon
            pluginId={pluginView.pluginId}
            file={action.icon}
            class="size-3.5 shrink-0"
          />
          {#if i === 0}<span class="min-w-0 truncate">{label}</span>{/if}
        </Button>
      {/each}
    {/if}
  </div>

  <nav
    class="flex shrink-0 flex-col gap-0.5 px-3 pb-3"
    aria-label={tUi('nav.primary')}
    oncontextmenu={(e) => {
      e.preventDefault();
      e.stopPropagation();
    }}
  >
    {#each FILE_EXPLORER_SOURCES as item, i (item.id)}
      {@const Icon = item.icon}
      {#snippet coreIcon()}<Icon class="size-3.5 shrink-0" />{/snippet}
      {@render navButton(item.id, tUi(item.labelKey), coreIcon)}
      <!-- Plugin views sit right after Home. -->
      {#if i === 0}
        {#each pluginSidebarViews() as ref (sidebarViewSource(ref.pluginId, ref.view.id))}
          {#snippet viewIcon()}<PluginIcon
              pluginId={ref.pluginId}
              file={ref.view.icon}
              class="size-3.5 shrink-0"
            />{/snippet}
          {@render navButton(
            sidebarViewSource(ref.pluginId, ref.view.id),
            resolvePluginString(ref.pluginId, ref.view.labelKey),
            viewIcon,
            ref
          )}
        {/each}
      {/if}
    {/each}
  </nav>

  <Separator />
  {#if pluginView}
    <PluginSidebarView ref={pluginView} {source} />
  {:else}
    <div class="flex h-11 shrink-0 items-center justify-between gap-2 px-4">
      <span
        class="min-w-0 truncate text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
        >{source === 'home'
          ? tUi('fileTree.notes')
          : tUi(
              // A plugin view whose plugin was just disabled has no entry;
              // the effect above is about to switch to Home.
              FILE_EXPLORER_SOURCES.find((item) => item.id === source)
                ?.labelKey ?? 'fileTree.notes'
            )}</span
      >
      <div class="flex shrink-0 items-center gap-0.5">
        <TagFilterControl />
        <SortControl
          strategy={ui.sortStrategy}
          direction={ui.sortDirection}
          onStrategyChange={setSortStrategy}
          onDirectionChange={setSortDirection}
          variant="ghost"
          compact
          collapsed
        />
      </div>
    </div>
    <div
      bind:this={treeEl}
      role="group"
      aria-label={tUi('fileTree.tree')}
      class="themed-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-3 text-[13px]"
      class:ring-1={dragOver === 'root'}
      class:ring-inset={dragOver === 'root'}
      class:ring-ring={dragOver === 'root'}
      data-file-drop-accept={fileDropAccept}
      ondragover={(e) => onTreeDragOver(e, null)}
      ondragleave={onDragLeave}
      ondrop={(e) => onTreeDrop(e, null)}
      onpointerdown={onTreePointerDown}
    >
      {#if tree.error}
        <p class="px-2 py-3 text-xs text-destructive">
          {tUi('fileTree.error')}: {tree.error}
        </p>
      {:else if !tree.ready}
        <p class="px-2 py-3 text-xs text-muted-foreground">
          {tUi('fileTree.loading')}
        </p>
      {:else if sourceNodes.length === 0 && !draft}
        <p class="px-2 py-3 text-xs text-muted-foreground">
          {emptyStateMessage()}
        </p>
        {#if filtering}
          <Button
            variant="ghost"
            size="sm"
            class="mx-1 h-7 px-2 text-xs"
            onclick={clearTagFilter}>{tUi('tagFilter.clear')}</Button
          >
        {/if}
      {/if}

      {#each sourceNodes as node (nodeKey(node))}
        {@render renderNode(node)}
      {/each}

      {#if (canCreateNotes || source === 'shared') && draft && draft.parentId === null}
        {@render renderDraft()}
      {/if}
    </div>
  {/if}
</Surface>

{#snippet navButton(
  id: DesktopNoteSource,
  label: string,
  icon: import('svelte').Snippet,
  view?: PluginSidebarViewRef
)}
  {@const active = source === id}
  <!-- A selected plugin view's inline actions sit at the end of its entry. -->
  {@const inline = active
    ? (view?.view.actions ?? []).filter((action) => action.inline)
    : []}
  <div class="relative flex min-w-0 shrink-0">
    <button
      type="button"
      class="inline-flex h-8 min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 text-left text-xs transition-colors {active
        ? 'bg-accent-brand/10 font-medium text-accent-brand'
        : 'text-muted-foreground hover:bg-accent hover:text-foreground'}"
      style:padding-right={inline.length
        ? `${inline.length * 1.75 + 0.25}rem`
        : undefined}
      use:tooltip={active ? undefined : label}
      aria-current={active ? 'page' : undefined}
      aria-label={label}
      onclick={() => onSourceChange?.(id)}
    >
      {@render icon()}
      <span class="truncate">{label}</span>
    </button>
    {#if view && inline.length}
      <div class="absolute inset-y-0 right-1 flex items-center">
        {#each inline as action (action.id)}
          {@const actionLabel = resolvePluginString(
            view.pluginId,
            action.labelKey
          )}
          <button
            type="button"
            class="grid size-6 place-items-center rounded-md text-accent-brand transition-colors hover:bg-accent-brand/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            use:tooltip={actionLabel}
            aria-label={actionLabel}
            onclick={() => sendSidebarViewAction(id, action.id)}
          >
            <PluginIcon
              pluginId={view.pluginId}
              file={action.icon}
              class="size-3.5 shrink-0"
            />
          </button>
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

<input
  bind:this={pdfInput}
  class="hidden"
  type="file"
  accept="application/pdf,.pdf"
  onchange={(e) => void onPdfPicked(e)}
/>

{#snippet renderDraft()}
  {@const kind = draft?.kind ?? 'note'}
  {@const placeholder = draft?.share
    ? tUi('sharing.newFolder.action')
    : kind === 'folder'
      ? tUi('fileTree.newFolder')
      : kind === 'drawing'
        ? tUi('fileTree.newDrawing')
        : kind === 'ink'
          ? tUi('fileTree.newInk')
          : tUi('fileTree.newNote')}
  <div class="my-0.5 flex items-center gap-1.5 rounded-md px-2 py-0.5">
    {#if draft?.template}
      <NoteKindIcon
        kind={draft.template.noteKind}
        class="size-3.5 shrink-0 text-muted-foreground"
      />
    {:else if kind === 'folder'}
      <Folder class="size-3.5 shrink-0 text-muted-foreground" />
    {:else if kind === 'drawing'}
      <PencilRuler class="size-3.5 shrink-0 text-muted-foreground" />
    {:else if kind === 'ink'}
      <Feather class="size-3.5 shrink-0 text-muted-foreground" />
    {:else}
      <FileText class="size-3.5 shrink-0 text-muted-foreground" />
    {/if}
    <Input
      bind:ref={nameInput}
      bind:value={draft!.text}
      {placeholder}
      class="h-7 px-2 text-sm"
      onkeydown={onDraftKey}
      onblur={onDraftBlur}
    />
  </div>
{/snippet}

{#snippet renderRenameInput()}
  <Input
    bind:ref={nameInput}
    bind:value={rename!.new_name}
    class="h-6 px-1.5 text-sm"
    onkeydown={onRenameKey}
    onblur={onRenameBlur}
  />
{/snippet}

{#snippet renderNode(node: TreeNode)}
  {#if node.kind === 'folder'}
    {@const isOver = dragOver === `f:${node.id}`}
    {@const isSelected = selectedKeySet.has(nodeKey(node) as SelectionKey)}
    {@const renaming =
      rename && rename.kind === 'folder' && rename.id === node.id}
    {@const folder = tree.collectionsById[node.id]}
    {@const sharedByMe = folder ? collectionIsSharedByMe(folder) : false}
    <button
      data-file-tree-node
      type="button"
      draggable={canDragItem({ kind: 'folder', id: node.id })}
      class="flex min-h-7 w-full items-center gap-1.5 rounded-md px-2 py-0.5 text-left ring-offset-background hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      class:bg-accent={isOver || isSelected}
      class:opacity-60={drag?.kind === 'folder' && drag.id === node.id}
      aria-expanded={openFolders[node.id] === true}
      onclick={(e) => {
        // The rename input sits inside this button. WebKit activates the
        // button on a space typed into it, and a click there places the
        // caret; neither is a click on the row.
        if (renaming) return;
        const modified = selectNodeFromClick(e, node);
        if (!modified) toggleFolder(node.id);
      }}
      oncontextmenu={(e) => openMenu(e, { kind: 'folder', id: node.id })}
      ondragstart={(e) => onFolderDragStart(e, node.id)}
      ondragend={onDragEnd}
      ondragover={(e) => onDragOverFolder(e, node)}
      ondragleave={onDragLeave}
      ondrop={(e) => onTreeDrop(e, node.id)}
    >
      <ChevronRight
        class={`size-3.5 shrink-0 transition-transform ${openFolders[node.id] ? 'rotate-90' : ''} ${node.children.length === 0 ? 'invisible' : ''}`}
      />
      <!-- Folders are amber so the tree's structure reads at a glance without
           competing with the brand colour that marks the open note. -->
      {#if openFolders[node.id]}
        <FolderOpen class="size-3.5 shrink-0 text-folder-icon" />
      {:else}
        <Folder class="size-3.5 shrink-0 text-folder-icon" />
      {/if}
      {#if renaming}
        {@render renderRenameInput()}
      {:else}
        <span class="truncate">{node.name}</span>
        {#if sharedByMe}
          <Share2
            class="ml-auto size-3.5 shrink-0 text-accent-brand"
            aria-label={tUi('nav.shared')}
          />
        {/if}
      {/if}
    </button>
    {#if openFolders[node.id]}
      <div class="ml-3 border-l border-border pl-1">
        {#each node.children as child (nodeKey(child))}
          {@render renderNode(child)}
        {/each}
        {#if canStartDraft(node.id) && draft && draft.parentId === node.id}
          {@render renderDraft()}
        {/if}
      </div>
    {/if}
  {:else}
    {@const isSelected = selectedKeySet.has(nodeKey(node) as SelectionKey)}
    {@const renaming =
      rename && rename.kind === 'note' && rename.id === node.id}
    {@const note = tree.notesById[node.id]}
    {@const fav = note?.favourite === true}
    {@const inTrash =
      source === 'trash' ||
      (note ? noteIsUnderTrash(note, tree.collectionsById) : false)}
    {@const canDelete = !inTrash && itemEditable({ kind: 'note', id: node.id })}
    {@const kind = note?.note_kind}
    <!-- Row uses a flex container so the favourite-toggle button can
         sit alongside the primary open-note tap target without nesting
         <button>s. The drag handlers live on the wrapper so users can
         start a drag from either side; only the main button responds
         to click + contextmenu. -->
    <div
      data-file-tree-node
      role="group"
      draggable={canDragItem({ kind: 'note', id: node.id })}
      class="file-tree-note-row group flex w-full items-center gap-0.5 rounded-md pr-1 hover:bg-accent hover:text-accent-foreground"
      class:bg-accent={isSelected}
      class:active-note={ui.activeNoteId === node.id}
      class:opacity-60={drag?.kind === 'note' && drag.id === node.id}
      ondragstart={(e) => onNoteDragStart(e, node.id)}
      ondragend={onDragEnd}
      ondragover={(e) => onTreeDragOver(e, noteParentId(node.id))}
      ondragleave={onDragLeave}
      ondrop={(e) => onTreeDrop(e, noteParentId(node.id))}
    >
      <button
        type="button"
        aria-current={ui.activeNoteId === node.id ? 'page' : undefined}
        class="flex min-h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-0.5 text-left focus-visible:outline-none"
        onclick={(e) => {
          // See the folder row: activation from the rename input is not a
          // click on the row. Opening the note here would move focus away,
          // to its own window when it is popped out, and end the rename.
          if (renaming) return;
          const modified = selectNodeFromClick(e, node);
          if (!modified) (onPreviewNote ?? onOpenNote)(node.id);
        }}
        ondblclick={(e) => {
          if (renaming || e.ctrlKey || e.metaKey || e.shiftKey) return;
          onOpenNote(node.id);
        }}
        oncontextmenu={(e) => openMenu(e, { kind: 'note', id: node.id })}
      >
        <NoteKindIcon {kind} class="size-3.5 shrink-0 text-muted-foreground" />
        {#if renaming}
          {@render renderRenameInput()}
        {:else}
          <span class="truncate">{node.name}</span>
        {/if}
      </button>
      <!-- Row actions leave the layout until the row is hovered or focused,
           (keyboard focus counts, a mouse click does not), so idle titles use
           the full row width instead of truncating early. -->
      {#if !inTrash}
        <button
          type="button"
          class="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground {fav
            ? ''
            : 'hidden group-hover:inline-flex group-has-[:focus-visible]:inline-flex'}"
          onclick={() => void setNoteFavourite(node.id, !fav)}
          use:tooltip={fav ? tUi('favourite.remove') : tUi('favourite.add')}
          aria-pressed={fav}
          aria-label={fav ? tUi('favourite.remove') : tUi('favourite.add')}
        >
          <FavouriteStar size={14} favourited={fav} />
        </button>
      {/if}
      {#if canDelete}
        <button
          type="button"
          class="hidden shrink-0 rounded p-1 text-muted-foreground hover:text-destructive group-hover:inline-flex group-has-[:focus-visible]:inline-flex"
          onclick={() => void trashWithUndo([{ kind: 'note', id: node.id }])}
          use:tooltip={tUi('fileTree.delete')}
          aria-label={tUi('fileTree.delete')}
        >
          <Trash2 size={14} />
        </button>
      {/if}
    </div>
  {/if}
{/snippet}

{#if menuOpen}
  <ContextMenu
    x={menuX}
    y={menuY}
    items={currentMenuItems}
    onClose={closeMenu}
  />
{/if}

<style>
  .file-tree-note-row.active-note {
    background: color-mix(in oklch, var(--accent-brand) 10%, transparent);
    color: var(--accent-brand);
  }

  .file-tree-note-row:has(:focus-visible) {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }

  .trash-suck-particles {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .trash-suck-particle {
    position: absolute;
    left: calc(50% + var(--x));
    top: 70%;
    width: 3px;
    height: 3px;
    border-radius: 999px;
    background: currentColor;
    opacity: 0;
    animation: trash-suck 520ms cubic-bezier(0.2, 0.85, 0.25, 1) forwards;
    animation-delay: calc(var(--i) * 35ms);
  }

  @keyframes trash-suck {
    0% {
      opacity: 0;
      transform: translate(-18px, -8px) scale(0.9);
    }
    20% {
      opacity: 0.8;
    }
    100% {
      opacity: 0;
      transform: translate(0, -1px) scale(0.15);
    }
  }

  /* `html.reduce-motion` already folds in the OS preference — see
   * src/lib/reduce-motion.svelte.ts. */
  :global(.reduce-motion) .trash-suck-particle {
    animation: none;
  }
</style>

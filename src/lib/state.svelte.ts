/**
 * Shared, reactive app state. Svelte 5 runes singletons that any component
 * can import; `$state` makes the fields reactive.
 */

import { MOCK_NOTES, MOCK_TREE, type FolderNode, type NoteSummary, type TreeNode } from './mocks';
import { DEFAULT_PREFERENCES, loadPreferences, savePreferences } from './preferences';

// Hydrate UI state from persisted preferences (or defaults on the server /
// first run). `loadPreferences` is browser-only and returns defaults on the
// server, so this is safe under SvelteKit's prerender pass.
const initialPrefs = loadPreferences();

interface UiState {
  leftSidebarOpen: boolean;
  rightSidebarOpen: boolean;
  leftSidebarWidth: number;
  rightSidebarWidth: number;
  /** Id of the note the metadata panel should describe. */
  activeNoteId: string | null;
}

interface NotesState {
  /** id -> in-memory note. Replace with disk-backed store later. */
  byId: Record<string, NoteSummary>;
  /** Tree shown in the file explorer. */
  tree: TreeNode[];
}

export const ui = $state<UiState>({
  leftSidebarOpen: initialPrefs.leftSidebarOpen,
  rightSidebarOpen: initialPrefs.rightSidebarOpen,
  leftSidebarWidth: initialPrefs.leftSidebarWidth,
  rightSidebarWidth: initialPrefs.rightSidebarWidth,
  activeNoteId: 'welcome'
});

export const notes = $state<NotesState>({
  byId: { ...MOCK_NOTES },
  tree: structuredClone(MOCK_TREE)
});

// ---------- UI ----------

export function setActiveNote(id: string | null) {
  ui.activeNoteId = id;
}

export function toggleLeftSidebar() {
  ui.leftSidebarOpen = !ui.leftSidebarOpen;
  persistUi();
}

export function toggleRightSidebar() {
  ui.rightSidebarOpen = !ui.rightSidebarOpen;
  persistUi();
}

export function setLeftSidebarWidth(px: number) {
  ui.leftSidebarWidth = px;
  persistUi();
}

export function setRightSidebarWidth(px: number) {
  ui.rightSidebarWidth = px;
  persistUi();
}

// ---------- Notes content ----------

export function updateNoteBody(id: string, body: string) {
  const existing = notes.byId[id];
  if (!existing) return;
  notes.byId[id] = {
    ...existing,
    body,
    modified: new Date().toISOString()
  };
}

// ---------- Tree mutations (placeholders — swap for disk I/O later) ----------

/** Recursively walk the tree and return all matching nodes' parents+indices. */
type Locator = { parent: TreeNode[]; index: number };

function findNoteLoc(tree: TreeNode[], noteId: string): Locator | null {
  for (let i = 0; i < tree.length; i++) {
    const node = tree[i];
    if (node.kind === 'note' && node.id === noteId) {
      return { parent: tree, index: i };
    }
    if (node.kind === 'folder') {
      const inner = findNoteLoc(node.children, noteId);
      if (inner) return inner;
    }
  }
  return null;
}

function findFolderLoc(tree: TreeNode[], folderName: string): Locator | null {
  for (let i = 0; i < tree.length; i++) {
    const node = tree[i];
    if (node.kind === 'folder' && node.name === folderName) {
      return { parent: tree, index: i };
    }
    if (node.kind === 'folder') {
      const inner = findFolderLoc(node.children, folderName);
      if (inner) return inner;
    }
  }
  return null;
}

/** Rename a note. Updates the tree label and the note title. */
export function renameNote(noteId: string, nextTitle: string) {
  const note = notes.byId[noteId];
  if (!note) return;
  console.info('[tree] renameNote', noteId, '->', nextTitle);
  notes.byId[noteId] = {
    ...note,
    title: nextTitle,
    modified: new Date().toISOString()
  };
  // Update the tree label.
  const loc = findNoteLoc(notes.tree, noteId);
  if (loc) {
    const node = loc.parent[loc.index];
    if (node.kind === 'note') {
      loc.parent[loc.index] = { ...node, name: `${nextTitle}.md` };
    }
  }
}

/** Delete a note. Removes it from the tree and the byId map. */
export function deleteNote(noteId: string) {
  console.info('[tree] deleteNote', noteId);
  const loc = findNoteLoc(notes.tree, noteId);
  if (loc) loc.parent.splice(loc.index, 1);
  delete notes.byId[noteId];
  if (ui.activeNoteId === noteId) ui.activeNoteId = null;
}

/**
 * Move a note into a folder (by name) at an optional index. If `targetFolder`
 * is null the note moves to the tree root.
 */
export function moveNote(
  noteId: string,
  targetFolder: string | null,
  targetIndex?: number
) {
  console.info('[tree] moveNote', noteId, '->', targetFolder, targetIndex);
  const src = findNoteLoc(notes.tree, noteId);
  if (!src) return;
  const [node] = src.parent.splice(src.index, 1);
  if (!node || node.kind !== 'note') return;

  let dest: TreeNode[];
  if (targetFolder == null) {
    dest = notes.tree;
  } else {
    const folderLoc = findFolderLoc(notes.tree, targetFolder);
    if (!folderLoc) {
      // Folder vanished; put the node back where it was.
      src.parent.splice(src.index, 0, node);
      return;
    }
    const folder = folderLoc.parent[folderLoc.index] as FolderNode;
    dest = folder.children;
  }

  const insertAt = targetIndex == null ? dest.length : Math.min(targetIndex, dest.length);
  dest.splice(insertAt, 0, node);
}

/** Create a fresh empty note, optionally inside a named folder. */
export function createNote(folderName: string | null = null): string {
  const id = `note-${Date.now()}`;
  console.info('[tree] createNote in', folderName, '->', id);
  const summary: NoteSummary = {
    id,
    title: 'Untitled',
    body: '# Untitled\n',
    tags: [],
    modified: new Date().toISOString()
  };
  notes.byId[id] = summary;
  const node: TreeNode = { kind: 'note', id, name: 'Untitled.md' };
  if (folderName == null) {
    notes.tree.push(node);
  } else {
    const folderLoc = findFolderLoc(notes.tree, folderName);
    if (folderLoc) {
      const folder = folderLoc.parent[folderLoc.index] as FolderNode;
      folder.children.push(node);
    } else {
      notes.tree.push(node);
    }
  }
  return id;
}

// ---------- preferences plumbing ----------

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persistUi() {
  // Debounced — drag-resize fires many updates per second.
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    savePreferences({
      ...DEFAULT_PREFERENCES,
      leftSidebarOpen: ui.leftSidebarOpen,
      rightSidebarOpen: ui.rightSidebarOpen,
      leftSidebarWidth: ui.leftSidebarWidth,
      rightSidebarWidth: ui.rightSidebarWidth
    });
  }, 150);
}

import { Home, PencilRuler, Share2, Star, Trash2 } from '@lucide/svelte';
import type { NoteKind, TreeNode } from '$lib/api';
import type { IconComponent } from '$lib/settings/icons';
import type { DesktopNoteSource } from '$lib/stores/note-source.svelte';

export type DraftKind = 'note' | 'folder' | 'drawing' | 'ink';
export type Draft = {
  kind: DraftKind;
  parentId: string | null;
  text: string;
};

export type Rename = {
  kind: 'note' | 'folder';
  id: string;
  new_name: string;
};

export type MenuTarget =
  | { kind: 'note'; id: string }
  | { kind: 'folder'; id: string }
  | { kind: 'root' };

export type Drag =
  | { kind: 'note'; id: string }
  | { kind: 'folder'; id: string }
  | null;

export const FILE_EXPLORER_SOURCES: {
  id: DesktopNoteSource;
  labelKey: string;
  icon: IconComponent;
}[] = [
  {
    id: 'home',
    labelKey: 'nav.home',
    icon: Home as unknown as IconComponent
  },
  {
    id: 'favourites',
    labelKey: 'nav.favourite',
    icon: Star as unknown as IconComponent
  },
  {
    id: 'shared',
    labelKey: 'nav.shared',
    icon: Share2 as unknown as IconComponent
  },
  {
    id: 'trash',
    labelKey: 'nav.trash',
    icon: Trash2 as unknown as IconComponent
  }
];

export function defaultDraftText(kind: DraftKind): string {
  switch (kind) {
    case 'folder':
      return 'Untitled folder';
    case 'drawing':
      return 'Untitled drawing canvas';
    case 'ink':
      return 'Untitled handwritten note';
    case 'note':
      return 'Untitled';
  }
}

export function draftKindToNoteKind(kind: DraftKind): NoteKind | null {
  switch (kind) {
    case 'drawing':
      return 'freeform';
    case 'ink':
      return 'ink';
    case 'note':
      return 'markdown';
    case 'folder':
      return null;
  }
}

export function nodeKey(n: TreeNode): string {
  return n.kind === 'folder' ? `f:${n.id}` : `n:${n.id}`;
}

export function emptyStateMessageForSource(
  source: DesktopNoteSource,
  emptyRootLabel: string
): string {
  switch (source) {
    case 'favourites':
      return 'Favourite notes will appear here.';
    case 'shared':
      return 'Shared folders will appear here.';
    case 'trash':
      return 'Trash is empty.';
    case 'home':
      return emptyRootLabel;
  }
}

export function dragPayloadFromTransfer(
  dataTransfer: DataTransfer | null
): Drag {
  if (!dataTransfer) return null;
  const noteId = dataTransfer.getData('application/x-note-id');
  if (noteId) return { kind: 'note', id: noteId };
  const folderId = dataTransfer.getData('application/x-folder-id');
  if (folderId) return { kind: 'folder', id: folderId };
  return null;
}

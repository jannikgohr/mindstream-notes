import { describe, expect, it } from 'vitest';
import {
  defaultDraftText,
  dragPayloadFromTransfer,
  dragItemsForStart,
  draftKindToNoteKind,
  emptyStateMessageForSource,
  FILE_EXPLORER_SOURCES,
  itemFromSelectionKey,
  mergeSelection,
  nodeKey,
  selectedItemsFromKeys,
  selectionKeyForItem,
  selectionRange,
  toggleSelection,
  updateSelectionForClick,
  visibleSelectionKeys,
  type DraftKind,
  type SelectionKey
} from './file-explorer-helpers';
import type { TreeNode } from '$lib/api';

describe('defaultDraftText', () => {
  it('returns the right placeholder per kind', () => {
    expect(defaultDraftText('folder')).toBe('Untitled folder');
    expect(defaultDraftText('drawing')).toBe('Untitled drawing canvas');
    expect(defaultDraftText('ink')).toBe('Untitled handwritten note');
    expect(defaultDraftText('kanban')).toBe('Untitled board');
    expect(defaultDraftText('note')).toBe('Untitled');
  });
});

describe('draftKindToNoteKind', () => {
  it('maps draft kinds to note kinds, folder being null', () => {
    expect(draftKindToNoteKind('drawing')).toBe('freeform');
    expect(draftKindToNoteKind('ink')).toBe('ink');
    expect(draftKindToNoteKind('kanban')).toBe('kanban');
    expect(draftKindToNoteKind('note')).toBe('markdown');
    expect(draftKindToNoteKind('folder')).toBeNull();
  });
});

describe('nodeKey', () => {
  it('prefixes folders with f: and notes with n:', () => {
    const folder = { kind: 'folder', id: '1' } as TreeNode;
    const note = { kind: 'note', id: '2' } as TreeNode;
    expect(nodeKey(folder)).toBe('f:1');
    expect(nodeKey(note)).toBe('n:2');
  });
});

describe('selection helpers', () => {
  const treeNodes: TreeNode[] = [
    {
      kind: 'folder',
      id: 'a',
      name: 'A',
      position: 0,
      parent_collection_id: null,
      children: [
        {
          kind: 'note',
          id: 'a1',
          name: 'A1',
          position: 0,
          parent_collection_id: 'a'
        },
        {
          kind: 'folder',
          id: 'b',
          name: 'B',
          position: 1,
          parent_collection_id: 'a',
          children: [
            {
              kind: 'note',
              id: 'b1',
              name: 'B1',
              position: 0,
              parent_collection_id: 'b'
            }
          ]
        }
      ]
    },
    {
      kind: 'note',
      id: 'root',
      name: 'Root',
      position: 1,
      parent_collection_id: null
    }
  ];

  it('converts between selection keys and item refs', () => {
    expect(selectionKeyForItem({ kind: 'folder', id: 'a' })).toBe('f:a');
    expect(selectionKeyForItem({ kind: 'note', id: 'n' })).toBe('n:n');
    expect(itemFromSelectionKey('f:a')).toEqual({ kind: 'folder', id: 'a' });
    expect(itemFromSelectionKey('n:n')).toEqual({ kind: 'note', id: 'n' });
    expect(itemFromSelectionKey('n:id:with:colon')).toEqual({
      kind: 'note',
      id: 'id:with:colon'
    });
    expect(selectedItemsFromKeys(['f:a', 'n:n'])).toEqual([
      { kind: 'folder', id: 'a' },
      { kind: 'note', id: 'n' }
    ]);
  });

  it('flattens only visible tree rows', () => {
    expect(visibleSelectionKeys(treeNodes, {})).toEqual(['f:a', 'n:root']);
    expect(visibleSelectionKeys(treeNodes, { a: true })).toEqual([
      'f:a',
      'n:a1',
      'f:b',
      'n:root'
    ]);
    expect(visibleSelectionKeys(treeNodes, { a: true, b: true })).toEqual([
      'f:a',
      'n:a1',
      'f:b',
      'n:b1',
      'n:root'
    ]);
  });

  it('computes ranges in either direction', () => {
    const visible: SelectionKey[] = ['f:a', 'n:a1', 'f:b', 'n:root'];
    expect(selectionRange(visible, 'f:a', 'f:b')).toEqual([
      'f:a',
      'n:a1',
      'f:b'
    ]);
    expect(selectionRange(visible, 'n:root', 'n:a1')).toEqual([
      'n:a1',
      'f:b',
      'n:root'
    ]);
    expect(selectionRange(visible, 'f:missing', 'n:root')).toEqual(['n:root']);
  });

  it('toggles and merges selections without duplicating keys', () => {
    expect(toggleSelection(['f:a'], 'f:a')).toEqual([]);
    expect(toggleSelection(['f:a'], 'n:root')).toEqual(['f:a', 'n:root']);
    expect(mergeSelection(['f:a'], ['f:a', 'n:root'])).toEqual([
      'f:a',
      'n:root'
    ]);
  });

  it('updates selection for plain, toggle, and range clicks', () => {
    const visible: SelectionKey[] = ['f:a', 'n:a1', 'f:b', 'n:root'];
    expect(
      updateSelectionForClick([], 'f:a', visible, null, null, {
        toggle: false,
        range: false
      })
    ).toEqual({ selected: [], anchor: null, active: 'f:a' });

    expect(
      updateSelectionForClick([], 'n:a1', visible, null, 'f:a', {
        toggle: true,
        range: false
      })
    ).toEqual({ selected: ['n:a1'], anchor: 'n:a1', active: 'n:a1' });

    expect(
      updateSelectionForClick(['n:a1'], 'f:b', visible, 'n:a1', 'n:a1', {
        toggle: true,
        range: false
      })
    ).toEqual({ selected: ['n:a1', 'f:b'], anchor: 'f:b', active: 'f:b' });

    expect(
      updateSelectionForClick([], 'f:b', visible, null, 'f:a', {
        toggle: false,
        range: true
      })
    ).toEqual({
      selected: ['f:a', 'n:a1', 'f:b'],
      anchor: 'f:a',
      active: 'f:b'
    });
  });

  it('adds a range when ctrl/cmd is combined with shift', () => {
    const visible: SelectionKey[] = ['f:a', 'n:a1', 'f:b', 'n:root'];
    expect(
      updateSelectionForClick(['n:root'], 'f:b', visible, 'f:a', 'n:root', {
        toggle: true,
        range: true
      })
    ).toEqual({
      selected: ['n:root', 'f:a', 'n:a1', 'f:b'],
      anchor: 'f:a',
      active: 'f:b'
    });
  });

  it('does not add the plain-clicked active item to the first ctrl/cmd click', () => {
    const visible: SelectionKey[] = ['f:a', 'n:a1', 'f:b', 'n:root'];
    const plain = updateSelectionForClick([], 'f:a', visible, null, null, {
      toggle: false,
      range: false
    });

    expect(
      updateSelectionForClick(
        plain.selected,
        'n:root',
        visible,
        plain.anchor,
        plain.active,
        {
          toggle: true,
          range: false
        }
      )
    ).toEqual({
      selected: ['n:root'],
      anchor: 'n:root',
      active: 'n:root'
    });
  });

  it('clears the batch when ctrl/cmd toggles the only selected item off', () => {
    const visible: SelectionKey[] = ['f:a', 'n:a1', 'f:b', 'n:root'];

    expect(
      updateSelectionForClick(['n:a1'], 'n:a1', visible, 'n:a1', 'n:a1', {
        toggle: true,
        range: false
      })
    ).toEqual({
      selected: [],
      anchor: null,
      active: 'n:a1'
    });
  });

  it('clears an existing batch on plain click while keeping the clicked item active', () => {
    const visible: SelectionKey[] = ['f:a', 'n:a1', 'f:b', 'n:root'];

    expect(
      updateSelectionForClick(
        ['n:a1', 'f:b'],
        'n:root',
        visible,
        'f:b',
        'f:b',
        {
          toggle: false,
          range: false
        }
      )
    ).toEqual({
      selected: [],
      anchor: null,
      active: 'n:root'
    });
  });

  it('drags the selected set only when drag starts on a selected item', () => {
    expect(
      dragItemsForStart({ kind: 'note', id: 'b' }, ['n:a', 'f:folder'])
    ).toEqual([{ kind: 'note', id: 'b' }]);
    expect(
      dragItemsForStart({ kind: 'note', id: 'a' }, ['n:a', 'f:folder'])
    ).toEqual([
      { kind: 'note', id: 'a' },
      { kind: 'folder', id: 'folder' }
    ]);
  });
});

describe('emptyStateMessageForSource', () => {
  it('returns source-specific copy', () => {
    expect(emptyStateMessageForSource('favourites', 'root')).toBe(
      'Favourite notes will appear here.'
    );
    expect(emptyStateMessageForSource('shared', 'root')).toBe(
      'Shared folders will appear here.'
    );
    expect(emptyStateMessageForSource('trash', 'root')).toBe('Trash is empty.');
  });

  it('passes the provided root label through for home', () => {
    expect(emptyStateMessageForSource('home', 'No notes yet')).toBe(
      'No notes yet'
    );
  });
});

describe('FILE_EXPLORER_SOURCES', () => {
  it('lists the four nav sources in order', () => {
    expect(FILE_EXPLORER_SOURCES.map((s) => s.id)).toEqual([
      'home',
      'favourites',
      'shared',
      'trash'
    ]);
  });

  it('gives every source a translation key and icon', () => {
    for (const source of FILE_EXPLORER_SOURCES) {
      expect(source.labelKey).toMatch(/^nav\./);
      expect(source.icon).toBeTruthy();
    }
  });
});

describe('dragPayloadFromTransfer', () => {
  const transfer = (map: Record<string, string>): DataTransfer =>
    ({
      getData: (type: string) => map[type] ?? ''
    }) as unknown as DataTransfer;

  it('returns null when the transfer is null', () => {
    expect(dragPayloadFromTransfer(null)).toBeNull();
  });

  it('reads a note id when present', () => {
    const t = transfer({ 'application/x-note-id': 'n1' });
    expect(dragPayloadFromTransfer(t)).toEqual({ kind: 'note', id: 'n1' });
  });

  it('reads a folder id when present', () => {
    const t = transfer({ 'application/x-folder-id': 'f1' });
    expect(dragPayloadFromTransfer(t)).toEqual({ kind: 'folder', id: 'f1' });
  });

  it('reads a multi-item tree payload when present', () => {
    const items = [
      { kind: 'folder', id: 'f1' },
      { kind: 'note', id: 'n1' }
    ];
    const t = transfer({
      'application/x-tree-items': JSON.stringify(items),
      'application/x-note-id': 'legacy'
    });
    expect(dragPayloadFromTransfer(t)).toEqual({
      kind: 'folder',
      id: 'f1',
      items
    });
  });

  it('falls back to legacy payloads when tree-items JSON is malformed', () => {
    const t = transfer({
      'application/x-tree-items': '{not json',
      'application/x-folder-id': 'fallback-folder'
    });
    expect(dragPayloadFromTransfer(t)).toEqual({
      kind: 'folder',
      id: 'fallback-folder'
    });
  });

  it('falls back when a multi-item tree payload has malformed items', () => {
    const t = transfer({
      'application/x-tree-items': JSON.stringify([
        { kind: 'folder', id: 'f1' },
        { kind: 'note', id: '' }
      ]),
      'application/x-note-id': 'fallback-note'
    });

    expect(dragPayloadFromTransfer(t)).toEqual({
      kind: 'note',
      id: 'fallback-note'
    });
  });

  it('falls back when a multi-item tree payload is not an array', () => {
    const t = transfer({
      'application/x-tree-items': JSON.stringify({
        kind: 'folder',
        id: 'f1'
      }),
      'application/x-folder-id': 'fallback-folder'
    });

    expect(dragPayloadFromTransfer(t)).toEqual({
      kind: 'folder',
      id: 'fallback-folder'
    });
  });

  it('prefers a note id over a folder id', () => {
    const t = transfer({
      'application/x-note-id': 'n1',
      'application/x-folder-id': 'f1'
    });
    expect(dragPayloadFromTransfer(t)).toEqual({ kind: 'note', id: 'n1' });
  });

  it('returns null when neither id is set', () => {
    expect(dragPayloadFromTransfer(transfer({}))).toBeNull();
  });

  it('covers all draft kinds without throwing', () => {
    const kinds: DraftKind[] = ['note', 'folder', 'drawing', 'ink'];
    for (const k of kinds) {
      expect(typeof defaultDraftText(k)).toBe('string');
    }
  });
});

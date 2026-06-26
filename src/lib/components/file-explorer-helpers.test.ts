import { describe, expect, it } from 'vitest';
import {
  defaultDraftText,
  dragPayloadFromTransfer,
  draftKindToNoteKind,
  emptyStateMessageForSource,
  FILE_EXPLORER_SOURCES,
  nodeKey,
  type DraftKind
} from './file-explorer-helpers';
import type { TreeNode } from '$lib/api';

describe('defaultDraftText', () => {
  it('returns the right placeholder per kind', () => {
    expect(defaultDraftText('folder')).toBe('Untitled folder');
    expect(defaultDraftText('drawing')).toBe('Untitled drawing canvas');
    expect(defaultDraftText('ink')).toBe('Untitled handwritten note');
    expect(defaultDraftText('note')).toBe('Untitled');
  });
});

describe('draftKindToNoteKind', () => {
  it('maps draft kinds to note kinds, folder being null', () => {
    expect(draftKindToNoteKind('drawing')).toBe('freeform');
    expect(draftKindToNoteKind('ink')).toBe('ink');
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

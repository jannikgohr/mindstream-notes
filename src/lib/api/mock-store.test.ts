import { beforeEach, describe, expect, it } from 'vitest';
import { mockApi } from './mock-store';

/**
 * The mock store is a module-level singleton seeded once at import. Tests
 * create their own data and assert on it relative to that baseline rather
 * than on absolute counts, so they stay order-independent.
 */

describe('mock-store collections', () => {
  it('seeds Work, Personal and Trash', async () => {
    const cols = await mockApi.listCollections();
    const names = cols.map((c) => c.name);
    expect(names).toContain('Work');
    expect(names).toContain('Personal');
    expect(names).toContain('Trash');
  });

  it('creates a collection with an incremented sibling position', async () => {
    const a = await mockApi.createCollection({
      name: 'A',
      parent_collection_id: null
    });
    const b = await mockApi.createCollection({
      name: 'B',
      parent_collection_id: null
    });
    expect(b.position).toBeGreaterThan(a.position);
    expect(b.parent_collection_id).toBeNull();
  });

  it('updates name, parent and position', async () => {
    const c = await mockApi.createCollection({ name: 'Old' });
    const updated = await mockApi.updateCollection({
      id: c.id,
      name: 'New',
      position: 42
    });
    expect(updated.name).toBe('New');
    expect(updated.position).toBe(42);
  });

  it('throws when updating a missing collection', async () => {
    await expect(
      mockApi.updateCollection({ id: 'nope', name: 'x' })
    ).rejects.toThrow(/not found/);
  });

  it('deletes a collection, cascading to children and trashing notes', async () => {
    const parent = await mockApi.createCollection({ name: 'Parent' });
    const child = await mockApi.createCollection({
      name: 'Child',
      parent_collection_id: parent.id
    });
    const note = await mockApi.createNote({
      title: 'doomed',
      parent_collection_id: parent.id
    });

    await mockApi.deleteCollection(parent.id);

    const cols = await mockApi.listCollections();
    expect(cols.find((c) => c.id === parent.id)).toBeUndefined();
    expect(cols.find((c) => c.id === child.id)).toBeUndefined();

    const reloaded = await mockApi.loadNote(note.id);
    expect(reloaded.trashed).toBe(true);
  });

  it('throws when deleting a missing collection', async () => {
    await expect(mockApi.deleteCollection('ghost')).rejects.toThrow(
      /not found/
    );
  });
});

describe('mock-store notes', () => {
  it('creates a note with defaults', async () => {
    const n = await mockApi.createNote({});
    expect(n.title).toBe('Untitled');
    expect(n.body).toBe('');
    expect(n.note_kind).toBe('markdown');
    expect(n.trashed).toBe(false);
  });

  it('lists notes and omits the body in summaries', async () => {
    const n = await mockApi.createNote({
      title: 'listed',
      body: 'secret body'
    });
    const list = await mockApi.listNotes(false);
    const found = list.find((s) => s.id === n.id);
    expect(found).toBeDefined();
    expect(found).not.toHaveProperty('body');
  });

  it('respects includeTrashed when listing', async () => {
    const n = await mockApi.createNote({ title: 'hidden' });
    await mockApi.trashNote(n.id);
    const withoutTrash = await mockApi.listNotes(false);
    const withTrash = await mockApi.listNotes(true);
    expect(withoutTrash.find((s) => s.id === n.id)).toBeUndefined();
    expect(withTrash.find((s) => s.id === n.id)).toBeDefined();
  });

  it('saves edits to title, body, tags and favourite', async () => {
    const n = await mockApi.createNote({ title: 'draft' });
    const saved = await mockApi.saveNote({
      id: n.id,
      title: 'final',
      body: 'updated',
      tags: ['a', 'b'],
      favourite: true
    });
    expect(saved.title).toBe('final');
    expect(saved.body).toBe('updated');
    expect(saved.tags).toEqual(['a', 'b']);
    expect(saved.favourite).toBe(true);
  });

  it('throws loading or saving a missing note', async () => {
    await expect(mockApi.loadNote('missing')).rejects.toThrow(/not found/);
    await expect(
      mockApi.saveNote({ id: 'missing', title: 'x' })
    ).rejects.toThrow(/not found/);
  });

  it('trashes and restores a note', async () => {
    const n = await mockApi.createNote({ title: 't' });
    await mockApi.trashNote(n.id);
    expect((await mockApi.loadNote(n.id)).trashed).toBe(true);
    await mockApi.restoreNote(n.id);
    expect((await mockApi.loadNote(n.id)).trashed).toBe(false);
  });

  it('marks notes under Trash descendants as trashed and counts them recursively', async () => {
    const before = await mockApi.trashCounts();
    const folder = await mockApi.createCollection({
      name: `Trash folder ${Date.now()}`,
      parent_collection_id: 'trash'
    });
    const child = await mockApi.createCollection({
      name: 'Nested trash folder',
      parent_collection_id: folder.id
    });
    const direct = await mockApi.createNote({
      title: 'direct trash child',
      parent_collection_id: 'trash'
    });
    const nested = await mockApi.createNote({
      title: 'nested trash child',
      parent_collection_id: child.id
    });
    const moved = await mockApi.createNote({ title: 'move me to trash' });

    expect(direct.trashed).toBe(true);
    expect(nested.trashed).toBe(true);
    expect(
      (await mockApi.saveNote({ id: moved.id, parent_collection_id: child.id }))
        .trashed
    ).toBe(true);
    expect(
      (await mockApi.saveNote({ id: moved.id, parent_collection_id: null }))
        .trashed
    ).toBe(false);

    const after = await mockApi.trashCounts();
    expect(after).toEqual({
      folders: before.folders + 2,
      notes: before.notes + 2
    });
  });

  it('treats collection cycles outside Trash as not trashed', async () => {
    const folder = await mockApi.createCollection({ name: 'Cyclic folder' });
    await mockApi.updateCollection({
      id: folder.id,
      parent_collection_id: folder.id
    });

    const note = await mockApi.createNote({
      title: 'cycle child',
      parent_collection_id: folder.id
    });

    expect(note.trashed).toBe(false);
  });

  it('restores notes from Trash descendants back to root', async () => {
    const folder = await mockApi.createCollection({
      name: 'Restorable trash folder',
      parent_collection_id: 'trash'
    });
    const note = await mockApi.createNote({
      title: 'restore from nested trash',
      parent_collection_id: folder.id
    });

    expect(note.trashed).toBe(true);
    await mockApi.restoreNote(note.id);

    const restored = await mockApi.loadNote(note.id);
    expect(restored.trashed).toBe(false);
    expect(restored.parent_collection_id).toBeNull();
  });

  it('empties Trash by purging direct and nested notes and folders', async () => {
    const folder = await mockApi.createCollection({
      name: 'Empty me',
      parent_collection_id: 'trash'
    });
    const child = await mockApi.createCollection({
      name: 'Empty me too',
      parent_collection_id: folder.id
    });
    const direct = await mockApi.createNote({
      title: 'purged direct',
      parent_collection_id: 'trash'
    });
    const nested = await mockApi.createNote({
      title: 'purged nested',
      parent_collection_id: child.id
    });

    const counts = await mockApi.emptyTrash();

    expect(counts.notes).toBeGreaterThanOrEqual(2);
    expect(counts.folders).toBeGreaterThanOrEqual(2);
    await expect(mockApi.loadNote(direct.id)).rejects.toThrow(/not found/);
    await expect(mockApi.loadNote(nested.id)).rejects.toThrow(/not found/);
    const remainingCollections = await mockApi.listCollections();
    expect(
      remainingCollections.find((c) => c.id === folder.id)
    ).toBeUndefined();
    expect(remainingCollections.find((c) => c.id === child.id)).toBeUndefined();
  });

  it('purges a note permanently', async () => {
    const n = await mockApi.createNote({ title: 'gone' });
    await mockApi.purgeNote(n.id);
    await expect(mockApi.loadNote(n.id)).rejects.toThrow(/not found/);
    await expect(mockApi.purgeNote(n.id)).rejects.toThrow(/not found/);
  });
});

describe('mock-store search', () => {
  it('finds notes by title and excludes trashed ones', async () => {
    const term = `zebra${Date.now()}`;
    const n = await mockApi.createNote({ title: term, body: 'body' });
    const hits = await mockApi.searchNotes(term);
    expect(hits.map((h) => h.note.id)).toContain(n.id);
    // Returned summaries drop the body / yjs fields.
    expect(hits[0].note).not.toHaveProperty('body');

    await mockApi.trashNote(n.id);
    const after = await mockApi.searchNotes(term);
    expect(after.map((h) => h.note.id)).not.toContain(n.id);
  });
});

describe('mock-store assets', () => {
  it('uploads and fetches a drawing asset', async () => {
    const n = await mockApi.createNote({ title: 'owner' });
    const bytes = [1, 2, 3, 4];
    const asset = await mockApi.uploadDrawingAsset({
      owning_note_id: n.id,
      mime_type: 'image/png',
      bytes
    });
    expect(asset.size).toBe(bytes.length);
    const fetched = await mockApi.fetchDrawingAsset(asset.id);
    expect(fetched.bytes).toEqual(bytes);
  });

  it('rejects uploads for an unknown owning note', async () => {
    await expect(
      mockApi.uploadDrawingAsset({
        owning_note_id: 'nope',
        mime_type: 'image/png',
        bytes: [0]
      })
    ).rejects.toThrow(/not found/);
  });

  it('throws fetching a missing asset', async () => {
    await expect(mockApi.fetchDrawingAsset('missing')).rejects.toThrow(
      /not found/
    );
  });

  it('purging a note cascades to its assets', async () => {
    const n = await mockApi.createNote({ title: 'with-asset' });
    const asset = await mockApi.uploadDrawingAsset({
      owning_note_id: n.id,
      mime_type: 'image/png',
      bytes: [9]
    });
    await mockApi.purgeNote(n.id);
    await expect(mockApi.fetchDrawingAsset(asset.id)).rejects.toThrow(
      /not found/
    );
  });

  it('imports a PDF note with an asset pointer in its body', async () => {
    const note = await mockApi.importPdfNote({
      title: 'doc.pdf',
      parent_collection_id: null,
      bytes: [37, 80, 68, 70]
    });
    expect(note.note_kind).toBe('pdf');
    const body = JSON.parse(note.body) as { pdfAssetId: string };
    expect(body.pdfAssetId).toMatch(/^asset_/);
    const asset = await mockApi.fetchDrawingAsset(body.pdfAssetId);
    expect(asset.mime_type).toBe('application/pdf');
  });

  it('makes PDF content searchable only once indexed via setPdfText', async () => {
    const note = await mockApi.importPdfNote({
      title: 'Spec',
      parent_collection_id: null,
      bytes: [37, 80, 68, 70]
    });

    // Un-indexed: it's listed as missing, needs text, and content isn't found.
    expect(await mockApi.pdfNotesMissingText()).toContain(note.id);
    expect(await mockApi.pdfNoteNeedsText(note.id)).toBe(true);
    expect(await mockApi.searchNotes('photosynthesis')).toEqual([]);

    await mockApi.setPdfText(note.id, 'all about photosynthesis');

    // Indexed: no longer missing, and the content is now searchable.
    expect(await mockApi.pdfNotesMissingText()).not.toContain(note.id);
    expect(await mockApi.pdfNoteNeedsText(note.id)).toBe(false);
    const hits = await mockApi.searchNotes('photosynthesis');
    expect(hits.map((h) => h.note.id)).toContain(note.id);
  });
});

describe('mock-store signatures', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('starts empty then saves a signature', async () => {
    expect(await mockApi.listSignatures()).toEqual([]);
    const rec = await mockApi.saveSignature({
      id: 'sig1',
      data: '{"strokes":[]}'
    });
    expect(rec.id).toBe('sig1');
    const list = await mockApi.listSignatures();
    expect(list.map((s) => s.id)).toEqual(['sig1']);
  });

  it('overwrites an existing signature by id', async () => {
    await mockApi.saveSignature({ id: 'sig1', data: 'first' });
    await mockApi.saveSignature({ id: 'sig1', data: 'second' });
    const list = await mockApi.listSignatures();
    expect(list).toHaveLength(1);
    expect(list[0].data).toBe('second');
  });

  it('deletes a signature', async () => {
    await mockApi.saveSignature({ id: 'sig1', data: 'x' });
    await mockApi.saveSignature({ id: 'sig2', data: 'y' });
    await mockApi.deleteSignature('sig1');
    const list = await mockApi.listSignatures();
    expect(list.map((s) => s.id)).toEqual(['sig2']);
  });
});

describe('mock-store note history', () => {
  async function freshNote(): Promise<string> {
    const note = await mockApi.createNote({
      title: 'History note',
      parent_collection_id: null,
      note_kind: 'markdown'
    });
    return note.id;
  }

  it('promotes the first version to created and dedups unchanged content', async () => {
    const id = await freshNote();
    const first = await mockApi.captureNoteVersion(
      id,
      'markdown',
      'edited',
      'hello world',
      null
    );
    expect(first?.action).toBe('created');
    expect(first?.words_added).toBe(2);

    const dup = await mockApi.captureNoteVersion(
      id,
      'markdown',
      'edited',
      'hello world',
      null
    );
    expect(dup).toBeNull();
    expect((await mockApi.listNoteVersions(id)).length).toBe(1);
  });

  it('records magnitude and lists newest first', async () => {
    const id = await freshNote();
    await mockApi.captureNoteVersion(
      id,
      'markdown',
      'edited',
      'alpha beta',
      null
    );
    const v2 = await mockApi.captureNoteVersion(
      id,
      'markdown',
      'edited',
      'alpha gamma delta',
      null
    );
    expect(v2?.words_added).toBe(2); // gamma, delta
    expect(v2?.words_removed).toBe(1); // beta
    const list = await mockApi.listNoteVersions(id);
    expect(list[0].id).toBe(v2?.id); // newest first
    expect(list).toHaveLength(2);
  });

  it('falls back to a token delta for word-neutral edits', async () => {
    const id = await freshNote();
    await mockApi.captureNoteVersion(
      id,
      'markdown',
      'edited',
      'hello world',
      null
    );
    const v = await mockApi.captureNoteVersion(
      id,
      'markdown',
      'edited',
      '**hello** world',
      null
    );
    expect(v?.words_added).toBe(0);
    expect(v?.words_removed).toBe(0);
    expect(v?.tokens_added).toBe(4); // four '*'
    expect(v?.tokens_removed).toBe(0);
  });

  it('captures the saved state for non-markdown notes', async () => {
    const note = await mockApi.createNote({
      title: 'Canvas',
      parent_collection_id: null,
      note_kind: 'freeform'
    });
    await mockApi.saveNote({ id: note.id, yrs_state: [1, 2, 3] });

    const version = await mockApi.captureCurrentNoteVersion(
      note.id,
      'edited',
      null
    );
    expect(version?.note_kind).toBe('freeform');
    expect(version?.words_added).toBe(0);
    expect(version?.tokens_added).toBeGreaterThan(0);

    const loaded = await mockApi.loadNoteVersion(version!.id);
    expect(JSON.parse(loaded.body)).toMatchObject({
      marker: 'mindstream-history-snapshot',
      noteKind: 'freeform',
      payloadKind: 'yjs-update'
    });
  });

  it('loads a version body and denormalises a revert target', async () => {
    const id = await freshNote();
    const target = await mockApi.captureNoteVersion(
      id,
      'markdown',
      'edited',
      'original text',
      null
    );
    await mockApi.captureNoteVersion(
      id,
      'markdown',
      'edited',
      'changed text',
      null
    );
    const loaded = await mockApi.loadNoteVersion(target!.id);
    expect(loaded.body).toBe('original text');

    const reverted = await mockApi.captureNoteVersion(
      id,
      'markdown',
      'reverted',
      'original text',
      target!.id
    );
    expect(reverted?.action).toBe('reverted');
    expect(reverted?.ref_version_id).toBe(target!.id);
    expect(reverted?.ref_created).toBe(target!.created);
  });
});

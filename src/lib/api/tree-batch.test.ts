import { describe, expect, it } from 'vitest';
import { mockApi } from './mock-store';
import { TRASH_ID } from './index';
import { moveMany, purgeMany, restoreMany, trashMany } from './tree-batch';

describe('tree batch API browser fallback', () => {
  it('moves mixed items to a target collection', async () => {
    const source = await mockApi.createCollection({ name: 'Batch source' });
    const target = await mockApi.createCollection({ name: 'Batch target' });
    const folder = await mockApi.createCollection({
      name: 'Batch folder',
      parent_collection_id: source.id
    });
    const note = await mockApi.createNote({
      title: 'Batch note',
      parent_collection_id: source.id
    });

    await expect(
      moveMany(
        [
          { kind: 'folder', id: folder.id },
          { kind: 'note', id: note.id }
        ],
        target.id
      )
    ).resolves.toEqual({ notes: 1, folders: 1 });

    const collections = await mockApi.listCollections();
    expect(
      collections.find((collection) => collection.id === folder.id)
        ?.parent_collection_id
    ).toBe(target.id);
    expect((await mockApi.loadNote(note.id)).parent_collection_id).toBe(
      target.id
    );
  });

  it('moves mixed items to trash and restores them to root', async () => {
    const folder = await mockApi.createCollection({ name: 'Batch trash me' });
    const note = await mockApi.createNote({ title: 'Batch trash note' });

    await expect(
      trashMany([
        { kind: 'folder', id: folder.id },
        { kind: 'note', id: note.id }
      ])
    ).resolves.toEqual({ notes: 1, folders: 1 });

    let collections = await mockApi.listCollections();
    expect(
      collections.find((collection) => collection.id === folder.id)
        ?.parent_collection_id
    ).toBe(TRASH_ID);
    expect((await mockApi.loadNote(note.id)).parent_collection_id).toBe(
      TRASH_ID
    );

    await expect(
      restoreMany([
        { kind: 'folder', id: folder.id },
        { kind: 'note', id: note.id }
      ])
    ).resolves.toEqual({ notes: 1, folders: 1 });

    collections = await mockApi.listCollections();
    expect(
      collections.find((collection) => collection.id === folder.id)
        ?.parent_collection_id
    ).toBeNull();
    expect((await mockApi.loadNote(note.id)).parent_collection_id).toBeNull();
  });

  it('purges mixed items permanently', async () => {
    const folder = await mockApi.createCollection({ name: 'Batch purge me' });
    const note = await mockApi.createNote({ title: 'Batch purge note' });

    await expect(
      purgeMany([
        { kind: 'folder', id: folder.id },
        { kind: 'note', id: note.id }
      ])
    ).resolves.toEqual({ notes: 1, folders: 1 });

    const collections = await mockApi.listCollections();
    expect(
      collections.find((collection) => collection.id === folder.id)
    ).toBeUndefined();
    await expect(mockApi.loadNote(note.id)).rejects.toThrow(/not found/);
  });
});

/**
 * Collections (folders) API. Mirror of src-tauri/src/collections/mod.rs.
 */

import { invokeOrFallback } from './index';
import { mockApi } from './mock-store';

export interface Collection {
  id: string;
  parent_collection_id: string | null;
  name: string;
  position: number;
  created: string;
  modified: string;
}

export interface CreateCollectionInput {
  name: string;
  parent_collection_id?: string | null;
}

export interface UpdateCollectionInput {
  id: string;
  name?: string;
  parent_collection_id?: string | null;
  position?: number;
}

export function listCollections(): Promise<Collection[]> {
  return invokeOrFallback<Collection[]>('list_collections', undefined, () =>
    mockApi.listCollections()
  );
}

export function createCollection(
  input: CreateCollectionInput
): Promise<Collection> {
  return invokeOrFallback<Collection>('create_collection', { input }, () =>
    mockApi.createCollection(input)
  );
}

export function updateCollection(
  input: UpdateCollectionInput
): Promise<Collection> {
  return invokeOrFallback<Collection>('update_collection', { input }, () =>
    mockApi.updateCollection(input)
  );
}

export function deleteCollection(id: string): Promise<void> {
  return invokeOrFallback<void>('delete_collection', { id }, () =>
    mockApi.deleteCollection(id)
  );
}

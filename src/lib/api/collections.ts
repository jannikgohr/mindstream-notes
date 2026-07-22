/**
 * Collections (folders) API. Mirror of src-tauri/src/collections/mod.rs.
 */

import {
  assertBoolean,
  assertNumber,
  assertRecord,
  assertString,
  assertVoid,
  invokeOrFallback,
  optionalString
} from './core';
import { mockApi } from './mock-store';

export interface Collection {
  id: string;
  parent_collection_id: string | null;
  name: string;
  position: number;
  created: string;
  modified: string;
  share_id?: string | null;
  shared_role?: string | null;
  shared_owner?: string | null;
  shared_by_me?: boolean;
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
  return invokeOrFallback<Collection[]>(
    'list_collections',
    undefined,
    () => mockApi.listCollections(),
    parseCollections
  );
}

export function createCollection(
  input: CreateCollectionInput
): Promise<Collection> {
  return invokeOrFallback<Collection>(
    'create_collection',
    { input },
    () => mockApi.createCollection(input),
    parseCollection
  );
}

export function updateCollection(
  input: UpdateCollectionInput
): Promise<Collection> {
  return invokeOrFallback<Collection>(
    'update_collection',
    { input },
    () => mockApi.updateCollection(input),
    parseCollection
  );
}

export function deleteCollection(id: string): Promise<void> {
  return invokeOrFallback<void>(
    'delete_collection',
    { id },
    () => mockApi.deleteCollection(id),
    (value) => assertVoid(value, 'delete_collection response')
  );
}

function parseCollection(value: unknown): Collection {
  const raw = assertRecord(value, 'collection');
  return {
    id: assertString(raw.id, 'collection.id'),
    parent_collection_id: optionalString(
      raw.parent_collection_id,
      'collection.parent_collection_id'
    ),
    name: assertString(raw.name, 'collection.name'),
    position: assertNumber(raw.position, 'collection.position'),
    created: assertString(raw.created, 'collection.created'),
    modified: assertString(raw.modified, 'collection.modified'),
    share_id: optionalString(raw.share_id, 'collection.share_id'),
    shared_role: optionalString(raw.shared_role, 'collection.shared_role'),
    shared_owner: optionalString(raw.shared_owner, 'collection.shared_owner'),
    shared_by_me: assertBoolean(raw.shared_by_me, 'collection.shared_by_me')
  };
}

function parseCollections(value: unknown): Collection[] {
  if (!Array.isArray(value))
    throw new Error('collections response must be an array');
  return value.map(parseCollection);
}

import { invokeOrFallback } from './core';

export type CollectionShareAccessLevel = 'read_only' | 'read_write' | 'admin';

export interface CollectionInvitation {
  id: string;
  username: string;
  sender_username: string | null;
  collection_uid: string;
  access_level: CollectionShareAccessLevel;
  collection_type: string | null;
}

export type ShareScopePart = 'folders' | 'notes' | 'assets';

export interface IncomingShareBundlePart {
  part: ShareScopePart;
  collection_uid: string | null;
  expected_collection_type: string;
  required: boolean;
  invitation: CollectionInvitation | null;
}

export interface IncomingShareBundle {
  manifest_invitation_id: string;
  manifest_collection_uid: string;
  share_scope_id: string;
  name: string;
  root_folder_id: string;
  owner_username: string | null;
  sender_username: string | null;
  access_level: CollectionShareAccessLevel | null;
  complete: boolean;
  parts: IncomingShareBundlePart[];
  warnings: string[];
}

export interface IncomingShareInvitations {
  bundles: IncomingShareBundle[];
  unbundled_invitations: CollectionInvitation[];
}

export interface InviteCollectionInput {
  collection_id: string;
  username: string;
  access_level: CollectionShareAccessLevel;
}

export interface CollectionMember {
  username: string;
  access_level: CollectionShareAccessLevel;
}

export interface CollectionShareState {
  collection_id: string;
  share_id: string | null;
  shared_role: CollectionShareAccessLevel | null;
  shared_owner: string | null;
  shared_by_me: boolean;
  members: CollectionMember[];
  outgoing_invitations: CollectionInvitation[];
}

export function listCollectionInvitations(): Promise<CollectionInvitation[]> {
  return invokeOrFallback<CollectionInvitation[]>(
    'list_collection_invitations',
    undefined,
    async () => []
  );
}

export function listIncomingShareBundles(): Promise<IncomingShareInvitations> {
  return invokeOrFallback<IncomingShareInvitations>(
    'list_incoming_share_bundles',
    undefined,
    async () => ({ bundles: [], unbundled_invitations: [] })
  );
}

export function acceptCollectionInvitation(id: string): Promise<void> {
  return invokeOrFallback<void>(
    'accept_collection_invitation',
    { id },
    async () => undefined
  );
}

export function rejectCollectionInvitation(id: string): Promise<void> {
  return invokeOrFallback<void>(
    'reject_collection_invitation',
    { id },
    async () => undefined
  );
}

export function inviteCollection(
  input: InviteCollectionInput
): Promise<CollectionShareState> {
  return invokeOrFallback<CollectionShareState>(
    'invite_collection',
    { input },
    async () => {
      throw new Error(
        'Collection sharing is only available in the Tauri desktop app.'
      );
    }
  );
}

export function getCollectionShareState(
  collectionId: string
): Promise<CollectionShareState> {
  return invokeOrFallback<CollectionShareState>(
    'get_collection_share_state',
    { collectionId },
    async () => ({
      collection_id: collectionId,
      share_id: null,
      shared_role: null,
      shared_owner: null,
      shared_by_me: false,
      members: [],
      outgoing_invitations: []
    })
  );
}

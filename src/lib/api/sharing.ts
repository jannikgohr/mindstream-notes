import {
  assertBoolean,
  assertRecord,
  assertString,
  assertStringArray,
  assertVoid,
  invokeOrFallback,
  optionalString
} from './core';

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
  // True while the manifest invitation is unaccepted: the scan reads it by
  // non-mutating preview only, so name/share_scope_id/root_folder_id/parts are
  // unknown until the user accepts. Accept/decline still work by uid.
  pending: boolean;
  share_scope_id: string | null;
  name: string | null;
  root_folder_id: string | null;
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
    async () => [],
    parseCollectionInvitations
  );
}

export function listIncomingShareBundles(): Promise<IncomingShareInvitations> {
  return invokeOrFallback<IncomingShareInvitations>(
    'list_incoming_share_bundles',
    undefined,
    async () => ({ bundles: [], unbundled_invitations: [] }),
    parseIncomingShareInvitations
  );
}

export function acceptShareBundle(
  manifestCollectionUid: string
): Promise<void> {
  assertRequiredString(manifestCollectionUid, 'manifestCollectionUid');
  return invokeOrFallback<void>(
    'accept_share_bundle',
    { manifestCollectionUid },
    async () => undefined,
    (value) => assertVoid(value, 'accept_share_bundle response')
  );
}

export function declineShareBundle(
  manifestCollectionUid: string
): Promise<void> {
  assertRequiredString(manifestCollectionUid, 'manifestCollectionUid');
  return invokeOrFallback<void>(
    'decline_share_bundle',
    { manifestCollectionUid },
    async () => undefined,
    (value) => assertVoid(value, 'decline_share_bundle response')
  );
}

/**
 * Leave a folder shared *with* the current user. Relinquishes membership of the
 * scope's collections server-side and purges the locally-pulled subtree. No-op
 * fallback in browser mode (sharing is Tauri-only).
 */
export function leaveSharedCollection(collectionId: string): Promise<void> {
  assertRequiredString(collectionId, 'collectionId');
  return invokeOrFallback<void>(
    'leave_shared_collection',
    { collectionId },
    async () => undefined,
    (value) => assertVoid(value, 'leave_shared_collection response')
  );
}

/**
 * Stop sharing a folder the current user owns. The owner keeps the folder (it
 * re-homes into their personal vault); the scope's collections are deleted
 * server-side so every recipient's device removes its copy on the next sync.
 * No-op fallback in browser mode (sharing is Tauri-only).
 */
export function stopSharingCollection(collectionId: string): Promise<void> {
  assertRequiredString(collectionId, 'collectionId');
  return invokeOrFallback<void>(
    'stop_sharing_collection',
    { collectionId },
    async () => undefined,
    (value) => assertVoid(value, 'stop_sharing_collection response')
  );
}

/** Everyone with access to a shared folder and at what level. Empty in browser
 *  mode (sharing is Tauri-only). */
export function listCollectionMembers(
  collectionId: string
): Promise<CollectionMember[]> {
  assertRequiredString(collectionId, 'collectionId');
  return invokeOrFallback<CollectionMember[]>(
    'list_collection_members',
    { collectionId },
    async () => [],
    parseCollectionMembers
  );
}

/** Change one member's access level on a folder the current user shares. */
export function setCollectionMemberAccess(input: {
  collection_id: string;
  username: string;
  access_level: CollectionShareAccessLevel;
}): Promise<void> {
  assertRequiredString(input.collection_id, 'input.collection_id');
  assertRequiredString(input.username, 'input.username');
  parseAccessLevel(input.access_level, 'input.access_level');
  return invokeOrFallback<void>(
    'set_collection_member_access',
    { input },
    async () => undefined,
    (value) => assertVoid(value, 'set_collection_member_access response')
  );
}

/** Remove one member from a folder the current user shares; their device purges
 *  its copy on the next sync. */
export function removeCollectionMember(input: {
  collection_id: string;
  username: string;
}): Promise<void> {
  assertRequiredString(input.collection_id, 'input.collection_id');
  assertRequiredString(input.username, 'input.username');
  return invokeOrFallback<void>(
    'remove_collection_member',
    { input },
    async () => undefined,
    (value) => assertVoid(value, 'remove_collection_member response')
  );
}

export function acceptCollectionInvitation(id: string): Promise<void> {
  assertRequiredString(id, 'id');
  return invokeOrFallback<void>(
    'accept_collection_invitation',
    { id },
    async () => undefined,
    (value) => assertVoid(value, 'accept_collection_invitation response')
  );
}

export function rejectCollectionInvitation(id: string): Promise<void> {
  assertRequiredString(id, 'id');
  return invokeOrFallback<void>(
    'reject_collection_invitation',
    { id },
    async () => undefined,
    (value) => assertVoid(value, 'reject_collection_invitation response')
  );
}

export function inviteCollection(
  input: InviteCollectionInput
): Promise<CollectionShareState> {
  assertRequiredString(input.collection_id, 'input.collection_id');
  assertRequiredString(input.username, 'input.username');
  parseAccessLevel(input.access_level, 'input.access_level');
  return invokeOrFallback<CollectionShareState>(
    'invite_collection',
    { input },
    async () => {
      throw new Error(
        'Collection sharing is only available in the Tauri desktop app.'
      );
    },
    parseCollectionShareState
  );
}

export function getCollectionShareState(
  collectionId: string
): Promise<CollectionShareState> {
  assertRequiredString(collectionId, 'collectionId');
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
    }),
    parseCollectionShareState
  );
}

function assertRequiredString(value: string, context: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${context} must be a non-empty string`);
  }
}

function parseAccessLevel(
  value: unknown,
  context: string
): CollectionShareAccessLevel {
  const accessLevel = assertString(value, context);
  switch (accessLevel) {
    case 'read_only':
    case 'read_write':
    case 'admin':
      return accessLevel;
    default: {
      const _exhaustive: never = accessLevel as never;
      throw new Error(`${context} has unknown access level: ${_exhaustive}`);
    }
  }
}

function parseNullableAccessLevel(
  value: unknown,
  context: string
): CollectionShareAccessLevel | null {
  if (value === null || value === undefined) return null;
  return parseAccessLevel(value, context);
}

function parseShareScopePart(value: unknown, context: string): ShareScopePart {
  const part = assertString(value, context);
  switch (part) {
    case 'folders':
    case 'notes':
    case 'assets':
      return part;
    default: {
      const _exhaustive: never = part as never;
      throw new Error(`${context} has unknown share part: ${_exhaustive}`);
    }
  }
}

function parseCollectionInvitation(value: unknown): CollectionInvitation {
  const raw = assertRecord(value, 'collection invitation');
  return {
    id: assertString(raw.id, 'collection invitation.id'),
    username: assertString(raw.username, 'collection invitation.username'),
    sender_username: optionalString(
      raw.sender_username,
      'collection invitation.sender_username'
    ),
    collection_uid: assertString(
      raw.collection_uid,
      'collection invitation.collection_uid'
    ),
    access_level: parseAccessLevel(
      raw.access_level,
      'collection invitation.access_level'
    ),
    collection_type: optionalString(
      raw.collection_type,
      'collection invitation.collection_type'
    )
  };
}

function parseCollectionInvitations(value: unknown): CollectionInvitation[] {
  if (!Array.isArray(value)) {
    throw new Error('collection invitations must be an array');
  }
  return value.map((item) => parseCollectionInvitation(item));
}

function parseIncomingShareBundlePart(value: unknown): IncomingShareBundlePart {
  const raw = assertRecord(value, 'incoming share bundle part');
  const invitation =
    raw.invitation === null || raw.invitation === undefined
      ? null
      : parseCollectionInvitation(raw.invitation);
  return {
    part: parseShareScopePart(raw.part, 'incoming share bundle part.part'),
    collection_uid: optionalString(
      raw.collection_uid,
      'incoming share bundle part.collection_uid'
    ),
    expected_collection_type: assertString(
      raw.expected_collection_type,
      'incoming share bundle part.expected_collection_type'
    ),
    required: assertBoolean(
      raw.required,
      'incoming share bundle part.required'
    ),
    invitation
  };
}

function parseIncomingShareBundleParts(
  value: unknown
): IncomingShareBundlePart[] {
  if (!Array.isArray(value)) {
    throw new Error('incoming share bundle parts must be an array');
  }
  return value.map((item) => parseIncomingShareBundlePart(item));
}

function parseIncomingShareBundle(value: unknown): IncomingShareBundle {
  const raw = assertRecord(value, 'incoming share bundle');
  return {
    manifest_invitation_id: assertString(
      raw.manifest_invitation_id,
      'incoming share bundle.manifest_invitation_id'
    ),
    manifest_collection_uid: assertString(
      raw.manifest_collection_uid,
      'incoming share bundle.manifest_collection_uid'
    ),
    pending: assertBoolean(raw.pending, 'incoming share bundle.pending'),
    share_scope_id: optionalString(
      raw.share_scope_id,
      'incoming share bundle.share_scope_id'
    ),
    name: optionalString(raw.name, 'incoming share bundle.name'),
    root_folder_id: optionalString(
      raw.root_folder_id,
      'incoming share bundle.root_folder_id'
    ),
    owner_username: optionalString(
      raw.owner_username,
      'incoming share bundle.owner_username'
    ),
    sender_username: optionalString(
      raw.sender_username,
      'incoming share bundle.sender_username'
    ),
    access_level: parseNullableAccessLevel(
      raw.access_level,
      'incoming share bundle.access_level'
    ),
    complete: assertBoolean(raw.complete, 'incoming share bundle.complete'),
    parts: parseIncomingShareBundleParts(raw.parts),
    warnings: assertStringArray(raw.warnings, 'incoming share bundle.warnings')
  };
}

function parseIncomingShareBundles(value: unknown): IncomingShareBundle[] {
  if (!Array.isArray(value)) {
    throw new Error('incoming share bundles must be an array');
  }
  return value.map((item) => parseIncomingShareBundle(item));
}

function parseIncomingShareInvitations(
  value: unknown
): IncomingShareInvitations {
  const raw = assertRecord(value, 'incoming share invitations');
  return {
    bundles: parseIncomingShareBundles(raw.bundles),
    unbundled_invitations: parseCollectionInvitations(raw.unbundled_invitations)
  };
}

function parseCollectionMember(value: unknown): CollectionMember {
  const raw = assertRecord(value, 'collection member');
  return {
    username: assertString(raw.username, 'collection member.username'),
    access_level: parseAccessLevel(
      raw.access_level,
      'collection member.access_level'
    )
  };
}

function parseCollectionMembers(value: unknown): CollectionMember[] {
  if (!Array.isArray(value)) {
    throw new Error('collection members must be an array');
  }
  return value.map((item) => parseCollectionMember(item));
}

function parseCollectionShareState(value: unknown): CollectionShareState {
  const raw = assertRecord(value, 'collection share state');
  return {
    collection_id: assertString(
      raw.collection_id,
      'collection share state.collection_id'
    ),
    share_id: optionalString(raw.share_id, 'collection share state.share_id'),
    shared_role: parseNullableAccessLevel(
      raw.shared_role,
      'collection share state.shared_role'
    ),
    shared_owner: optionalString(
      raw.shared_owner,
      'collection share state.shared_owner'
    ),
    shared_by_me: assertBoolean(
      raw.shared_by_me,
      'collection share state.shared_by_me'
    ),
    members: parseCollectionMembers(raw.members),
    outgoing_invitations: parseCollectionInvitations(raw.outgoing_invitations)
  };
}

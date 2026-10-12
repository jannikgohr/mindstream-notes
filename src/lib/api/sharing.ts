import { assertRequiredString } from '$lib/validation';
import {
  assertBoolean,
  assertRecord,
  assertString,
  assertVoid,
  TauriCommandName,
  invokeOrFallback,
  optionalString
} from './core';

export type CollectionShareAccessLevel = 'read_only' | 'read_write' | 'admin';

/** An invitation to a shared folder that has not been answered. */
export interface IncomingShare {
  invitation_id: string;
  /** The shared folder's collection on the server. */
  collection_uid: string;
  /** The folder's name. Null only when the server did not send it along. */
  name: string | null;
  sender_username: string | null;
  access_level: CollectionShareAccessLevel;
}

/** An invitation this account sent that has not been answered. */
export interface OutgoingInvitation {
  id: string;
  username: string;
  access_level: CollectionShareAccessLevel;
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
  outgoing_invitations: OutgoingInvitation[];
}

/** The invitations to shared folders that wait for an answer. */
export function listIncomingShares(): Promise<IncomingShare[]> {
  return invokeOrFallback<IncomingShare[]>(
    TauriCommandName.ListIncomingShares,
    undefined,
    async () => [],
    parseIncomingShares
  );
}

/**
 * Accept an invitation to a shared folder. Nothing appears at once: the next
 * sync pulls the folder in.
 */
export function acceptShare(invitationId: string): Promise<void> {
  assertRequiredString(invitationId, 'invitationId');
  return invokeOrFallback<void>(
    TauriCommandName.AcceptShare,
    { invitationId },
    async () => undefined,
    (value) => assertVoid(value, 'accept_share response')
  );
}

export function declineShare(invitationId: string): Promise<void> {
  assertRequiredString(invitationId, 'invitationId');
  return invokeOrFallback<void>(
    TauriCommandName.DeclineShare,
    { invitationId },
    async () => undefined,
    (value) => assertVoid(value, 'decline_share response')
  );
}

/**
 * Leave a folder shared *with* the current user. Gives up the membership on
 * the server and removes the folder from this device. No-op fallback in
 * browser mode (sharing is Tauri-only).
 */
export function leaveSharedCollection(collectionId: string): Promise<void> {
  assertRequiredString(collectionId, 'collectionId');
  return invokeOrFallback<void>(
    TauriCommandName.LeaveSharedCollection,
    { collectionId },
    async () => undefined,
    (value) => assertVoid(value, 'leave_shared_collection response')
  );
}

/**
 * Stop sharing a folder the current user owns. The owner keeps the folder,
 * which goes back into their own vault. The shared collection is deleted on
 * the server, so every other member's device removes its copy on its next
 * sync. No-op fallback in browser mode (sharing is Tauri-only).
 */
export function stopSharingCollection(collectionId: string): Promise<void> {
  assertRequiredString(collectionId, 'collectionId');
  return invokeOrFallback<void>(
    TauriCommandName.StopSharingCollection,
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
    TauriCommandName.ListCollectionMembers,
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
    TauriCommandName.SetCollectionMemberAccess,
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
    TauriCommandName.RemoveCollectionMember,
    { input },
    async () => undefined,
    (value) => assertVoid(value, 'remove_collection_member response')
  );
}

export function inviteCollection(
  input: InviteCollectionInput
): Promise<CollectionShareState> {
  assertRequiredString(input.collection_id, 'input.collection_id');
  assertRequiredString(input.username, 'input.username');
  parseAccessLevel(input.access_level, 'input.access_level');
  return invokeOrFallback<CollectionShareState>(
    TauriCommandName.InviteCollection,
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
    TauriCommandName.GetCollectionShareState,
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

function parseIncomingShare(value: unknown): IncomingShare {
  const raw = assertRecord(value, 'incoming share');
  return {
    invitation_id: assertString(
      raw.invitation_id,
      'incoming share.invitation_id'
    ),
    collection_uid: assertString(
      raw.collection_uid,
      'incoming share.collection_uid'
    ),
    name: optionalString(raw.name, 'incoming share.name'),
    sender_username: optionalString(
      raw.sender_username,
      'incoming share.sender_username'
    ),
    access_level: parseAccessLevel(
      raw.access_level,
      'incoming share.access_level'
    )
  };
}

function parseIncomingShares(value: unknown): IncomingShare[] {
  if (!Array.isArray(value)) {
    throw new Error('incoming shares must be an array');
  }
  return value.map((item) => parseIncomingShare(item));
}

function parseOutgoingInvitation(value: unknown): OutgoingInvitation {
  const raw = assertRecord(value, 'outgoing invitation');
  return {
    id: assertString(raw.id, 'outgoing invitation.id'),
    username: assertString(raw.username, 'outgoing invitation.username'),
    access_level: parseAccessLevel(
      raw.access_level,
      'outgoing invitation.access_level'
    )
  };
}

function parseOutgoingInvitations(value: unknown): OutgoingInvitation[] {
  if (!Array.isArray(value)) {
    throw new Error('outgoing invitations must be an array');
  }
  return value.map((item) => parseOutgoingInvitation(item));
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
    outgoing_invitations: parseOutgoingInvitations(raw.outgoing_invitations)
  };
}

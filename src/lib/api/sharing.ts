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

/**
 * How a key stands against the one this device remembers for its owner:
 * none remembered yet, the same one, or another one.
 */
export type KeyStanding = 'new' | 'known' | 'changed';

/** A user's key, with what someone needs to check it. */
export interface UserKey {
  username: string;
  standing: KeyStanding;
  /** The key the server gives now, as digits two people can compare. */
  fingerprint: string;
  /** The key remembered, when it is another one. */
  known_fingerprint: string | null;
}

/** An invitation to a shared folder that has not been answered. */
export interface IncomingShare {
  invitation_id: string;
  /** The shared folder's collection on the server. */
  collection_uid: string;
  /** The folder's name. Null only when the server did not send it along. */
  name: string | null;
  sender_username: string | null;
  access_level: CollectionShareAccessLevel;
  /** The sender's key. Null when the invitation names no sender. */
  sender_key: UserKey | null;
}

/** An invitation this account sent that has not been answered. */
export interface OutgoingInvitation {
  id: string;
  username: string;
  access_level: CollectionShareAccessLevel;
}

/** What an invite link may give: a link never makes someone an admin. */
export type ShareLinkAccessLevel = 'read_only' | 'read_write';

export interface CreateShareLinkInput {
  collection_id: string;
  access_level: ShareLinkAccessLevel;
  /** How many people the link lets in. The server's default is one. */
  max_uses?: number;
  /** How long it lasts. The server's default is a week. */
  expires_in_days?: number;
  /** Whether it may create an account for someone who has none. */
  allow_signup?: boolean;
}

/** A link that was just made. `link` is the only copy of its secret. */
export interface CreatedShareLink {
  link: string;
  uid: string;
}

/** A link as the people who manage a folder see it. */
export interface ShareLink {
  uid: string;
  access_level: CollectionShareAccessLevel;
  max_uses: number;
  uses: number;
  allows_signup: boolean;
  /** Seconds since 1970. */
  expires_at: number;
  created_at: number;
  sender_username: string;
}

/** What a link leads to, for someone deciding whether to join. */
export interface ShareLinkPreview {
  server_url: string;
  collection_uid: string;
  name: string | null;
  sender_username: string;
  access_level: CollectionShareAccessLevel;
  /** The link can still create an account on its server. */
  can_signup: boolean;
  /** This device is signed in to the link's server, so it can join. */
  signed_in: boolean;
  /** The folder is on this device already. */
  already_member: boolean;
}

export interface InviteCollectionInput {
  collection_id: string;
  username: string;
  access_level: CollectionShareAccessLevel;
  /**
   * The user has seen that the recipient's key is not the one this device
   * remembers, and said to share with the new one.
   */
  trust_changed_key?: boolean;
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
 *
 * An invitation from a key that is not the one remembered for its sender is
 * refused with the reason `key_changed`, unless `trustChangedKey` says the
 * user has seen that and wants to go on.
 */
export function acceptShare(
  invitationId: string,
  options: { trustChangedKey?: boolean } = {}
): Promise<void> {
  assertRequiredString(invitationId, 'invitationId');
  return invokeOrFallback<void>(
    TauriCommandName.AcceptShare,
    { invitationId, trustChangedKey: options.trustChangedKey === true },
    async () => undefined,
    (value) => assertVoid(value, 'accept_share response')
  );
}

/**
 * The key the server gives for a user now, held against the one this device
 * remembers. For showing what changed before someone decides.
 */
export function userKeyInfo(username: string): Promise<UserKey> {
  assertRequiredString(username, 'username');
  return invokeOrFallback<UserKey>(
    TauriCommandName.UserKeyInfo,
    { username },
    async () => {
      throw new Error(
        'Collection sharing is only available in the Tauri desktop app.'
      );
    },
    (value) => parseUserKey(value, 'user key')
  );
}

/**
 * This account's own key as digits, for someone else to compare with what
 * their app shows for this account.
 */
export function ownKeyFingerprint(): Promise<string> {
  return invokeOrFallback<string>(
    TauriCommandName.OwnKeyFingerprint,
    undefined,
    async () => {
      throw new Error(
        'Collection sharing is only available in the Tauri desktop app.'
      );
    },
    (value) => assertString(value, 'own key fingerprint')
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

/**
 * Make an invite link to a folder, sharing the folder first if it is not
 * shared yet. The link comes back once and cannot be shown again.
 */
export function createShareLink(
  input: CreateShareLinkInput
): Promise<CreatedShareLink> {
  assertRequiredString(input.collection_id, 'input.collection_id');
  if (input.access_level !== 'read_only' && input.access_level !== 'read_write')
    throw new Error('an invite link can let people view or edit');
  return invokeOrFallback<CreatedShareLink>(
    TauriCommandName.CreateShareLink,
    { input },
    async () => {
      throw new Error(
        'Collection sharing is only available in the Tauri desktop app.'
      );
    },
    parseCreatedShareLink
  );
}

/**
 * The links into a folder that have not run out of time. One that is used
 * up stays listed until then, so that its maker sees it was used.
 */
export function listShareLinks(collectionId: string): Promise<ShareLink[]> {
  assertRequiredString(collectionId, 'collectionId');
  return invokeOrFallback<ShareLink[]>(
    TauriCommandName.ListShareLinks,
    { collectionId },
    async () => [],
    parseShareLinks
  );
}

/** Remove a link, so that it lets nobody else in. */
export function revokeShareLink(uid: string): Promise<void> {
  assertRequiredString(uid, 'uid');
  return invokeOrFallback<void>(
    TauriCommandName.RevokeShareLink,
    { uid },
    async () => undefined,
    (value) => assertVoid(value, 'revoke_share_link response')
  );
}

/** Look at what a pasted link leads to. Joins nothing. */
export function openShareLink(link: string): Promise<ShareLinkPreview> {
  assertRequiredString(link, 'link');
  return invokeOrFallback<ShareLinkPreview>(
    TauriCommandName.OpenShareLink,
    { link },
    async () => {
      throw new Error(
        'Collection sharing is only available in the Tauri desktop app.'
      );
    },
    parseShareLinkPreview
  );
}

/**
 * Join the shared folder a link leads to. Nothing appears at once: the next
 * sync pulls the folder in.
 */
export function claimShareLink(link: string): Promise<void> {
  assertRequiredString(link, 'link');
  return invokeOrFallback<void>(
    TauriCommandName.ClaimShareLink,
    { link },
    async () => {
      throw new Error(
        'Collection sharing is only available in the Tauri desktop app.'
      );
    },
    (value) => assertVoid(value, 'claim_share_link response')
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
    ),
    sender_key:
      raw.sender_key === null || raw.sender_key === undefined
        ? null
        : parseUserKey(raw.sender_key, 'incoming share.sender_key')
  };
}

function parseUserKey(value: unknown, context: string): UserKey {
  const raw = assertRecord(value, context);
  const standing = raw.standing;
  if (standing !== 'new' && standing !== 'known' && standing !== 'changed') {
    throw new Error(`${context}.standing is not one this app knows`);
  }
  return {
    username: assertString(raw.username, `${context}.username`),
    standing,
    fingerprint: assertString(raw.fingerprint, `${context}.fingerprint`),
    known_fingerprint: optionalString(
      raw.known_fingerprint,
      `${context}.known_fingerprint`
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

/**
 * The invite link that was opened from outside the app, once. Null when
 * none waits. See `$lib/sharing/opened-links`.
 */
export function takePendingInviteLink(): Promise<string | null> {
  return invokeOrFallback<string | null>(
    TauriCommandName.TakePendingInviteLink,
    undefined,
    async () => null,
    (value) => optionalString(value, 'pending invite link')
  );
}

function parseCreatedShareLink(value: unknown): CreatedShareLink {
  const raw = assertRecord(value, 'created share link');
  return {
    link: assertString(raw.link, 'created share link.link'),
    uid: assertString(raw.uid, 'created share link.uid')
  };
}

function assertCount(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${context} must be a number`);
  }
  return value;
}

function parseShareLink(value: unknown): ShareLink {
  const raw = assertRecord(value, 'share link');
  return {
    uid: assertString(raw.uid, 'share link.uid'),
    access_level: parseAccessLevel(raw.access_level, 'share link.access_level'),
    max_uses: assertCount(raw.max_uses, 'share link.max_uses'),
    uses: assertCount(raw.uses, 'share link.uses'),
    allows_signup: assertBoolean(raw.allows_signup, 'share link.allows_signup'),
    expires_at: assertCount(raw.expires_at, 'share link.expires_at'),
    created_at: assertCount(raw.created_at, 'share link.created_at'),
    sender_username: assertString(
      raw.sender_username,
      'share link.sender_username'
    )
  };
}

function parseShareLinks(value: unknown): ShareLink[] {
  if (!Array.isArray(value)) {
    throw new Error('share links must be an array');
  }
  return value.map((item) => parseShareLink(item));
}

function parseShareLinkPreview(value: unknown): ShareLinkPreview {
  const raw = assertRecord(value, 'share link preview');
  return {
    server_url: assertString(raw.server_url, 'share link preview.server_url'),
    collection_uid: assertString(
      raw.collection_uid,
      'share link preview.collection_uid'
    ),
    name: optionalString(raw.name, 'share link preview.name'),
    sender_username: assertString(
      raw.sender_username,
      'share link preview.sender_username'
    ),
    access_level: parseAccessLevel(
      raw.access_level,
      'share link preview.access_level'
    ),
    can_signup: assertBoolean(raw.can_signup, 'share link preview.can_signup'),
    signed_in: assertBoolean(raw.signed_in, 'share link preview.signed_in'),
    already_member: assertBoolean(
      raw.already_member,
      'share link preview.already_member'
    )
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
    outgoing_invitations: parseOutgoingInvitations(raw.outgoing_invitations)
  };
}

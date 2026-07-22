import { authSession, etebaseSession, type SessionInfo } from '$lib/api';
import type { RoomInfo } from '$lib/api/sync';
import {
  generateCollabSigningKeyPair,
  type CollabFrameAuth
} from './signed-collab-frame';

export interface CollabSigningMaterial {
  username: string;
  publicKeyB64: string;
  privateKeyPkcs8B64: string;
}

const STORAGE_PREFIX = 'mindstream:collab-signing-key:v1';

function storageKey(session: SessionInfo): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(session.server_url)}:${encodeURIComponent(session.username)}`;
}

function parseStored(value: string | null): CollabSigningMaterial | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Partial<CollabSigningMaterial>;
    if (
      typeof record.publicKeyB64 === 'string' &&
      typeof record.privateKeyPkcs8B64 === 'string'
    ) {
      return {
        username: typeof record.username === 'string' ? record.username : '',
        publicKeyB64: record.publicKeyB64,
        privateKeyPkcs8B64: record.privateKeyPkcs8B64
      };
    }
  } catch {
    /* ignore corrupt local storage */
  }
  return null;
}

async function currentSession(): Promise<SessionInfo | null> {
  if (authSession.current) return authSession.current;
  return await etebaseSession();
}

export async function getOrCreateCollabSigningMaterial(): Promise<CollabSigningMaterial | null> {
  if (typeof window === 'undefined') return null;
  const session = await currentSession();
  if (!session) return null;
  const key = storageKey(session);
  const existing = parseStored(window.localStorage.getItem(key));
  if (existing) return { ...existing, username: session.username };

  const generated = await generateCollabSigningKeyPair();
  const material: CollabSigningMaterial = {
    username: session.username,
    publicKeyB64: generated.publicKeyB64,
    privateKeyPkcs8B64: generated.privateKeyPkcs8B64
  };
  window.localStorage.setItem(key, JSON.stringify(material));
  return material;
}

export function collabAuthForRoom(
  room: RoomInfo,
  material: CollabSigningMaterial | null
): CollabFrameAuth | undefined {
  const authorizedWriters =
    room.writer_auth?.authorized_writers.map((writer) => ({
      username: writer.username,
      publicKeyB64: writer.public_key_b64
    })) ?? null;
  if (!authorizedWriters) return undefined;

  const canWrite = Boolean(
    material &&
    authorizedWriters.some(
      (writer) =>
        writer.username === material.username &&
        writer.publicKeyB64 === material.publicKeyB64
    )
  );
  return {
    roomId: room.room_id,
    collabEpoch: room.collab_epoch,
    authorizedWriters,
    authorUsername: canWrite ? material!.username : undefined,
    authorPublicKeyB64: canWrite ? material!.publicKeyB64 : undefined,
    authorPrivateKeyPkcs8B64: canWrite
      ? material!.privateKeyPkcs8B64
      : undefined
  };
}

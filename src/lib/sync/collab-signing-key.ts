import { authSession, etebaseSession, type SessionInfo } from '$lib/api';
import type { RoomInfo } from '$lib/api/sync';
import {
  generateCollabSigningKeyPair,
  type CollabFrameAuth
} from './signed-collab-frame';

export interface CollabSigningMaterial {
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
    const parsed = JSON.parse(value) as Partial<CollabSigningMaterial>;
    if (parsed.publicKeyB64 && parsed.privateKeyPkcs8B64) {
      return {
        publicKeyB64: parsed.publicKeyB64,
        privateKeyPkcs8B64: parsed.privateKeyPkcs8B64
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
  if (existing) return existing;

  const generated = await generateCollabSigningKeyPair();
  const material: CollabSigningMaterial = {
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
  const authorizedWriterKeysB64 =
    room.writer_auth?.authorized_writer_keys_b64 ?? null;
  if (!authorizedWriterKeysB64) return undefined;

  const canWrite = Boolean(
    material && authorizedWriterKeysB64.includes(material.publicKeyB64)
  );
  return {
    roomId: room.room_id,
    collabEpoch: room.collab_epoch,
    authorizedWriterKeysB64,
    authorPublicKeyB64: canWrite ? material!.publicKeyB64 : undefined,
    authorPrivateKeyPkcs8B64: canWrite
      ? material!.privateKeyPkcs8B64
      : undefined
  };
}

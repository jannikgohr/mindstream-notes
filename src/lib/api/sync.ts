/**
 * Sync bridge. Mirror of src-tauri/src/sync/mod.rs.
 *
 * One-shot pull/push against the Etebase server. The user must already
 * be signed in (see api/auth.ts); calling this when signed out resolves
 * with an "not signed in" error from the Rust side.
 */

import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { isTauri } from './core';

export interface SyncReport {
  folders_pulled: number;
  folders_pushed: number;
  notes_pulled: number;
  notes_pushed: number;
  assets_pulled: number;
  assets_pushed: number;
  conflicts_resolved: number;
}

export async function syncNow(): Promise<SyncReport> {
  if (!isTauri()) {
    throw new Error('Sync is only available in the desktop app.');
  }
  return await tauriInvoke<SyncReport>('sync_now');
}

/**
 * What the live-collab editor needs to join a note's room. `null` means
 * the note can't be joined yet — typically because it hasn't been pushed
 * to etebase (no UID), or no per-note key has been generated locally.
 * The editor falls back to single-device mode in that case.
 */
export interface RoomInfo {
  /** Base64 of the room's derived P-256 SPKI — the room is *named* after the
   *  public half of its join keypair, which is what lets the relay
   *  authenticate joins without holding a secret. */
  room_id: string;
  /** Standard base64 of the 32-byte AES-GCM key. */
  key_b64: string;
  /** Share manifest live-collab epoch; 0 means no collection salt was applied. */
  collab_epoch: number;
  /** Present for salted shared-folder rooms. */
  writer_auth?: {
    authorized_writers: Array<{
      username: string;
      public_key_b64: string;
    }>;
  } | null;
  /** Private half of the join keypair (PKCS#8 DER, base64), used to sign the
   *  relay's challenge nonce. */
  join_private_key_pkcs8_b64?: string;
}

export async function noteRoomInfo(
  id: string,
  writerPublicKeyB64?: string
): Promise<RoomInfo | null> {
  if (!isTauri()) return null;
  return await tauriInvoke<RoomInfo | null>('note_room_info', {
    id,
    writerPublicKeyB64: writerPublicKeyB64 ?? null
  });
}

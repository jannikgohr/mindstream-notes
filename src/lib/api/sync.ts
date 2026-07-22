/**
 * Sync bridge. Mirror of src-tauri/src/sync/mod.rs.
 *
 * One-shot pull/push against the Etebase server. The user must already
 * be signed in (see api/auth.ts); calling this when signed out resolves
 * with an "not signed in" error from the Rust side.
 */

import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import {
  assertNumber,
  assertRecord,
  assertString,
  assertVoid,
  isTauri
} from './core';

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
  return parseSyncReport(await tauriInvoke<unknown>('sync_now'));
}

export interface SyncScheduleInput {
  enabled: boolean;
  intervalSecs: number;
}

export async function setSyncSchedule(input: SyncScheduleInput): Promise<void> {
  assertSyncScheduleInput(input);
  if (!isTauri()) return;
  const args = {
    enabled: input.enabled,
    intervalSecs: input.intervalSecs
  };
  assertVoid(
    await tauriInvoke<unknown>('set_sync_schedule', args),
    'set_sync_schedule response'
  );
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
  assertRequiredString(id, 'id');
  if (writerPublicKeyB64 !== undefined) {
    assertRequiredString(writerPublicKeyB64, 'writerPublicKeyB64');
  }
  if (!isTauri()) return null;
  return parseNullableRoomInfo(
    await tauriInvoke<unknown>('note_room_info', {
      id,
      writerPublicKeyB64: writerPublicKeyB64 ?? null
    })
  );
}

function assertRequiredString(value: string, context: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${context} must be a non-empty string`);
  }
}

function assertSyncScheduleInput(input: SyncScheduleInput): void {
  if (typeof input.enabled !== 'boolean') {
    throw new Error('sync schedule enabled must be a boolean');
  }
  if (!Number.isInteger(input.intervalSecs) || input.intervalSecs < 0) {
    throw new Error(
      'sync schedule intervalSecs must be a non-negative integer'
    );
  }
  if (input.enabled && input.intervalSecs === 0) {
    throw new Error('enabled sync schedule requires a positive interval');
  }
}

function parseSyncReport(value: unknown): SyncReport {
  const raw = assertRecord(value, 'sync report');
  return {
    folders_pulled: assertNumber(
      raw.folders_pulled,
      'sync report.folders_pulled'
    ),
    folders_pushed: assertNumber(
      raw.folders_pushed,
      'sync report.folders_pushed'
    ),
    notes_pulled: assertNumber(raw.notes_pulled, 'sync report.notes_pulled'),
    notes_pushed: assertNumber(raw.notes_pushed, 'sync report.notes_pushed'),
    assets_pulled: assertNumber(raw.assets_pulled, 'sync report.assets_pulled'),
    assets_pushed: assertNumber(raw.assets_pushed, 'sync report.assets_pushed'),
    conflicts_resolved: assertNumber(
      raw.conflicts_resolved,
      'sync report.conflicts_resolved'
    )
  };
}

function parseRoomInfo(value: unknown): RoomInfo {
  const raw = assertRecord(value, 'room info');
  const writerAuth =
    raw.writer_auth === null || raw.writer_auth === undefined
      ? null
      : parseWriterAuth(raw.writer_auth);
  return {
    room_id: assertString(raw.room_id, 'room info.room_id'),
    key_b64: assertString(raw.key_b64, 'room info.key_b64'),
    collab_epoch: assertNumber(raw.collab_epoch, 'room info.collab_epoch'),
    writer_auth: writerAuth,
    join_private_key_pkcs8_b64:
      raw.join_private_key_pkcs8_b64 === undefined
        ? undefined
        : assertString(
            raw.join_private_key_pkcs8_b64,
            'room info.join_private_key_pkcs8_b64'
          )
  };
}

function parseNullableRoomInfo(value: unknown): RoomInfo | null {
  if (value === null || value === undefined) return null;
  return parseRoomInfo(value);
}

function parseWriterAuth(value: unknown): NonNullable<RoomInfo['writer_auth']> {
  const raw = assertRecord(value, 'room info.writer_auth');
  if (!Array.isArray(raw.authorized_writers)) {
    throw new Error(
      'room info.writer_auth.authorized_writers must be an array'
    );
  }
  return {
    authorized_writers: raw.authorized_writers.map((item, index) => {
      const writer = assertRecord(
        item,
        `room info.writer_auth.authorized_writers[${index}]`
      );
      return {
        username: assertString(
          writer.username,
          `room info.writer_auth.authorized_writers[${index}].username`
        ),
        public_key_b64: assertString(
          writer.public_key_b64,
          `room info.writer_auth.authorized_writers[${index}].public_key_b64`
        )
      };
    })
  };
}

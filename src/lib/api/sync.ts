import { assertRequiredString } from '$lib/validation';
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
  isTauri,
  TauriCommandName
} from './core';

export interface SyncReport {
  folders_pulled: number;
  folders_pushed: number;
  notes_pulled: number;
  notes_pushed: number;
  assets_pulled: number;
  assets_pushed: number;
  conflicts_resolved: number;
  /** Spaces the server took nothing new for because a limit was reached.
   *  Their changes are still on the device. */
  held_back: number;
}

export async function syncNow(): Promise<SyncReport> {
  if (!isTauri()) {
    throw new Error('Sync is only available in the desktop app.');
  }
  return parseSyncReport(await tauriInvoke<unknown>(TauriCommandName.SyncNow));
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
    await tauriInvoke<unknown>(TauriCommandName.SetSyncSchedule, args),
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
  /** ws:// or wss:// address of the sync server's room endpoint. */
  url: string;
  /** The collection and item that name the room on the server. Handed back
   *  to `noteRoomTicket` when the editor has to reconnect. */
  collection: string;
  item: string;
  /** A pass into the room, good for one socket and about half a minute. */
  ticket: string;
  /** URL-safe base64 of the 32-byte AES-GCM key. */
  key_b64: string;
}

export async function noteRoomInfo(id: string): Promise<RoomInfo | null> {
  assertRequiredString(id, 'id');
  if (!isTauri()) return null;
  return parseNullableRoomInfo(
    await tauriInvoke<unknown>(TauriCommandName.NoteRoomInfo, { id })
  );
}

/**
 * A fresh ticket for a room the editor already knows, for reconnecting.
 * `null` means the server will not let this account in, and asking again
 * will not change that. A rejection is worth retrying.
 */
export async function noteRoomTicket(
  collection: string,
  item: string
): Promise<string | null> {
  assertRequiredString(collection, 'collection');
  assertRequiredString(item, 'item');
  if (!isTauri()) return null;
  const ticket = await tauriInvoke<unknown>(TauriCommandName.NoteRoomTicket, {
    collection,
    item
  });
  if (ticket === null || ticket === undefined) return null;
  return assertString(ticket, 'room ticket');
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
    ),
    held_back: assertNumber(raw.held_back, 'sync report.held_back')
  };
}

function parseRoomInfo(value: unknown): RoomInfo {
  const raw = assertRecord(value, 'room info');
  return {
    url: assertString(raw.url, 'room info.url'),
    collection: assertString(raw.collection, 'room info.collection'),
    item: assertString(raw.item, 'room info.item'),
    ticket: assertString(raw.ticket, 'room info.ticket'),
    key_b64: assertString(raw.key_b64, 'room info.key_b64')
  };
}

function parseNullableRoomInfo(value: unknown): RoomInfo | null {
  if (value === null || value === undefined) return null;
  return parseRoomInfo(value);
}

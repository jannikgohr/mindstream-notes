import { browserStorageEnabled } from './commands';
import { browserRecoveryNamespace, browserTestVaultId } from './testing';
import { vaultNamespace } from './namespace';
import { recoveryStatus } from './recovery-status.svelte';
import type { BrowserStorageClient } from './client';
import type { UpdateNoteInput, Note } from '../api/notes';

type Draft = Pick<UpdateNoteInput, 'id' | 'body' | 'yrs_state'>;
type DraftRecord = {
  id: string;
  body?: string;
  state?: string;
  base: string;
  parents?: string[];
};
const revisions = new Map<string, string>();
const inFlight = new Map<string, { base: string; token: string }>();
const captures = new Map<string, { id: string; base: string | undefined }>();
export type RecoveryAcknowledgement = (() => void) & { token?: string };

function enabled(): boolean {
  return (
    typeof window !== 'undefined' &&
    !('__TAURI_INTERNALS__' in window) &&
    browserStorageEnabled()
  );
}

// A content fingerprint, independent of metadata and modification timestamps.
// It is a concurrency check, not a cryptographic integrity or security boundary.
function revision(note: Pick<Note, 'body' | 'yrs_state'>): string {
  let a = 0x811c9dc5,
    b = 0x9e3779b9;
  const add = (value: number) => {
    a = Math.imul(a ^ value, 0x01000193);
    b = Math.imul(b ^ value, 0x85ebca6b);
  };
  for (let i = 0; i < note.body.length; i++) add(note.body.charCodeAt(i));
  add(0x10000);
  for (const byte of note.yrs_state) add(byte);
  return `${a >>> 0}:${b >>> 0}`;
}

/** Remember the content actually read or committed by SQLite. */
export function rememberBrowserNote(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const note = value as Note;
  if (
    typeof note.id === 'string' &&
    typeof note.body === 'string' &&
    Array.isArray(note.yrs_state)
  ) {
    revisions.set(note.id, revision(note));
  }
}

function encode(bytes: number[]): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.slice(i, i + 8192));
  return btoa(binary);
}
function decode(state: string): number[] {
  return Array.from(atob(state), (char) => char.charCodeAt(0));
}
function parseRecord(raw: string, key: string): DraftRecord {
  const { draft: PREFIX } = browserRecoveryNamespace();
  const draft = JSON.parse(raw) as DraftRecord;
  if (
    !draft ||
    typeof draft.id !== 'string' ||
    key !== PREFIX + draft.id ||
    typeof draft.base !== 'string' ||
    (draft.body !== undefined && typeof draft.body !== 'string') ||
    (draft.state !== undefined && typeof draft.state !== 'string') ||
    (draft.parents !== undefined &&
      (!Array.isArray(draft.parents) ||
        draft.parents.length > 16 ||
        !draft.parents.every((parent) => typeof parent === 'string'))) ||
    (draft.body === undefined && draft.state === undefined)
  )
    throw new Error('Invalid browser note recovery data');
  return {
    id: draft.id,
    body: draft.body,
    state: draft.state,
    base: draft.base,
    parents: draft.parents
  };
}

/** Record edits synchronously before either editor debounce can lose them. */
export function checkpointBrowserNote(snapshot: () => Draft | null): void {
  const { draft: PREFIX } = browserRecoveryNamespace();
  if (!enabled()) return;
  const draft = snapshot();
  if (!draft) return;
  const base = revisions.get(draft.id);
  if (!base)
    throw new Error(
      'Cannot checkpoint a note before reading its saved content'
    );
  const record: DraftRecord = {
    id: draft.id,
    body: draft.body,
    base,
    state: draft.yrs_state === undefined ? undefined : encode(draft.yrs_state)
  };
  try {
    const previous = localStorage.getItem(PREFIX + draft.id);
    const prior = previous ? parseRecord(previous, PREFIX + draft.id) : null;
    const active = inFlight.get(draft.id);
    const parents = prior?.base === base ? (prior.parents ?? []) : [];
    record.parents = [
      ...new Set([...parents, ...(active?.base === base ? [active.token] : [])])
    ].slice(-16);
    localStorage.setItem(PREFIX + draft.id, JSON.stringify(record));
  } catch (error) {
    recoveryStatus.unavailable = true;
    throw error;
  }
}

/** Issue a receipt only for a captured editor save. Other content writes must
 * invalidate earlier receipts, even if they write identical content. */
export function beginBrowserWrite(
  id: string,
  token?: string
): { token?: string; finish: () => void } {
  const { draft: PREFIX } = browserRecoveryNamespace();
  const capture = token ? captures.get(token) : undefined;
  if (!enabled() || !token || capture?.id !== id) return { finish: () => {} };
  const base = revisions.get(id);
  if (!base) return { finish: () => {} };
  capture.base = base;
  const active = { base, token };
  inFlight.set(id, active);
  try {
    const raw = localStorage.getItem(PREFIX + id);
    if (raw) {
      const record = parseRecord(raw, PREFIX + id);
      if (record.base === base) {
        record.parents = [...new Set([...(record.parents ?? []), token])].slice(
          -16
        );
        localStorage.setItem(PREFIX + id, JSON.stringify(record));
      }
    }
  } catch {
    recoveryStatus.unavailable = true;
  }
  return {
    token,
    finish: () => {
      captures.delete(token);
      if (inFlight.get(id) === active) inFlight.delete(id);
    }
  };
}

/** Capture before awaiting a save. An older acknowledgement leaves newer edits.
 * Rebase those edits onto this successful save, so replay recognizes their parent. */
export function captureBrowserAcknowledgement(
  id: string
): RecoveryAcknowledgement {
  if (!enabled()) return () => {};
  const { draft: PREFIX } = browserRecoveryNamespace();
  const capture = { id, base: revisions.get(id) };
  let raw: string | null;
  try {
    raw = localStorage.getItem(PREFIX + id);
  } catch {
    return () => {};
  }
  const token = crypto.randomUUID();
  captures.set(token, capture);
  const acknowledge = () => {
    captures.delete(token);
    const current = localStorage.getItem(PREFIX + id);
    if (!current) return;
    const captured = raw ? parseRecord(raw, PREFIX + id) : null;
    const newer = parseRecord(current, PREFIX + id);
    // Parent bookkeeping does not represent a newer edit. Compare content too.
    if (
      captured &&
      newer.body === captured.body &&
      newer.state === captured.state
    ) {
      localStorage.removeItem(PREFIX + id);
      return;
    }
    const base = revisions.get(id);
    if (base && newer.base === capture.base)
      localStorage.setItem(PREFIX + id, JSON.stringify({ ...newer, base }));
  };
  return Object.assign(acknowledge, { token });
}

function retain(key: string, raw: string, reason: string): void {
  const { draft: PREFIX, archive: ARCHIVE } = browserRecoveryNamespace();
  recoveryStatus.copies.push({ key, raw, reason });
  try {
    // Move to quarantine when there is room. Otherwise preserve the original
    // key and still open the vault; the downloadable copy also remains in memory.
    localStorage.setItem(
      ARCHIVE + key.slice(PREFIX.length) + ':' + crypto.randomUUID(),
      raw
    );
    if (localStorage.getItem(key) === raw) localStorage.removeItem(key);
  } catch {
    /* Keep the original copy when storage is full or blocked. */
  }
}

/** Run only after acquiring the exclusive vault lock, before its first read.
 * Unusable/conflicting copies remain downloadable; one bad note cannot hide all
 * other notes. A dead worker still rejects opening and can reconnect next time. */
export async function recoverBrowserNotes(
  connection: Pick<BrowserStorageClient, 'request'>
): Promise<void> {
  const { draft: PREFIX, archive: ARCHIVE } = browserRecoveryNamespace();
  let keys: string[];
  try {
    keys = Object.keys(localStorage);
    for (const key of keys.filter((key) => key.startsWith(ARCHIVE))) {
      const raw = localStorage.getItem(key);
      if (
        raw !== null &&
        !recoveryStatus.copies.some((copy) => copy.key === key)
      )
        recoveryStatus.copies.push({ key, raw, reason: 'retained' });
    }
  } catch {
    recoveryStatus.unavailable = true;
    return;
  }
  for (const key of keys.filter((key) => key.startsWith(PREFIX))) {
    let raw: string | null;
    try {
      raw = localStorage.getItem(key);
    } catch {
      recoveryStatus.unavailable = true;
      continue;
    }
    if (raw === null) continue;
    try {
      const record = parseRecord(raw, key);
      const draft: Draft = {
        id: record.id,
        body: record.body,
        yrs_state: record.state === undefined ? undefined : decode(record.state)
      };
      let note: Note;
      try {
        note = (await connection.request('invoke', {
          command: 'load_note',
          args: { id: draft.id }
        })) as Note;
      } catch (error) {
        if ((error as { code?: string })?.code !== 'notFound') throw error;
        retain(key, raw, 'deleted');
        continue;
      }
      const alreadySaved =
        (draft.body === undefined || draft.body === note.body) &&
        (draft.yrs_state === undefined ||
          JSON.stringify(draft.yrs_state) === JSON.stringify(note.yrs_state));
      if (!alreadySaved) {
        const savedRevision = revision(note);
        const receipt =
          record.base !== savedRevision && record.parents?.length
            ? await connection.request('receipt', { id: draft.id })
            : null;
        if (
          note.trashed ||
          (record.base !== savedRevision &&
            (!receipt || !record.parents?.includes(receipt)))
        ) {
          retain(key, raw, note.trashed ? 'trashed' : 'conflict');
          continue;
        }
        // Persist this replay's token before issuing it, too. The SQL trigger
        // commits the receipt atomically with all backend normalization.
        const token = crypto.randomUUID();
        raw = JSON.stringify({
          ...record,
          base: savedRevision,
          parents: [...(record.parents ?? []), token].slice(-16)
        });
        localStorage.setItem(key, raw);
        rememberBrowserNote(note);
        const active = { base: savedRevision, token };
        inFlight.set(draft.id, active);
        try {
          const saved = await connection.request('invoke', {
            command: 'save_note',
            args: { input: draft },
            recoveryToken: token
          });
          rememberBrowserNote(saved);
        } finally {
          if (inFlight.get(draft.id) === active) inFlight.delete(draft.id);
        }
      }
      if (localStorage.getItem(key) === raw) localStorage.removeItem(key);
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === 'worker' || code === 'timeout' || code === 'closed')
        throw error;
      retain(key, raw, code ?? 'invalid');
    }
  }
}

/** Only an explicitly selected test vault may discard its recovery data. */
export function clearBrowserTestRecovery(id: string): void {
  if (browserTestVaultId() !== id)
    throw new Error('Only the active browser test vault can be reset');
  const names = vaultNamespace(id);
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(names.draft) || key.startsWith(names.archive))
      localStorage.removeItem(key);
  }
  revisions.clear();
  inFlight.clear();
  captures.clear();
  recoveryStatus.copies = [];
  recoveryStatus.unavailable = false;
}

import type { NoteKind } from '$lib/api';

const ENVELOPE_MARKER = 'mindstream-history-snapshot';

interface SnapshotEnvelopeV1 {
  marker: typeof ENVELOPE_MARKER;
  version: 1;
  noteKind: NoteKind;
  payloadKind: 'yjs-update';
  encoding: 'base64';
  data: string;
}

export type ParsedHistorySnapshot =
  | {
      noteKind: 'markdown';
      payloadKind: 'markdown';
      text: string;
    }
  | {
      noteKind: 'freeform' | 'ink' | 'pdf' | 'kanban';
      payloadKind: 'yjs-update';
      bytes: Uint8Array;
    };

export function bytesToBase64(bytes: Uint8Array | number[]): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function serializeYjsSnapshot(
  noteKind: 'freeform' | 'ink' | 'pdf' | 'kanban',
  bytes: Uint8Array | number[]
): string {
  const envelope: SnapshotEnvelopeV1 = {
    marker: ENVELOPE_MARKER,
    version: 1,
    noteKind,
    payloadKind: 'yjs-update',
    encoding: 'base64',
    data: bytesToBase64(bytes)
  };
  return JSON.stringify(envelope);
}

export function parseHistorySnapshot(
  body: string,
  fallbackKind: NoteKind
): ParsedHistorySnapshot {
  if (fallbackKind === 'markdown') {
    return { noteKind: 'markdown', payloadKind: 'markdown', text: body };
  }

  try {
    const value = JSON.parse(body) as Partial<SnapshotEnvelopeV1>;
    if (
      value.marker === ENVELOPE_MARKER &&
      value.version === 1 &&
      value.payloadKind === 'yjs-update' &&
      value.encoding === 'base64' &&
      value.noteKind === fallbackKind &&
      typeof value.data === 'string'
    ) {
      return {
        noteKind: fallbackKind,
        payloadKind: 'yjs-update',
        bytes: base64ToBytes(value.data)
      } as ParsedHistorySnapshot;
    }
  } catch {
    // Fall through to an empty snapshot. Older non-markdown history rows did
    // not exist, so invalid envelopes should not be restored into live docs.
  }

  return {
    noteKind: fallbackKind,
    payloadKind: 'yjs-update',
    bytes: new Uint8Array()
  } as ParsedHistorySnapshot;
}

export function historySnapshotSize(body: string): number {
  return new Blob([body]).size;
}

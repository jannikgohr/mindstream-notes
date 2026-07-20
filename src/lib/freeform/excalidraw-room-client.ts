/**
 * Live-sync client for the official excalidraw-room server.
 *
 * Replaces the Y.Doc-over-CollabProvider transport that freeform notes
 * used to use. excalidraw-room speaks the same Socket.IO + AES-GCM-128
 * protocol that upstream Excalidraw's own collab uses (the `Portal`
 * class in excalidraw-app), so we port the wire format here:
 *
 *   join:    emit('join-room', roomId)
 *   send:    emit('server-broadcast', roomId, encryptedBuffer, iv)
 *   receive: on('client-broadcast', (encryptedBuffer, iv) => …)
 *
 * Payload, after AES-GCM-decryption, is JSON of the form
 *   { type: 'SCENE_UPDATE', payload: { elements } }
 *
 * Cursor / presence / follow-mode payloads (MOUSE_LOCATION etc.) are
 * out of scope for v1 — the previous freeform stack never wired them up
 * either, so dropping them isn't a regression. Add them by extending
 * the type switch in `handleClientBroadcast` and emitting a matching
 * payload from a separate `broadcastCursor` method.
 *
 * The room key is HKDF-derived from each note's existing 32-byte
 * crypto_key (see `deriveExcalidrawKey`), so excalidraw-room gets the
 * 16-byte AES key it expects without bumping the etebase NotePayload
 * schema. The server still sees only ciphertext.
 */

import { io, type Socket } from 'socket.io-client';
import { CaptureUpdateAction } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import {
  canSignCollabFrame,
  CollabReplayGuard,
  decodeCollabFrame,
  encodeCollabFrame,
  isSignedCollabFrame,
  signedCollabFrameNeedsAuthRefresh,
  type CollabFrameAuth
} from '$lib/sync/signed-collab-frame';

const IV_LENGTH_BYTES = 12;
const HKDF_INFO = new TextEncoder().encode('mindstream:excalidraw-room:v1');
const FRAME_SCENE_UPDATE = 0x01;
const SIGNED_REQUIRED_TYPES = new Set([FRAME_SCENE_UPDATE]);
// Match Excalidraw's outbound throttle: drawing fires onChange dozens
// of times per second, but the wire only needs the latest state.
const BROADCAST_THROTTLE_MS = 50;
// Cap repeated decrypt warnings so a misconfigured peer in the same
// room can't flood the console.
const MAX_DECRYPT_WARNINGS = 5;
const AUTH_REFRESH_THROTTLE_MS = 5_000;

/**
 * Normalise whatever Socket.IO hands us into an ArrayBuffer. The
 * binary attachment representation varies by transport (websocket vs
 * polling), platform (browser vs Node), and even Socket.IO version —
 * we've seen ArrayBuffer, Uint8Array, and Buffer arrive depending on
 * the path. The TypeScript types are aspirational; trust them at your
 * peril. Returns null for anything we can't read as bytes so the caller
 * can drop the frame cleanly instead of throwing inside crypto.subtle.
 */
function asArrayBuffer(value: unknown): ArrayBuffer | null {
  if (value instanceof ArrayBuffer) return value;
  if (value instanceof Uint8Array || ArrayBuffer.isView(value)) {
    // `new Uint8Array(typedArray)` copies into a fresh ArrayBuffer-
    // backed view, which also strips any SharedArrayBuffer backing
    // that some runtimes would otherwise hand us.
    return new Uint8Array(value as Uint8Array).buffer;
  }
  return null;
}

export interface ExcalidrawRoomClientOptions {
  /** URL of the nginx fronting excalidraw-room. socket.io will
   *  append /socket.io/. */
  url: string;
  /** Room ID — same etebase Item UID we use for the yjs-relay. */
  roomId: string;
  /** 16 raw bytes derived from the note's crypto_key via
   *  `deriveExcalidrawKey`. */
  keyBytes16: Uint8Array;
  /** Live Excalidraw API; we read scene state from it and push remote
   *  updates back into it. */
  api: ExcalidrawImperativeAPI;
  /** Optional UI hook for the connection status badge. */
  onStatusChange?: (online: boolean) => void;
  /** Optional writer-key signature context. When present, scene updates
   *  from peers must be signed by an authorized writer key. */
  auth?: CollabFrameAuth;
  /** True for a shared-scope room, where scene updates must carry a writer
   *  signature. Derived from the room's collab epoch rather than from `auth`
   *  being present, so a failed authorisation lookup fails closed. */
  requireSignedWrites?: boolean;
  onAuthStale?: () => void;
}

type RemoteMessage =
  | {
      type: 'SCENE_UPDATE';
      payload: { elements: readonly ExcalidrawElement[] };
    }
  | { type: string; payload?: unknown };

export class ExcalidrawRoomClient {
  private socket: Socket | null = null;
  private cryptoKey: CryptoKey | null = null;
  private destroyed = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlush = 0;
  private pendingBroadcast = false;
  /** Fingerprint of the last scene we either sent or accepted from a
   *  peer. We compare against it on every potential broadcast so we
   *  don't re-emit our own state coming back from a peer, and on every
   *  inbound frame so we don't re-apply our own state to ourselves.
   *
   *  Why this matters: without it, a stylus stroke kicks off an
   *  infinite echo cycle. A draws → B receives → updateScene → B fires
   *  onChange asynchronously → broadcasts back → A receives → ... at
   *  the throttle rate forever. Each cycle replaces every element with
   *  a freshly-deserialised copy whose versionNonce differs from what
   *  the local Y.Doc binding saw last time, so the Y.Doc grows by an
   *  op per element per cycle. Yjs op logs are append-only — they
   *  don't GC live items — so over a long session the doc balloons
   *  from a few KB to multiple GB even though the visible scene
   *  hasn't changed since the user put the stylus down. */
  private lastSceneFingerprint: string | null = null;
  private decryptWarningCount = 0;
  private lastAuthRefreshRequest = 0;
  /** Drops frames we've already applied, and frames too old to be live. */
  private readonly replayGuard = new CollabReplayGuard();
  private readonly unlistenOnChange: () => void;

  constructor(private readonly opts: ExcalidrawRoomClientOptions) {
    this.unlistenOnChange = opts.api.onChange(() => {
      if (this.destroyed) return;
      this.scheduleBroadcast();
    });
    void this.connect();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearFlushTimer();
    this.unlistenOnChange();
    if (this.socket) {
      try {
        this.socket.disconnect();
      } catch {
        /* ignore */
      }
      this.socket = null;
    }
    this.opts.onStatusChange?.(false);
  }

  private async connect(): Promise<void> {
    try {
      this.cryptoKey = await crypto.subtle.importKey(
        'raw',
        this.opts.keyBytes16.slice().buffer,
        { name: 'AES-GCM', length: 128 },
        false,
        ['encrypt', 'decrypt']
      );
    } catch (err) {
      console.warn('[excalidraw-room] key import failed', err);
      return;
    }
    if (this.destroyed) return;

    // socket.io-client appends /socket.io/ to the URL itself, so we
    // hand it the root URL of the nginx and let it negotiate the path.
    const socket = io(this.opts.url, {
      transports: ['websocket', 'polling']
    });
    this.socket = socket;

    // `init-room` is emitted by excalidraw-room on every successful
    // connect — including reconnects after a transient drop — so this
    // single handler covers the initial join and every recovery.
    socket.on('init-room', () => {
      if (this.destroyed) return;
      socket.emit('join-room', this.opts.roomId);
    });
    socket.on('connect', () => {
      this.opts.onStatusChange?.(true);
    });
    socket.on('disconnect', (reason) => {
      this.opts.onStatusChange?.(false);
      console.debug('[excalidraw-room] disconnect', reason);
    });
    socket.on('connect_error', (err) => {
      // Don't tear down — Socket.IO retries with backoff on its own.
      // Just surface the error so a bad URL or CORS rejection is
      // visible instead of silently never connecting.
      console.warn('[excalidraw-room] connect_error', err.message);
    });
    socket.on('first-in-room', () => {
      // No remote peers yet — nothing to send until one joins. New
      // joiners trigger our `new-user` handler below, which seeds them
      // with the current scene.
    });
    socket.on('new-user', () => {
      if (this.destroyed) return;
      // A peer just joined; give them our scene immediately so they
      // don't have to wait for the next local edit.
      void this.broadcastScene();
    });
    socket.on('client-broadcast', (encryptedBuffer: unknown, iv: unknown) => {
      if (this.destroyed) return;
      void this.handleClientBroadcast(encryptedBuffer, iv);
    });
  }

  private scheduleBroadcast(): void {
    if (this.pendingBroadcast) return;
    const elapsed = Date.now() - this.lastFlush;
    if (elapsed >= BROADCAST_THROTTLE_MS) {
      void this.broadcastScene();
      return;
    }
    this.pendingBroadcast = true;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.pendingBroadcast = false;
      void this.broadcastScene();
    }, BROADCAST_THROTTLE_MS - elapsed);
  }

  private clearFlushTimer(): void {
    if (!this.flushTimer) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.pendingBroadcast = false;
  }

  private async broadcastScene(): Promise<void> {
    const socket = this.socket;
    const key = this.cryptoKey;
    if (!socket || !key || !socket.connected) return;
    if (this.opts.auth && !canSignCollabFrame(this.opts.auth)) return;
    const elements = this.opts.api.getSceneElementsIncludingDeleted();
    const fingerprint = sceneFingerprint(elements);
    // Short-circuit: this is the scene we just sent (or just received
    // from a peer). Re-emitting it would feed the echo loop that
    // grows the local Y.Doc forever — see `lastSceneFingerprint`.
    if (fingerprint === this.lastSceneFingerprint) return;
    this.lastFlush = Date.now();
    this.lastSceneFingerprint = fingerprint;
    const message: RemoteMessage = {
      type: 'SCENE_UPDATE',
      payload: { elements }
    };
    try {
      const { encryptedBuffer, iv } = await encryptScene(
        key,
        message,
        this.opts.auth
      );
      socket.emit('server-broadcast', this.opts.roomId, encryptedBuffer, iv);
    } catch (err) {
      console.warn('[excalidraw-room] broadcast failed', err);
    }
  }

  private async handleClientBroadcast(
    encryptedBuffer: unknown,
    iv: unknown
  ): Promise<void> {
    const key = this.cryptoKey;
    if (!key) return;

    // Socket.IO may hand us Uint8Array, ArrayBuffer, or Buffer depending
    // on transport. Normalise to ArrayBuffer before touching crypto.
    const ivBuffer = asArrayBuffer(iv);
    const ctBuffer = asArrayBuffer(encryptedBuffer);
    if (!ivBuffer || !ctBuffer) {
      this.warnDecrypt('malformed frame: unexpected binary shape');
      return;
    }
    if (ivBuffer.byteLength !== IV_LENGTH_BYTES) {
      this.warnDecrypt(`bad iv length ${ivBuffer.byteLength}`);
      return;
    }
    if (ctBuffer.byteLength === 0) {
      // GCM tag alone is 16 bytes — an empty ciphertext can't decrypt.
      this.warnDecrypt('empty ciphertext');
      return;
    }

    let decoded: RemoteMessage;
    try {
      if (this.opts.requireSignedWrites) {
        const frame = new Uint8Array(ctBuffer);
        if (!isSignedCollabFrame(frame)) {
          this.warnDecrypt('rejected unsigned scene update');
          return;
        }
        const signed = await decodeCollabFrame(
          frame,
          key,
          this.opts.auth,
          SIGNED_REQUIRED_TYPES,
          this.replayGuard
        );
        if (!signed) {
          void this.maybeRequestAuthRefresh(frame, key);
          return;
        }
        if (signed.type !== FRAME_SCENE_UPDATE) return;
        decoded = JSON.parse(
          new TextDecoder().decode(signed.payload)
        ) as RemoteMessage;
      } else {
        const plaintext = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: ivBuffer },
          key,
          ctBuffer
        );
        decoded = JSON.parse(
          new TextDecoder().decode(plaintext)
        ) as RemoteMessage;
      }
    } catch (err) {
      // Most likely cause: a peer in the same room with a different
      // key (e.g. they opened the note before we pushed the crypto_key
      // to etebase). Less likely: corruption. Either way, drop and
      // wait for the next frame.
      this.warnDecrypt(
        `decrypt or parse failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }

    if (decoded.type !== 'SCENE_UPDATE') return;
    const incoming = (
      decoded.payload as { elements?: readonly ExcalidrawElement[] }
    )?.elements;
    if (!incoming || !Array.isArray(incoming)) return;

    // Short-circuit: this is our own state coming back to us via the
    // peer (or a peer's re-emit of an unchanged state). Skipping here
    // is what keeps the echo cycle from updating the scene, firing
    // onChange, and triggering another broadcast we'd then re-receive.
    const incomingFingerprint = sceneFingerprint(incoming);
    if (incomingFingerprint === this.lastSceneFingerprint) return;

    const current = this.opts.api.getSceneElementsIncludingDeleted();
    const merged = reconcileElements(current, incoming);
    // Record before updateScene so the onChange that fires synchronously
    // (or on the next task) sees the fingerprint as "already known" and
    // skips its broadcast.
    this.lastSceneFingerprint = sceneFingerprint(merged);
    this.opts.api.updateScene({
      elements: merged,
      // NEVER: the remote update isn't an undoable local action.
      captureUpdate: CaptureUpdateAction.NEVER
    });
  }

  private warnDecrypt(reason: string): void {
    if (this.decryptWarningCount >= MAX_DECRYPT_WARNINGS) return;
    this.decryptWarningCount += 1;
    const suffix =
      this.decryptWarningCount === MAX_DECRYPT_WARNINGS
        ? ' (further warnings suppressed)'
        : '';
    console.warn(`[excalidraw-room] ${reason}${suffix}`);
  }

  private async maybeRequestAuthRefresh(
    frame: Uint8Array,
    cryptoKey: CryptoKey
  ): Promise<void> {
    if (
      !(await signedCollabFrameNeedsAuthRefresh(
        frame,
        cryptoKey,
        this.opts.auth
      ))
    ) {
      return;
    }
    const now = Date.now();
    if (now - this.lastAuthRefreshRequest < AUTH_REFRESH_THROTTLE_MS) return;
    this.lastAuthRefreshRequest = now;
    console.info(
      '[excalidraw-room] refreshing writer auth room=%s',
      this.opts.roomId
    );
    this.opts.onAuthStale?.();
  }
}

/**
 * Element-version reconciliation. Same shape as upstream Excalidraw's
 * reconcileElements: pick the element with the higher (version,
 * versionNonce) per id, preserve remote ordering for ids that exist
 * in both, append local-only ids at the end so an in-flight stroke a
 * user hasn't released yet doesn't disappear when a remote update lands.
 */
export function reconcileElements(
  localElements: readonly ExcalidrawElement[],
  remoteElements: readonly ExcalidrawElement[]
): readonly ExcalidrawElement[] {
  const localById = new Map<string, ExcalidrawElement>();
  for (const el of localElements) localById.set(el.id, el);

  const seen = new Set<string>();
  const merged: ExcalidrawElement[] = [];
  for (const remote of remoteElements) {
    seen.add(remote.id);
    const local = localById.get(remote.id);
    merged.push(local && shouldKeepLocal(local, remote) ? local : remote);
  }
  for (const local of localElements) {
    if (!seen.has(local.id)) merged.push(local);
  }
  return merged;
}

function shouldKeepLocal(
  local: ExcalidrawElement,
  remote: ExcalidrawElement
): boolean {
  if (local.version > remote.version) return true;
  if (local.version < remote.version) return false;
  // Tiebreaker on versionNonce. We use >= (not just >) on purpose: when
  // the two elements are bit-for-bit equal, keep the local reference.
  // Swapping in the freshly-deserialised remote object for an
  // unchanged element would still pass equality on disk but breaks
  // reference identity downstream — Excalidraw treats that as a scene
  // mutation and the local Y.Doc binding writes a new op for it,
  // which is half of what made the echo loop grow the doc forever.
  return local.versionNonce >= remote.versionNonce;
}

/**
 * Stable, cheap fingerprint covering exactly the bits that matter for
 * "is this scene the same one we already know about?". Element order
 * matters (z-stacking), so we don't sort. Versions and the deleted
 * flag are what reconcile cares about; everything else is derivable.
 */
function sceneFingerprint(elements: readonly ExcalidrawElement[]): string {
  let out = '';
  for (const el of elements) {
    out += `${el.id}:${el.version}.${el.versionNonce}${el.isDeleted ? 'D' : ''}|`;
  }
  return out;
}

async function encryptScene(
  key: CryptoKey,
  message: RemoteMessage,
  auth?: CollabFrameAuth
): Promise<{ encryptedBuffer: ArrayBuffer; iv: Uint8Array }> {
  const encoded = new TextEncoder().encode(JSON.stringify(message));
  if (auth && canSignCollabFrame(auth)) {
    const frame = await encodeCollabFrame(
      FRAME_SCENE_UPDATE,
      encoded,
      key,
      auth
    );
    return {
      encryptedBuffer: new Uint8Array(frame).buffer,
      iv: new Uint8Array(IV_LENGTH_BYTES)
    };
  }
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
  // The slice().buffer trick mirrors what collab-provider.ts does:
  // TS 5.7's BufferSource definition needs Uint8Array<ArrayBuffer>, and
  // a fresh slice satisfies it without changing runtime behavior.
  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded.slice().buffer
  );
  return { encryptedBuffer, iv };
}

/**
 * HKDF-derive a 16-byte AES-GCM key (the size excalidraw-room expects)
 * from the existing per-note 32-byte crypto_key. Stable per note, zero
 * server-side changes, and the 32-byte key keeps serving the markdown
 * / PDF CollabProvider unchanged.
 */
export async function deriveExcalidrawKey(
  keyBytes32: Uint8Array
): Promise<Uint8Array> {
  const ikm = await crypto.subtle.importKey(
    'raw',
    keyBytes32.slice().buffer,
    'HKDF',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: HKDF_INFO
    },
    ikm,
    128
  );
  return new Uint8Array(bits);
}

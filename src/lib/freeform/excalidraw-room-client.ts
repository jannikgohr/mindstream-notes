/**
 * Live sync for freeform (Excalidraw) notes, over the note's room on the
 * sync server.
 *
 * Freeform notes share scenes, not Yjs updates: a peer sends the elements it
 * has and the receiver keeps the newer version of each, the way upstream
 * Excalidraw's own collab does. On the wire that is
 *
 *   on joining   sync     "send me your scene"
 *   a writer     reply    its scene, to the member who asked
 *   on a change  update   the scene, to everyone
 *
 * all as JSON of the form `{ type: 'SCENE_UPDATE', payload: { elements } }`.
 * The room, its members and the encryption are `$lib/sync/room-socket`. A
 * member who may only read receives scenes and sends none; the server would
 * drop them.
 *
 * Cursor / presence / follow-mode payloads (MOUSE_LOCATION etc.) are out of
 * scope for now. They belong in the presence class when they are added.
 */

import { CaptureUpdateAction } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import {
  ROOM_CLASS_REPLY,
  ROOM_CLASS_SYNC,
  ROOM_CLASS_UPDATE,
  RoomSocket,
  type RoomConnection,
  type RoomFrame
} from '$lib/sync/room-socket';

// Match Excalidraw's outbound throttle: drawing fires onChange dozens
// of times per second, but the wire only needs the latest state.
const BROADCAST_THROTTLE_MS = 50;
// Cap repeated warnings so a misbehaving peer in the same room can't
// flood the console.
const MAX_FRAME_WARNINGS = 5;

export interface ExcalidrawRoomClientOptions extends RoomConnection {
  /** Live Excalidraw API; we read scene state from it and push remote
   *  updates back into it. */
  api: ExcalidrawImperativeAPI;
  /** Optional UI hook for the connection status badge. */
  onStatusChange?: (online: boolean) => void;
}

type RemoteMessage =
  | {
      type: 'SCENE_UPDATE';
      payload: { elements: readonly ExcalidrawElement[] };
    }
  | { type: string; payload?: unknown };

export class ExcalidrawRoomClient {
  private readonly socket: RoomSocket;
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
  private frameWarningCount = 0;
  private readonly unlistenOnChange: () => void;

  constructor(private readonly opts: ExcalidrawRoomClientOptions) {
    this.unlistenOnChange = opts.api.onChange(() => {
      if (this.destroyed) return;
      this.scheduleBroadcast();
    });
    this.socket = new RoomSocket({
      url: opts.url,
      keyBytes: opts.keyBytes,
      getTicket: opts.getTicket,
      label: 'freeform',
      onOpen: () => {
        // Ask whoever is there for the scene. A writer answers us alone.
        void this.socket.send(ROOM_CLASS_SYNC, new Uint8Array(0));
      },
      onFrame: (frame) => this.handleFrame(frame),
      onStatusChange: (online) => this.opts.onStatusChange?.(online)
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearFlushTimer();
    this.unlistenOnChange();
    this.socket.destroy();
    this.opts.onStatusChange?.(false);
  }

  private scheduleBroadcast(): void {
    if (this.pendingBroadcast) return;
    const elapsed = Date.now() - this.lastFlush;
    if (elapsed >= BROADCAST_THROTTLE_MS) {
      this.broadcastScene();
      return;
    }
    this.pendingBroadcast = true;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.pendingBroadcast = false;
      this.broadcastScene();
    }, BROADCAST_THROTTLE_MS - elapsed);
  }

  private clearFlushTimer(): void {
    if (!this.flushTimer) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.pendingBroadcast = false;
  }

  private encodeScene(elements: readonly ExcalidrawElement[]): Uint8Array {
    const message: RemoteMessage = {
      type: 'SCENE_UPDATE',
      payload: { elements }
    };
    return new TextEncoder().encode(JSON.stringify(message));
  }

  private broadcastScene(): void {
    // The server drops scenes from a member who may only read, and while
    // not connected there is nobody to tell. Either way the fingerprint
    // must stay untouched, so the scene still goes out once we can send.
    if (this.destroyed || !this.socket.canWrite) return;
    const elements = this.opts.api.getSceneElementsIncludingDeleted();
    const fingerprint = sceneFingerprint(elements);
    // Short-circuit: this is the scene we just sent (or just received
    // from a peer). Re-emitting it would feed the echo loop that
    // grows the local Y.Doc forever — see `lastSceneFingerprint`.
    if (fingerprint === this.lastSceneFingerprint) return;
    this.lastFlush = Date.now();
    this.lastSceneFingerprint = fingerprint;
    void this.socket.send(ROOM_CLASS_UPDATE, this.encodeScene(elements));
  }

  private handleFrame({ cls, sender, payload }: RoomFrame): void {
    if (this.destroyed) return;
    switch (cls) {
      case ROOM_CLASS_SYNC:
        // A peer just joined; give it our scene so it doesn't have to
        // wait for the next local edit. Only a writer may answer.
        if (!this.socket.canWrite) {
          // We cannot, so a writer who just joined never learns that we
          // lack its scene. Ask it instead.
          if (this.socket.peerCanWrite(sender)) {
            void this.socket.send(ROOM_CLASS_SYNC, new Uint8Array(0));
          }
          return;
        }
        void this.socket.reply(
          sender,
          this.encodeScene(this.opts.api.getSceneElementsIncludingDeleted())
        );
        return;
      case ROOM_CLASS_UPDATE:
      case ROOM_CLASS_REPLY:
        this.applyScene(payload);
        return;
      default:
        // Presence, or a class this version does not know. Never applied
        // to the scene.
        return;
    }
  }

  private applyScene(payload: Uint8Array): void {
    let decoded: RemoteMessage;
    try {
      decoded = JSON.parse(new TextDecoder().decode(payload)) as RemoteMessage;
    } catch (err) {
      this.warnFrame(
        `unreadable scene: ${err instanceof Error ? err.message : String(err)}`
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
    const mergedFingerprint = sceneFingerprint(merged);
    // Record before updateScene so the onChange that fires synchronously
    // (or on the next task) sees the fingerprint as "already known" and
    // skips its broadcast.
    this.lastSceneFingerprint = mergedFingerprint;
    this.opts.api.updateScene({
      elements: merged,
      // NEVER: the remote update isn't an undoable local action.
      captureUpdate: CaptureUpdateAction.NEVER
    });
    // We had something the peer lacks, such as strokes drawn while this
    // device was offline. Nothing else would send it until the next local
    // edit, so send the merged scene now. The peers arrive at the same
    // merge and stop there, which is what keeps this from echoing.
    if (mergedFingerprint !== incomingFingerprint && this.socket.canWrite) {
      this.lastFlush = Date.now();
      void this.socket.send(ROOM_CLASS_UPDATE, this.encodeScene(merged));
    }
  }

  private warnFrame(reason: string): void {
    if (this.frameWarningCount >= MAX_FRAME_WARNINGS) return;
    this.frameWarningCount += 1;
    const suffix =
      this.frameWarningCount === MAX_FRAME_WARNINGS
        ? ' (further warnings suppressed)'
        : '';
    console.warn(`[freeform-room] ${reason}${suffix}`);
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
export function sceneFingerprint(
  elements: readonly ExcalidrawElement[]
): string {
  let out = '';
  for (const el of elements) {
    out += `${el.id}:${el.version}.${el.versionNonce}${el.isDeleted ? 'D' : ''}|`;
  }
  return out;
}

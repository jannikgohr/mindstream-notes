/**
 * Live Yjs co-editing over a note's room on the sync server.
 *
 * The room, who may be in it and who may write are the server's business;
 * see `room-socket.ts`. This module is the Yjs side: what to say when
 * joining, and what to do with what arrives.
 *
 * Joining is a two-way catch-up that costs each side only what the other is
 * missing:
 *
 *   joiner  → everyone   sync    our state vector
 *   writer  → joiner     reply   what the joiner lacks, plus the writer's
 *                                own state vector
 *   joiner  → writer     reply   what that writer lacks, if anything
 *
 * A member who may only read cannot reply, so a writer who joins would never
 * learn what that member is missing. Such a member asks instead: on hearing a
 * writer's request it sends one of its own.
 *
 * After that, each local edit goes out as an update. Presence travels in its
 * own class, which members who may only read can send too.
 *
 * Only updates and replies ever touch the document. The server relays those
 * classes from writers alone, so a member who may only read cannot change
 * what the others see, whatever they put in a presence frame.
 */

import * as Y from 'yjs';
import {
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
  type Awareness
} from 'y-protocols/awareness';
import {
  ROOM_CLASS_PRESENCE,
  ROOM_CLASS_REPLY,
  ROOM_CLASS_SYNC,
  ROOM_CLASS_UPDATE,
  RoomSocket,
  type RoomConnection,
  type RoomFrame,
  type RoomPeer
} from './room-socket';

export interface CollabProviderOptions extends RoomConnection {
  /** Live yjs document the editor is bound to. */
  doc: Y.Doc;
  /** Awareness instance for cursor + presence. */
  awareness: Awareness;
  /** Optional callback fired on connect / disconnect (for UI badges). */
  onStatusChange?: (online: boolean) => void;
  /** Who else is in the room, by the account the server authenticated. */
  onPeersChange?: (peers: RoomPeer[]) => void;
}

/** A Yjs update that changes nothing still encodes to two bytes. */
const EMPTY_UPDATE_BYTES = 2;

/**
 * A reply: the update, and optionally the sender's state vector so the
 * receiver can answer with what the sender is missing in turn.
 *
 *   [update length, u32 BE][update][state vector, possibly empty]
 */
export function encodeSyncReply(
  update: Uint8Array,
  stateVector?: Uint8Array
): Uint8Array {
  const out = new Uint8Array(
    4 + update.byteLength + (stateVector?.byteLength ?? 0)
  );
  new DataView(out.buffer).setUint32(0, update.byteLength);
  out.set(update, 4);
  if (stateVector) out.set(stateVector, 4 + update.byteLength);
  return out;
}

export function decodeSyncReply(
  payload: Uint8Array
): { update: Uint8Array; stateVector: Uint8Array | null } | null {
  if (payload.byteLength < 4) return null;
  const length = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength
  ).getUint32(0);
  if (4 + length > payload.byteLength) return null;
  const rest = payload.subarray(4 + length);
  return {
    update: payload.subarray(4, 4 + length),
    stateVector: rest.byteLength > 0 ? rest : null
  };
}

/** Marks awareness changes that came from one peer, so they can be taken
 *  back when that peer leaves. */
class FromPeer {
  constructor(
    readonly provider: CollabProvider,
    readonly peer: number
  ) {}
}

export class CollabProvider {
  private readonly socket: RoomSocket;
  private destroyed = false;
  private awarenessFrame: number | null = null;
  private readonly pendingAwarenessClients = new Set<number>();
  /** Which awareness clients each peer has spoken for. A peer that drops
   *  off without saying goodbye still has its cursor removed. */
  private readonly awarenessOf = new Map<number, Set<number>>();

  private readonly docUpdateHandler: (
    update: Uint8Array,
    origin: unknown
  ) => void;
  private readonly awarenessUpdateHandler: (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown
  ) => void;

  constructor(private readonly opts: CollabProviderOptions) {
    // Local doc edits → send. `origin === this` filters out the updates we
    // just *received* (applied with origin=this below), preventing an echo
    // loop.
    this.docUpdateHandler = (update, origin) => {
      if (origin === this) return;
      // The server would drop it. Not sending saves the bytes.
      if (!this.socket.canWrite) return;
      void this.socket.send(ROOM_CLASS_UPDATE, update);
    };
    this.awarenessUpdateHandler = ({ added, updated, removed }, origin) => {
      if (origin instanceof FromPeer) {
        if (origin.provider === this) {
          const clients = this.awarenessOf.get(origin.peer) ?? new Set();
          for (const client of [...added, ...updated]) clients.add(client);
          for (const client of removed) clients.delete(client);
          this.awarenessOf.set(origin.peer, clients);
        }
        return;
      }
      if (origin === this) return;
      const changedClients = [...added, ...updated, ...removed];
      if (changedClients.length === 0) return;
      for (const client of changedClients)
        this.pendingAwarenessClients.add(client);
      if (this.awarenessFrame !== null) return;
      this.awarenessFrame = requestAnimationFrame(() => {
        this.awarenessFrame = null;
        const clients = [...this.pendingAwarenessClients];
        this.pendingAwarenessClients.clear();
        if (this.destroyed) return;
        const update = encodeAwarenessUpdate(this.opts.awareness, clients);
        void this.socket.send(ROOM_CLASS_PRESENCE, update);
      });
    };

    this.opts.doc.on('update', this.docUpdateHandler);
    this.opts.awareness.on('update', this.awarenessUpdateHandler);

    this.socket = new RoomSocket({
      url: this.opts.url,
      keyBytes: this.opts.keyBytes,
      getTicket: this.opts.getTicket,
      label: 'yjs',
      onOpen: () => this.startSync(),
      onFrame: (frame) => this.handleFrame(frame),
      onPeerLeft: (peer) => this.forgetPeer(peer),
      onPeersChange: (peers) => this.opts.onPeersChange?.(peers),
      onStatusChange: (online) => this.opts.onStatusChange?.(online)
    });
  }

  destroy(): void {
    this.destroyed = true;
    if (this.awarenessFrame !== null) cancelAnimationFrame(this.awarenessFrame);
    this.awarenessFrame = null;
    this.pendingAwarenessClients.clear();
    this.opts.doc.off('update', this.docUpdateHandler);
    this.opts.awareness.off('update', this.awarenessUpdateHandler);
    // Drop our own awareness state so this editor stops showing itself. The
    // peers hear from the server that we left and remove our cursor.
    try {
      this.opts.awareness.setLocalState(null);
    } catch {
      /* ignore */
    }
    this.socket.destroy();
    this.opts.onStatusChange?.(false);
  }

  /** Opening exchange once the server has let us in. */
  private startSync(): void {
    if (this.destroyed) return;
    // Ask for what we are missing. Every writer in the room answers us
    // alone, and tells us its own state so we can answer in kind.
    void this.socket.send(ROOM_CLASS_SYNC, Y.encodeStateVector(this.opts.doc));
    // Announce our presence so the peers' cursor list shows us joining.
    void this.socket.send(
      ROOM_CLASS_PRESENCE,
      encodeAwarenessUpdate(this.opts.awareness, [this.opts.awareness.clientID])
    );
  }

  private forgetPeer(peer: number): void {
    const clients = this.awarenessOf.get(peer);
    this.awarenessOf.delete(peer);
    if (!clients || clients.size === 0 || this.destroyed) return;
    removeAwarenessStates(this.opts.awareness, [...clients], this);
  }

  private handleFrame({ cls, sender, payload }: RoomFrame): void {
    if (this.destroyed) return;
    switch (cls) {
      case ROOM_CLASS_SYNC: {
        // A peer sent its state vector. Only a writer may answer; the
        // server would drop a reply from anyone else.
        if (!this.socket.canWrite) {
          // So the peer never hears what we lack. If it is a writer, it
          // may have brought something new: ask it.
          if (this.socket.peerCanWrite(sender)) {
            void this.socket.send(
              ROOM_CLASS_SYNC,
              Y.encodeStateVector(this.opts.doc)
            );
          }
          break;
        }
        const diff = Y.encodeStateAsUpdate(this.opts.doc, payload);
        void this.socket.reply(
          sender,
          encodeSyncReply(diff, Y.encodeStateVector(this.opts.doc))
        );
        break;
      }
      case ROOM_CLASS_REPLY: {
        const reply = decodeSyncReply(payload);
        if (!reply) break;
        // origin=this so the docUpdateHandler doesn't echo this back out
        // as if it were a local edit.
        Y.applyUpdate(this.opts.doc, reply.update, this);
        if (!reply.stateVector || !this.socket.canWrite) break;
        // The other half: what we have that the peer does not, such as
        // edits made while this device was offline.
        const missing = Y.encodeStateAsUpdate(this.opts.doc, reply.stateVector);
        if (missing.byteLength > EMPTY_UPDATE_BYTES) {
          void this.socket.reply(sender, encodeSyncReply(missing));
        }
        break;
      }
      case ROOM_CLASS_UPDATE:
        Y.applyUpdate(this.opts.doc, payload, this);
        break;
      case ROOM_CLASS_PRESENCE:
        applyAwarenessUpdate(
          this.opts.awareness,
          payload,
          new FromPeer(this, sender)
        );
        break;
      default:
        console.warn('[collab] unknown frame class', cls);
    }
  }
}

/**
 * Live co-editing for desktop web ink notes, over the note's room on the
 * sync server.
 *
 * This is the same exchange as `$lib/sync/collab-provider`, without
 * presence, and with every Yjs document operation delegated to the handle
 * supplied by `InkWebNoteEditor`. JS only routes update bytes; the room,
 * its members and its encryption are `room-socket.ts`.
 */

import { decodeSyncReply, encodeSyncReply } from './collab-provider';
import {
  ROOM_CLASS_PRESENCE,
  ROOM_CLASS_REPLY,
  ROOM_CLASS_SYNC,
  ROOM_CLASS_UPDATE,
  RoomSocket,
  type RoomConnection,
  type RoomFrame
} from './room-socket';

export interface InkWebCollabHandle {
  encode_state_vector(): Uint8Array;
  encode_diff_for_state_vector(stateVector: Uint8Array): Uint8Array;
  apply_remote_update(update: Uint8Array): boolean;
}

export interface InkWebCollabProviderOptions extends RoomConnection {
  handle: InkWebCollabHandle;
  noteId: string;
  onStatusChange?: (online: boolean) => void;
}

/** A Yjs update that changes nothing still encodes to two bytes. */
const EMPTY_UPDATE_BYTES = 2;

export class InkWebCollabProvider {
  private readonly socket: RoomSocket;
  private destroyed = false;

  constructor(private readonly opts: InkWebCollabProviderOptions) {
    this.socket = new RoomSocket({
      url: this.opts.url,
      keyBytes: this.opts.keyBytes,
      getTicket: this.opts.getTicket,
      label: `ink note=${this.opts.noteId}`,
      onOpen: () => this.startSync(),
      onFrame: (frame) => this.handleFrame(frame),
      onStatusChange: (online) => this.opts.onStatusChange?.(online)
    });
  }

  destroy(): void {
    this.destroyed = true;
    this.socket.destroy();
    this.opts.onStatusChange?.(false);
  }

  sendLocalUpdate(update: Uint8Array): void {
    if (update.byteLength === 0 || this.destroyed) return;
    // The server would drop it from a member who may only read.
    if (!this.socket.canWrite) return;
    void this.socket.send(ROOM_CLASS_UPDATE, update);
  }

  private startSync(): void {
    if (this.destroyed) return;
    void this.socket.send(
      ROOM_CLASS_SYNC,
      this.opts.handle.encode_state_vector()
    );
  }

  private apply(update: Uint8Array): void {
    const applied = this.opts.handle.apply_remote_update(update);
    if (!applied) {
      console.warn(
        '[ink-collab] remote update failed note=%s payload=%dB',
        this.opts.noteId,
        update.byteLength
      );
    }
  }

  private handleFrame({ cls, sender, payload }: RoomFrame): void {
    if (this.destroyed) return;
    switch (cls) {
      case ROOM_CLASS_SYNC: {
        if (!this.socket.canWrite) {
          // We cannot answer, so a writer who just joined would never
          // learn what we lack. Ask it instead.
          if (this.socket.peerCanWrite(sender)) this.startSync();
          break;
        }
        void this.socket.reply(
          sender,
          encodeSyncReply(
            this.opts.handle.encode_diff_for_state_vector(payload),
            this.opts.handle.encode_state_vector()
          )
        );
        break;
      }
      case ROOM_CLASS_REPLY: {
        const reply = decodeSyncReply(payload);
        if (!reply) break;
        this.apply(reply.update);
        if (!reply.stateVector || !this.socket.canWrite) break;
        const missing = this.opts.handle.encode_diff_for_state_vector(
          reply.stateVector
        );
        if (missing.byteLength > EMPTY_UPDATE_BYTES) {
          void this.socket.reply(sender, encodeSyncReply(missing));
        }
        break;
      }
      case ROOM_CLASS_UPDATE:
        this.apply(payload);
        break;
      case ROOM_CLASS_PRESENCE:
        break;
      default:
        console.warn('[ink-collab] unknown frame class', cls);
    }
  }
}

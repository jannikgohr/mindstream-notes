import { noteRoomInfo, noteRoomTicket, type RoomInfo } from '$lib/api';
import { base64ToBytes } from './base64';
import type { RoomConnection } from '$lib/sync/room-socket';

type ConnectionOptions = RoomConnection & {
  onStatusChange?: (online: boolean) => void;
};

/** How long the ticket that came with the room info is used before a fresh
 *  one is fetched. The server honours a ticket for about thirty seconds. */
const FIRST_TICKET_MAX_AGE_MS = 15_000;

/**
 * Everything a room socket needs, from what the Rust side said about the
 * room. The ticket that came along serves the first connection; every later
 * one asks for its own, because a ticket is good for one socket.
 */
export function roomConnection(room: RoomInfo): RoomConnection {
  let first: string | null = room.ticket;
  const issued = Date.now();
  return {
    url: room.url,
    keyBytes: base64ToBytes(room.key_b64),
    getTicket: async () => {
      const ticket = first;
      first = null;
      if (ticket && Date.now() - issued < FIRST_TICKET_MAX_AGE_MS) {
        return ticket;
      }
      return noteRoomTicket(room.collection, room.item);
    }
  };
}

/** Owns pending room lookups as well as the live connection. */
export function createCollabSession<
  Context,
  Provider extends { destroy(): void }
>(options: {
  getContext: () => { noteId: string; url: string; value: Context } | null;
  create: (context: Context, connection: ConnectionOptions) => Provider;
  onProvider?: (provider: Provider | null) => void;
  onConfigured?: (configured: boolean) => void;
  onStatusChange?: (online: boolean) => void;
}) {
  let generation = 0;
  let destroyed = false;
  let provider: Provider | null = null;
  function disconnect() {
    generation += 1;
    provider?.destroy();
    provider = null;
    options.onProvider?.(null);
    options.onConfigured?.(false);
    options.onStatusChange?.(false);
  }
  async function setup(): Promise<void> {
    disconnect();
    if (destroyed) return;
    const context = options.getContext();
    if (!context) return;
    const token = generation;
    const current = () => !destroyed && token === generation;
    try {
      const room = await noteRoomInfo(context.noteId);
      if (!current() || !room) return;
      provider = options.create(context.value, {
        ...roomConnection(room),
        onStatusChange: (online) => {
          if (current()) options.onStatusChange?.(online);
        }
      });
      options.onProvider?.(provider);
      options.onConfigured?.(true);
    } catch (error) {
      if (current()) console.warn('[collab] connection setup failed', error);
    }
  }
  return {
    setup,
    disconnect,
    destroy() {
      destroyed = true;
      disconnect();
    }
  };
}

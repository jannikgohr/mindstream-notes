import { noteRoomInfo } from '$lib/api';
import { base64ToBytes } from './base64';
import {
  collabAuthForRoom,
  getOrCreateCollabSigningMaterial
} from '$lib/sync/collab-signing-key';
import type { CollabProviderOptions } from '$lib/sync/collab-provider';

type ConnectionOptions = Omit<CollabProviderOptions, 'doc' | 'awareness'>;

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
      const signingMaterial = await getOrCreateCollabSigningMaterial();
      if (!current()) return;
      const room = await noteRoomInfo(
        context.noteId,
        signingMaterial?.publicKeyB64
      );
      if (!current() || !room) return;
      provider = options.create(context.value, {
        url: context.url,
        roomId: room.room_id,
        joinPrivateKeyPkcs8B64: room.join_private_key_pkcs8_b64,
        keyBytes: base64ToBytes(room.key_b64),
        auth: collabAuthForRoom(room, signingMaterial),
        requireSignedWrites: room.collab_epoch > 0,
        onAuthStale: () => {
          if (current()) void setup();
        },
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

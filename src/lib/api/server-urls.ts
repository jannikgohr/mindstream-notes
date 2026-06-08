/**
 * Derive the live-collab URLs from the single `account.serverUrl` the
 * user configures.
 *
 * The backend stack (see backend/docker-compose.yml) fronts three
 * services behind one nginx:
 *
 *   /socket.io/  → excalidraw-room    (freeform live sync)
 *   /yjs         → yjs-relay          (markdown + PDF Yjs collab)
 *   /            → etebase            (note storage + auth)
 *
 * Keeping the URL as a single field in settings (and a single thing
 * for users to memorise / share across devices) means each editor has
 * to translate that base into the shape its transport expects:
 *
 *   - `CollabProvider` (yjs-relay) uses `new WebSocket(...)`, which
 *     wants a ws:// or wss:// URL with the /yjs path baked in.
 *   - `ExcalidrawRoomClient` uses socket.io-client, which accepts
 *     http(s):// and appends /socket.io/ itself.
 *
 * Errors are swallowed and turned into empty strings: callers already
 * treat empty as "live collab not configured" (the editor still works,
 * just without realtime sync).
 */

/** WebSocket URL for the yjs-relay (markdown + PDF collab). */
export function getYjsRelayUrl(serverUrl: string): string {
  const trimmed = serverUrl.trim();
  if (!trimmed) return '';
  try {
    const u = new URL(trimmed);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = '/yjs';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return '';
  }
}

/** Origin URL for excalidraw-room (freeform live sync). socket.io
 *  appends /socket.io/ and upgrades the scheme itself, so we hand it
 *  the bare origin. */
export function getExcalidrawRoomUrl(serverUrl: string): string {
  const trimmed = serverUrl.trim();
  if (!trimmed) return '';
  try {
    return new URL(trimmed).origin;
  } catch {
    return '';
  }
}

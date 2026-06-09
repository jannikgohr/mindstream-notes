/**
 * Derive the live-collab URLs from the single `account.serverUrl` the
 * user configures, plus the normalisation pass we run on raw user
 * input before any of those derivations happen.
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
 * `normalizeServerUrl` is the entry point everything else funnels
 * through. It accepts user input verbatim — bare hostname, trailing
 * slash, leading/trailing whitespace, etc. — and either produces a
 * canonical origin-form URL or reports why it can't. The two
 * `get*Url` helpers below run the normalisation first and silently
 * collapse to '' on error, because their call sites already treat
 * empty as "live collab not configured" (the editor still works,
 * just without realtime sync). The sign-in form uses
 * `normalizeServerUrl` directly so it can surface the error inline
 * before the user pushes the button.
 */

export interface ServerUrlValidation {
  /** Canonical origin-form URL (no trailing slash, no path/query/hash).
   *  Empty when the input was empty or failed to parse. */
  url: string;
  /** Human-readable reason the input couldn't be parsed. `null` when
   *  the input is either empty (nothing to validate) or normalised
   *  cleanly. */
  error: string | null;
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Turn raw user input into a canonical server URL.
 *
 * Permitted variations and what we do with them:
 *
 *   "  notes.example.com  "         → "https://notes.example.com"
 *   "notes.example.com"             → "https://notes.example.com"
 *   "http://localhost:8080/"        → "http://localhost:8080"
 *   "https://collab.example.com/x"  → "https://collab.example.com"
 *                                     (path/query/hash discarded — we
 *                                     own the path prefixes downstream)
 *
 * Rejected:
 *
 *   "ftp://x.com"   → error: scheme not allowed
 *   "ws://x.com"    → error: scheme not allowed (we derive ws from
 *                     https client-side)
 *   "not a url"     → error: couldn't parse
 *   ""              → empty, no error (caller decides what to do)
 */
export function normalizeServerUrl(raw: string): ServerUrlValidation {
  const trimmed = raw.trim();
  if (!trimmed) return { url: '', error: null };

  // If the user typed something without a scheme, default to https.
  // Match `scheme://` specifically (not bare `scheme:`) so we don't
  // mistake `localhost:8080` for a URI scheme — the colon there is
  // the port separator, not a scheme delimiter.
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  const withScheme = hasScheme ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { url: '', error: 'Not a valid URL' };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return {
      url: '',
      error: `URL must use http:// or https:// (got ${parsed.protocol})`
    };
  }
  if (!parsed.hostname) {
    return { url: '', error: 'URL must include a hostname' };
  }

  // origin = scheme + host + (port if non-default). No trailing slash,
  // no path/query/hash — that's exactly the canonical form we want.
  return { url: parsed.origin, error: null };
}

/** WebSocket URL for the yjs-relay (markdown + PDF collab). */
export function getYjsRelayUrl(serverUrl: string): string {
  const { url } = normalizeServerUrl(serverUrl);
  if (!url) return '';
  // url is always an origin (scheme://host[:port]); URL() will accept it.
  const u = new URL(url);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/yjs';
  return u.toString();
}

/** Origin URL for excalidraw-room (freeform live sync). socket.io
 *  appends /socket.io/ and upgrades the scheme itself, so we hand it
 *  the bare origin. */
export function getExcalidrawRoomUrl(serverUrl: string): string {
  return normalizeServerUrl(serverUrl).url;
}

/**
 * The addresses derived from the single `account.serverUrl` the user
 * configures, plus the normalisation pass we run on raw user input before
 * any of those derivations happen.
 *
 * One server answers everything: storage and accounts over HTTP, and live
 * rooms for every kind of note on one WebSocket endpoint. Keeping the URL
 * as a single field in settings means one thing for users to memorise and
 * share across devices.
 *
 * `normalizeServerUrl` is the entry point everything else funnels
 * through. It accepts user input verbatim — bare hostname, trailing
 * slash, leading/trailing whitespace, etc. — and either produces a
 * canonical origin-form URL or reports why it can't. The `get*Url`
 * helpers below run the normalisation first and silently collapse to ''
 * on error, because their call sites already treat empty as "live collab
 * not configured" (the editor still works, just without realtime sync).
 * The sign-in form uses `normalizeServerUrl` directly so it can surface
 * the error inline before the user pushes the button.
 */

export interface ServerUrlValidation {
  /** Canonical base URL (no trailing slash, no query/hash).
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
 *   "https://collab.example.com/x"  → "https://collab.example.com/x"
 *                                     (path kept for reverse-proxy
 *                                     subpath installs; query/hash
 *                                     discarded)
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

  parsed.search = '';
  parsed.hash = '';

  let url = parsed.toString();
  if (url.endsWith('/')) url = url.slice(0, -1);
  return { url, error: null };
}

/**
 * WebSocket URL of the server's live rooms. Empty when no server is
 * configured, which editors read as "no live collab".
 *
 * The Rust side reports the same address with each room it resolves, from
 * the session it actually holds, and that one is what a socket connects to.
 */
export function getRoomSocketUrl(serverUrl: string): string {
  const { url } = normalizeServerUrl(serverUrl);
  if (!url) return '';
  const u = new URL(url);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = joinPath(u.pathname, 'api/v1/room/');
  return u.toString();
}

export function getServerHealthUrl(serverUrl: string): string {
  const { url } = normalizeServerUrl(serverUrl);
  if (!url) return '';
  const u = new URL(url);
  u.pathname = joinPath(u.pathname, 'healthz');
  return u.toString();
}

function joinPath(basePath: string, segment: string): string {
  const normalized = basePath === '/' ? '' : basePath.replace(/\/+$/, '');
  return `${normalized}/${segment}`;
}

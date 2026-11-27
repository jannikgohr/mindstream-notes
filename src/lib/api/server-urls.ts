import { tUi, tUiFormat } from '$lib/settings/i18n.svelte';
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
 *   "http://x.com"  → error: plain http only reaches localhost, .local,
 *                     .lan and private addresses (mirrors `parse_server_url`
 *                     in src-tauri/src/auth/mod.rs)
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
    return { url: '', error: tUi('account.server.invalidUrl') };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return {
      url: '',
      error: tUiFormat('account.server.badScheme', {
        scheme: parsed.protocol
      })
    };
  }
  if (!parsed.hostname) {
    return { url: '', error: tUi('account.server.noHost') };
  }
  if (parsed.protocol === 'http:' && !isLocalHost(parsed.hostname)) {
    return { url: '', error: tUi('account.server.httpsRequired') };
  }

  parsed.search = '';
  parsed.hash = '';

  let url = parsed.toString();
  if (url.endsWith('/')) url = url.slice(0, -1);
  return { url, error: null };
}

function isLocalHost(hostname: string): boolean {
  if (
    hostname === 'localhost' ||
    ['.localhost', '.local', '.lan'].some((suffix) => hostname.endsWith(suffix))
  ) {
    return true;
  }
  const v4 = hostname.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (v4) return isLocalIpv4(Number(v4[1]), Number(v4[2]));
  if (!hostname.startsWith('[')) return false;
  // URL serialises IPv6 compressed and lowercase, and an IPv4-mapped
  // address in hex: [::ffff:c0a8:1].
  const v6 = hostname.slice(1, -1);
  if (v6 === '::1') return true;
  const mapped = v6.match(/^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/);
  if (mapped) {
    const high = parseInt(mapped[1], 16);
    return isLocalIpv4(high >> 8, high & 0xff);
  }
  const first = parseInt(v6.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

function isLocalIpv4(a: number, b: number): boolean {
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && (b & 0xc0) === 64)
  );
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

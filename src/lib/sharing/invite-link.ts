/**
 * Reading an invite link's text.
 *
 * A link is the server's address, `join/`, the link's uid and, after a `#`,
 * a secret: `https://notes.example.com/join/<uid>#<secret>`. The Rust side
 * is what opens and claims a link. This only tells a link from other text
 * and says which server it belongs to, so a form can react while someone is
 * still typing. It mirrors `InviteLink::parse` in the client library.
 */

export interface InviteLinkParts {
  /** The server the link belongs to, ending in a slash. */
  serverUrl: string;
  /** The link's uid. It is not a secret. */
  uid: string;
}

/** 32 bytes as URL-safe base64 without padding. */
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const UID = /^[A-Za-z0-9_-]{1,64}$/;

/** The parts of `text` if it is an invite link, or null. */
export function parseInviteLink(text: string): InviteLinkParts | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!SECRET.test(url.hash.slice(1))) return null;

  // Everything before `join/<uid>` is the server, which may itself live
  // under a path.
  const path = url.pathname.replace(/\/+$/, '');
  const cut = path.lastIndexOf('/');
  if (cut < 0) return null;
  const uid = path.slice(cut + 1);
  const before = path.slice(0, cut);
  if (!UID.test(uid) || !before.endsWith('/join')) return null;
  const base = before.slice(0, before.length - 'join'.length);

  return { serverUrl: `${url.origin}${base}`, uid };
}

/** A server's address the way a person would say it: its host. */
export function serverName(serverUrl: string): string {
  try {
    const url = new URL(serverUrl);
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.host}${path}`;
  } catch {
    return serverUrl;
  }
}

/** Whether two addresses name the same server, however each is written. */
export function sameServer(one: string, other: string): boolean {
  const parts = (text: string) => {
    try {
      const url = new URL(text.trim());
      return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
    } catch {
      return null;
    }
  };
  const first = parts(one);
  return first !== null && first === parts(other);
}

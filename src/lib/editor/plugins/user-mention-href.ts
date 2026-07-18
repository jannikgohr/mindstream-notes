/**
 * The user-mention URL format — the on-disk contract behind an `@name`.
 *
 * Sibling of `./wikilink-href.ts`, same rationale: a mention serializes
 * as an ordinary markdown link, `[@username](mindstream://user/<username>)`,
 * so both editing surfaces (and the render-time href neutralizer) have to
 * agree on the shape. Shared at the plugins root rather than owned by
 * either surface.
 */

import { encodeLinkValue } from './link-url';

const USER_LINK_PREFIX = 'mindstream://user/';

export function userHref(username: string): string {
  return `${USER_LINK_PREFIX}${encodeLinkValue(username)}`;
}

/**
 * The username inside a `mindstream://user/…` href, or null for anything
 * else. Total, for the same reasons as `parseNoteHref` — callers treat
 * the null return as "not a mention".
 */
export function parseUserHref(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  if (!href.startsWith(USER_LINK_PREFIX)) return null;
  const raw = href.slice(USER_LINK_PREFIX.length);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

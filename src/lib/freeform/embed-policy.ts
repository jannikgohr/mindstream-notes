/**
 * Which web embeds a drawing loads.
 *
 * Excalidraw mounts an embed's iframe as soon as the element scrolls into
 * view, so whoever wrote the URL decides what loads inside the app window.
 * In a private drawing that is the user, and any https page loads. In a
 * drawing inside a shared folder it can be any collaborator with edit
 * access, who could frame a fake sign-in page. There, only the sites
 * Excalidraw embeds by default and hosts the user allowed load; the rest
 * show a placeholder that names the host and lets the user allow it.
 */

import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';

/**
 * Excalidraw 0.18.1's built-in embed list (`ALLOWED_DOMAINS` in
 * @excalidraw/excalidraw). A leading `*.` stands for exactly one label.
 */
export const DEFAULT_EMBED_HOSTS: readonly string[] = [
  'youtube.com',
  'youtu.be',
  'vimeo.com',
  'player.vimeo.com',
  'figma.com',
  'link.excalidraw.com',
  'gist.github.com',
  'twitter.com',
  'x.com',
  '*.simplepdf.eu',
  'stackblitz.com',
  'val.town',
  'giphy.com',
  'reddit.com'
];

/**
 * Hosts Excalidraw renders as a srcdoc frame that pulls in the site's
 * widget script. A srcdoc frame inherits the app's CSP, whose script-src
 * only admits the app's own scripts, so these would stay blank.
 */
const SCRIPT_WIDGET_HOSTS = new Set([
  'twitter.com',
  'x.com',
  'reddit.com',
  'gist.github.com'
]);

export type EmbedDecision =
  /** Hand the element to Excalidraw's own iframe. */
  | 'load'
  /** Shared drawing, host not trusted yet. */
  | 'blocked'
  /** The site only embeds through a script the CSP refuses. */
  | 'unsupported'
  /** Not an https URL. */
  | 'not-https';

export interface EmbedPolicy {
  /** The drawing lives in a folder shared by or with the user. */
  shared: boolean;
  /** Hosts the user allowed for shared drawings, as `embedHost` returns them. */
  allowedHosts: readonly string[];
}

function parseUrl(link: string): URL | null {
  try {
    return new URL(link);
  } catch {
    return null;
  }
}

function bareHost(url: URL): string {
  return url.hostname.replace(/\.$/, '').replace(/^www\./, '');
}

/**
 * The host an embed is judged by: lowercase, without `www.` or a trailing
 * dot. `null` when the link is not an absolute http(s) URL.
 */
export function embedHost(link: string): string | null {
  const url = parseUrl(link);
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    return null;
  }
  return bareHost(url) || null;
}

/** Same matching as Excalidraw's `matchHostname` against its own list. */
function isDefaultEmbedHost(host: string): boolean {
  if (DEFAULT_EMBED_HOSTS.includes(host)) return true;
  return DEFAULT_EMBED_HOSTS.includes(host.replace(/^[^.]+/, '*'));
}

/**
 * Passed to Excalidraw as `validateEmbeddable`. Accepting every http(s)
 * link keeps Excalidraw from drawing its own "raise an issue on GitHub"
 * notice; `embedDecision` then picks what each element shows.
 */
export function isEmbeddableLink(link: string): boolean {
  return embedHost(link) !== null;
}

export function embedDecision(
  link: string,
  policy: EmbedPolicy
): EmbedDecision {
  const url = parseUrl(link);
  if (!url || url.protocol !== 'https:') return 'not-https';
  const host = bareHost(url);
  if (SCRIPT_WIDGET_HOSTS.has(host)) return 'unsupported';
  if (!policy.shared) return 'load';
  if (isDefaultEmbedHost(host) || policy.allowedHosts.includes(host)) {
    return 'load';
  }
  return 'blocked';
}

/**
 * Excalidraw renders an `iframe` element, the output of its AI "magic
 * frame", as a srcdoc frame of the HTML in `customData.generationData`.
 * Nothing in this app creates one, and since the CSP lets frames load any
 * https page, that HTML could frame one in a shared drawing without going
 * through `embedDecision`. Without the HTML, Excalidraw shows its "no
 * generation data" notice instead.
 *
 * Only the copy handed to Excalidraw changes. The Y.Doc binding writes an
 * element back only when its version changes, so the stored HTML stays
 * until someone edits the element.
 */
export function withoutGeneratedHtml(
  elements: readonly ExcalidrawElement[]
): ExcalidrawElement[] {
  return elements.map((element) => {
    if (element.type !== 'iframe' || !element.customData?.generationData) {
      return element;
    }
    const { generationData: _generationData, ...customData } =
      element.customData;
    return { ...element, customData };
  });
}

/** The stored setting value, cleaned up: unique lowercase host strings. */
export function normalizeAllowedHosts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const hosts = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const host = entry.trim().toLowerCase();
    if (host) hosts.add(host);
  }
  return [...hosts];
}

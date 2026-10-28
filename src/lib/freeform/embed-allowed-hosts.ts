/**
 * The hosts the user allowed to load in shared drawings.
 *
 * Kept in the vault's settings, never in the drawing: anything stored in
 * the scene is written by collaborators too, and they must not be able to
 * extend the list that guards against them.
 */

import {
  getSettingValue,
  resetSettingValue,
  setSettingValue
} from '$lib/settings/store.svelte';
import { normalizeAllowedHosts } from './embed-policy';

export const EMBED_ALLOWED_HOSTS_SETTING = 'editor.freeform.embedAllowedHosts';

export function allowedEmbedHosts(): string[] {
  return normalizeAllowedHosts(getSettingValue(EMBED_ALLOWED_HOSTS_SETTING));
}

export async function allowEmbedHost(host: string): Promise<void> {
  const hosts = allowedEmbedHosts();
  if (hosts.includes(host)) return;
  await setSettingValue(EMBED_ALLOWED_HOSTS_SETTING, [...hosts, host]);
}

export async function removeAllowedEmbedHost(host: string): Promise<void> {
  const hosts = allowedEmbedHosts().filter((entry) => entry !== host);
  // Clearing rather than storing [] keeps the setting unmodified once the
  // list is empty again.
  if (hosts.length === 0) {
    await resetSettingValue(EMBED_ALLOWED_HOSTS_SETTING);
  } else {
    await setSettingValue(EMBED_ALLOWED_HOSTS_SETTING, hosts);
  }
}

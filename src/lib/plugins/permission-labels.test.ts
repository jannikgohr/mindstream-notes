import { describe, expect, it } from 'vitest';
import en from '$lib/settings/i18n/en.json';
import de from '$lib/settings/i18n/de.json';
import { KNOWN_PLUGIN_PERMISSIONS } from './types';

/**
 * Every permission needs a label in every locale.
 *
 * `textCheckers.contribute` shipped without one and reached the plugin panel as
 * the raw key `plugins.permission.textCheckers.contribute`, because `tUi`
 * returns the key when it has no string — a sensible fallback that makes a
 * missing label invisible to everything except a person looking at the screen.
 *
 * The permission list and the bundles are edited in different files, so nothing
 * connected them; adding a permission simply left its label behind. This is the
 * connection.
 */
const BUNDLES = { en: en.ui, de: de.ui } as Record<
  string,
  Record<string, string>
>;

describe('plugin permission labels', () => {
  for (const [locale, ui] of Object.entries(BUNDLES)) {
    it(`covers every known permission in ${locale}`, () => {
      const missing = KNOWN_PLUGIN_PERMISSIONS.filter(
        (permission) => !ui[`plugins.permission.${permission}`]
      );
      expect(missing).toEqual([]);
    });
  }

  it('has no labels for permissions that no longer exist', () => {
    // The other direction, so removing a permission does not leave its string
    // behind to be translated forever.
    const known = new Set<string>(
      KNOWN_PLUGIN_PERMISSIONS.map((p) => `plugins.permission.${p}`)
    );
    for (const [locale, ui] of Object.entries(BUNDLES)) {
      const orphaned = Object.keys(ui).filter(
        (key) => key.startsWith('plugins.permission.') && !known.has(key)
      );
      expect(orphaned, locale).toEqual([]);
    }
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import {
  closePluginMenu,
  openPluginMenu,
  pluginMenu
} from './plugin-menu.svelte';

beforeEach(() => closePluginMenu());

describe('plugin context menu state', () => {
  it('opens at the given coordinates with the given items', () => {
    openPluginMenu(12, 34, [
      { label: 'Do a thing', onSelect: () => {} },
      'separator'
    ]);
    expect(pluginMenu.open).toBe(true);
    expect(pluginMenu.x).toBe(12);
    expect(pluginMenu.y).toBe(34);
    expect(pluginMenu.items).toHaveLength(2);
  });

  it('closes and clears its items', () => {
    openPluginMenu(1, 1, [{ label: 'x', onSelect: () => {} }]);
    closePluginMenu();
    expect(pluginMenu.open).toBe(false);
    expect(pluginMenu.items).toEqual([]);
  });
});

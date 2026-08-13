import { describe, expect, it } from 'vitest';
import {
  closeShortcutHelp,
  openShortcutHelp,
  shortcutHelp
} from './help.svelte';

describe('shortcut help state', () => {
  it('opens and closes the overlay', () => {
    closeShortcutHelp();
    expect(shortcutHelp.open).toBe(false);
    openShortcutHelp();
    expect(shortcutHelp.open).toBe(true);
    closeShortcutHelp();
    expect(shortcutHelp.open).toBe(false);
  });
});

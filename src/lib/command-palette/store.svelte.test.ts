import { beforeEach, describe, expect, it } from 'vitest';
import {
  closeCommandPalette,
  commandPalette,
  openCommandPalette,
  toggleCommandPalette
} from './store.svelte';

beforeEach(() => closeCommandPalette());

describe('command palette state', () => {
  it('opens and closes', () => {
    openCommandPalette();
    expect(commandPalette.open).toBe(true);
    closeCommandPalette();
    expect(commandPalette.open).toBe(false);
  });

  it('toggles between states', () => {
    toggleCommandPalette();
    expect(commandPalette.open).toBe(true);
    toggleCommandPalette();
    expect(commandPalette.open).toBe(false);
  });
});

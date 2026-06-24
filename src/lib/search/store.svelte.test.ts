import { beforeEach, describe, expect, it } from 'vitest';
import {
  closeSearch,
  openSearch,
  searchDialog,
  toggleSearch
} from './store.svelte';

beforeEach(() => {
  searchDialog.open = false;
});

describe('search dialog state', () => {
  it('opens and closes', () => {
    openSearch();
    expect(searchDialog.open).toBe(true);
    closeSearch();
    expect(searchDialog.open).toBe(false);
  });

  it('toggles', () => {
    toggleSearch();
    expect(searchDialog.open).toBe(true);
    toggleSearch();
    expect(searchDialog.open).toBe(false);
  });
});

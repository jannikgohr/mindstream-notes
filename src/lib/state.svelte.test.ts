import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  openRightSidebar,
  previewLeftSidebarWidth,
  previewRightSidebarWidth,
  setActiveNote,
  setLeftSidebarWidth,
  setRightSidebarWidth,
  setSortDirection,
  setSortStrategy,
  toggleLeftSidebar,
  toggleRightSidebar,
  toggleSortDirection,
  ui
} from './state.svelte';

beforeEach(() => {
  ui.leftSidebarOpen = true;
  ui.rightSidebarOpen = true;
  ui.sortDirection = 'asc';
  ui.activeNoteId = null;
});

describe('active note', () => {
  it('sets and clears the active note id', () => {
    setActiveNote('n1');
    expect(ui.activeNoteId).toBe('n1');
    setActiveNote(null);
    expect(ui.activeNoteId).toBeNull();
  });
});

describe('sidebars', () => {
  it('toggles each sidebar', () => {
    toggleLeftSidebar();
    expect(ui.leftSidebarOpen).toBe(false);
    toggleRightSidebar();
    expect(ui.rightSidebarOpen).toBe(false);
  });

  it('openRightSidebar opens it and is idempotent when already open', () => {
    ui.rightSidebarOpen = false;
    openRightSidebar();
    expect(ui.rightSidebarOpen).toBe(true);
    openRightSidebar();
    expect(ui.rightSidebarOpen).toBe(true);
  });

  it('sets sidebar widths', () => {
    setLeftSidebarWidth(321);
    setRightSidebarWidth(289);
    expect(ui.leftSidebarWidth).toBe(321);
    expect(ui.rightSidebarWidth).toBe(289);
  });

  it('previews widths during a drag without saving them', () => {
    vi.useFakeTimers();
    try {
      localStorage.clear();
      previewLeftSidebarWidth(300);
      previewRightSidebarWidth(260);
      vi.runAllTimers();
      expect(ui.leftSidebarWidth).toBe(300);
      expect(ui.rightSidebarWidth).toBe(260);
      expect(localStorage.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('sort', () => {
  it('sets the strategy', () => {
    setSortStrategy('modified');
    expect(ui.sortStrategy).toBe('modified');
  });

  it('sets and toggles the direction', () => {
    setSortDirection('desc');
    expect(ui.sortDirection).toBe('desc');
    toggleSortDirection();
    expect(ui.sortDirection).toBe('asc');
    toggleSortDirection();
    expect(ui.sortDirection).toBe('desc');
  });
});

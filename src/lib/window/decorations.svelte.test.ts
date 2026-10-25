import { afterEach, describe, expect, it, vi } from 'vitest';

// macOS defaults to native decorations, so only the preview can turn the
// custom ones on.
vi.mock('$lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/platform')>()),
  getPlatform: () => 'macos'
}));

async function loadWithQuery(search: string) {
  window.history.replaceState(null, '', `/${search}`);
  vi.resetModules();
  return import('./decorations.svelte');
}

afterEach(() => {
  window.history.replaceState(null, '', '/');
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe('window controls preview', () => {
  it('draws custom decorations in a browser opened with ?windowControls', async () => {
    const chrome = await loadWithQuery('?windowControls');

    expect(chrome.windowControlsPreview()).toBe(true);
    chrome.initWindowChrome();
    expect(chrome.windowChrome.customDecorations).toBe(true);
  });

  it('keeps the platform default without the query', async () => {
    const chrome = await loadWithQuery('');

    expect(chrome.windowControlsPreview()).toBe(false);
    chrome.initWindowChrome();
    expect(chrome.windowChrome.customDecorations).toBe(false);
  });

  it('ignores the query inside Tauri', async () => {
    const chrome = await loadWithQuery('?windowControls');
    Object.assign(window, { __TAURI_INTERNALS__: {} });

    expect(chrome.windowControlsPreview()).toBe(false);
  });
});

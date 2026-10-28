import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance
} from 'vitest';

const { isTauri, open } = vi.hoisted(() => ({
  isTauri: vi.fn<() => boolean>(),
  open: vi.fn<(url: string) => Promise<void>>()
}));

vi.mock('./core', () => ({ isTauri }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open }));

import { openExternalUrl } from './external-url';

let windowOpen: MockInstance<typeof window.open>;

beforeEach(() => {
  isTauri.mockReset().mockReturnValue(true);
  open.mockReset().mockResolvedValue(undefined);
  windowOpen = vi.spyOn(window, 'open').mockReturnValue(null);
});

afterEach(() => {
  windowOpen.mockRestore();
});

describe('openExternalUrl', () => {
  it('opens web and mail links in the system browser', async () => {
    await openExternalUrl('https://example.com/a');
    await openExternalUrl('mailto:someone@example.com');
    expect(open.mock.calls).toEqual([
      ['https://example.com/a'],
      ['mailto:someone@example.com']
    ]);
  });

  it('ignores links that are not navigation', async () => {
    await openExternalUrl('javascript:alert(1)');
    await openExternalUrl('file:///etc/passwd');
    expect(open).not.toHaveBeenCalled();
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it('opens a new tab outside the desktop app', async () => {
    isTauri.mockReturnValue(false);
    await openExternalUrl('https://example.com/');
    expect(open).not.toHaveBeenCalled();
    expect(windowOpen).toHaveBeenCalledWith(
      'https://example.com/',
      '_blank',
      'noopener,noreferrer'
    );
  });

  it('logs instead of throwing when the browser cannot be opened', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    open.mockRejectedValue(new Error('denied'));
    await expect(
      openExternalUrl('https://example.com/')
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { observe, openWindow } = vi.hoisted(() => ({
  observe: vi.fn(),
  openWindow: vi.fn()
}));
vi.mock('$lib/api/vault-window-state', () => ({
  getVaultWindowState: observe
}));
vi.mock('$lib/api/profiles', () => ({ openProfileWindow: openWindow }));
import { VaultMenu } from './menu.svelte';

const VIEW = {
  supervised: true,
  vaults: [
    { vaultId: 'source', status: 'ready' },
    { vaultId: 'loading', status: 'starting' },
    { vaultId: 'held', status: 'unavailable' }
  ]
};

beforeEach(() => {
  observe.mockReset().mockResolvedValue(VIEW);
  openWindow.mockReset().mockResolvedValue(undefined);
});

describe('vault menu ownership and opening', () => {
  it('asks for closed vaults, respects remembered choices, and overrides them for Ctrl-click', async () => {
    const menu = new VaultMenu();
    await menu.refresh();
    expect(menu.decision('closed', 'ask')).toBe('ask');
    expect(menu.decision('closed', 'thisWindow')).toBe('thisWindow');
    expect(menu.decision('closed', 'newWindow')).toBe('newWindow');
    expect(menu.decision('closed', 'invalid')).toBe('ask');
    expect(menu.decision('closed', 'thisWindow', true)).toBe('newWindow');
    for (const id of ['source', 'loading', 'held'])
      expect(menu.decision(id, 'thisWindow')).toBe('newWindow');
    await menu.open('closed', 'thisWindow');
    expect(openWindow).toHaveBeenCalledWith('closed', true);
  });
  it('keeps every observed owner undeletable, including starting and unavailable workers', async () => {
    const menu = new VaultMenu();
    expect(menu.canDelete('closed')).toBe(false);
    await menu.refresh();
    for (const entry of VIEW.vaults) {
      expect(menu.status(entry.vaultId)).toBe(entry.status);
      expect(menu.canDelete(entry.vaultId)).toBe(false);
    }
    expect(menu.canDelete('closed')).toBe(true);
  });

  it('routes existing and closed targets through the same native action without changing the source', async () => {
    const menu = new VaultMenu();
    await menu.refresh();
    expect(await menu.open('source')).toBe(true);
    expect(await menu.open('closed')).toBe(true);
    expect(openWindow.mock.calls).toEqual([['source'], ['closed']]);
    expect(menu.status('source')).toBe('ready');
  });

  it('never turns coordinator failure into direct mode or a closed-vault list', async () => {
    const menu = new VaultMenu();
    await menu.refresh();
    observe.mockRejectedValueOnce(new Error('coordinator unavailable'));
    expect(await menu.refresh()).toBe(false);
    expect(menu.failed).toBe(true);
    expect(menu.view).toBeNull();
    expect(menu.canDelete('held')).toBe(false);
    await expect(menu.open('target')).rejects.toThrow(/unavailable/);
    expect(openWindow).not.toHaveBeenCalled();
    expect(await menu.refresh()).toBe(true);
    expect(menu.failed).toBe(false);
    expect(menu.status('held')).toBe('unavailable');
  });

  it('allows legacy switching only after an explicit direct-mode observation', async () => {
    observe.mockResolvedValue({ supervised: false, vaults: [] });
    const menu = new VaultMenu();
    await menu.refresh();
    expect(await menu.open('target')).toBe(false);
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('propagates failed target preparation and preserves the source observation', async () => {
    const menu = new VaultMenu();
    await menu.refresh();
    openWindow.mockRejectedValueOnce(new Error('target ownership retained'));
    await expect(menu.open('held')).rejects.toThrow(/ownership retained/);
    expect(menu.status('source')).toBe('ready');
    expect(menu.view?.supervised).toBe(true);
  });

  it('blocks opening and deletion while checking and discards a late response after closing', async () => {
    let finish: (view: typeof VIEW) => void = () => {};
    observe.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const menu = new VaultMenu();
    const loading = menu.refresh();
    expect(menu.checking).toBe(true);
    expect(menu.canDelete('closed')).toBe(false);
    await expect(menu.open('target')).rejects.toThrow(/unavailable/);
    menu.invalidate();
    finish(VIEW);
    expect(await loading).toBe(false);
    expect(menu.view).toBeNull();
    expect(menu.checking).toBe(false);
  });

  it('polls a current view without blocking the menu, and blocks again once closed', async () => {
    let finish: (view: unknown) => void = () => {};
    const menu = new VaultMenu();
    await menu.refresh();
    observe.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const poll = menu.refresh();
    expect(menu.checking).toBe(false);
    expect(menu.canDelete('closed')).toBe(true);
    expect(await menu.open('closed')).toBe(true);
    finish({
      supervised: true,
      vaults: [{ vaultId: 'closed', status: 'ready' }]
    });
    expect(await poll).toBe(true);
    expect(menu.canDelete('closed')).toBe(false);

    menu.invalidate();
    observe.mockReturnValueOnce(new Promise(() => {}));
    void menu.refresh();
    expect(menu.checking).toBe(true);
    expect(menu.canDelete('source')).toBe(false);
    await expect(menu.open('source')).rejects.toThrow(/unavailable/);
  });

  it('blocks the menu again for the check that follows a failed poll', async () => {
    const menu = new VaultMenu();
    await menu.refresh();
    observe.mockRejectedValueOnce(new Error('coordinator unavailable'));
    expect(await menu.refresh()).toBe(false);
    observe.mockReturnValueOnce(new Promise(() => {}));
    void menu.refresh();
    expect(menu.checking).toBe(true);
    expect(menu.failed).toBe(false);
  });

  it('cannot replace a newer supervised observation with an older direct response', async () => {
    let finish: (view: unknown) => void = () => {};
    observe.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const menu = new VaultMenu();
    const old = menu.refresh();
    await menu.refresh();
    finish({ supervised: false, vaults: [] });
    expect(await old).toBe(false);
    expect(menu.view?.supervised).toBe(true);
    expect(menu.checking).toBe(false);
  });
});

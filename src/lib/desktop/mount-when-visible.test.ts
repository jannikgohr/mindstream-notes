import { describe, expect, it, vi } from 'vitest';
import { mountWhenFirstVisible } from './mount-when-visible';

function fakePanelApi() {
  const listeners = new Set<(event: { isVisible: boolean }) => void>();
  return {
    // Dockview reports a panel as visible until its group has placed it.
    isVisible: true,
    onDidVisibilityChange(listener: (event: { isVisible: boolean }) => void) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    setVisible(isVisible: boolean) {
      this.isVisible = isVisible;
      for (const listener of listeners) listener({ isVisible });
    },
    listenerCount: () => listeners.size
  };
}

const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe('mountWhenFirstVisible', () => {
  it('mounts the panel its group shows', async () => {
    const api = fakePanelApi();
    const mount = vi.fn();
    mountWhenFirstVisible(api, mount);
    expect(mount).not.toHaveBeenCalled();

    await settle();
    expect(mount).toHaveBeenCalledTimes(1);
    expect(api.listenerCount()).toBe(0);
  });

  it('leaves a restored background tab unmounted until it is first shown', async () => {
    const api = fakePanelApi();
    const mount = vi.fn();
    mountWhenFirstVisible(api, mount);
    // A restore activates each panel in turn before settling on one.
    api.setVisible(false);
    api.setVisible(true);
    api.setVisible(false);
    await settle();
    expect(mount).not.toHaveBeenCalled();

    api.setVisible(true);
    await settle();
    api.setVisible(false);
    api.setVisible(true);
    await settle();
    expect(mount).toHaveBeenCalledTimes(1);
  });

  it('never mounts a panel disposed before it was shown', async () => {
    const api = fakePanelApi();
    const mount = vi.fn();
    const stop = mountWhenFirstVisible(api, mount);
    api.setVisible(false);
    stop();
    api.setVisible(true);
    await settle();
    expect(mount).not.toHaveBeenCalled();
    expect(api.listenerCount()).toBe(0);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { notificationState } from '$lib/notifications/store.svelte';
import { settingsDialog } from '$lib/settings/store.svelte';
import { reportGatedPlugins } from './gate-notify';

afterEach(() => {
  notificationState.items = [];
  settingsDialog.open = false;
  settingsDialog.requestedCategory = null;
});

describe('reportGatedPlugins', () => {
  it('adds a notification listing the gated plugins', () => {
    reportGatedPlugins([{ id: 'com.a.plugin', name: 'Plugin A' }]);
    const n = notificationState.items.find((i) => i.kind === 'plugin-gated');
    expect(n).toBeTruthy();
    expect((n?.data as { message: string }).message).toContain('Plugin A');
  });

  it('clears the notification when nothing is gated', () => {
    reportGatedPlugins([{ id: 'com.a.plugin', name: 'Plugin A' }]);
    reportGatedPlugins([]);
    expect(notificationState.items.some((i) => i.kind === 'plugin-gated')).toBe(
      false
    );
  });

  it('keeps a single notification across repeated reports', () => {
    reportGatedPlugins([{ id: 'com.a.plugin', name: 'A' }]);
    reportGatedPlugins([{ id: 'com.b.plugin', name: 'B' }]);
    expect(
      notificationState.items.filter((i) => i.kind === 'plugin-gated')
    ).toHaveLength(1);
  });

  it('onOpen deep-links to the Plugins settings category', () => {
    reportGatedPlugins([{ id: 'com.a.plugin', name: 'A' }]);
    const n = notificationState.items.find((i) => i.kind === 'plugin-gated');
    void n?.onOpen?.();
    expect(settingsDialog.open).toBe(true);
    expect(settingsDialog.requestedCategory).toBe('plugins');
  });
});

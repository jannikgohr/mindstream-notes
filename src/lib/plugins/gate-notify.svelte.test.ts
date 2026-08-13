import { afterEach, describe, expect, it } from 'vitest';
import { notificationState } from '$lib/notifications/store.svelte';
import { settingsDialog } from '$lib/settings/store.svelte';
import { reportGatedPlugins, type GatedPlugin } from './gate-notify';

const changed = (id: string, name: string): GatedPlugin => ({
  id,
  name,
  reason: 'changed'
});
const fresh = (id: string, name: string): GatedPlugin => ({
  id,
  name,
  reason: 'new'
});

afterEach(() => {
  notificationState.items = [];
  settingsDialog.open = false;
  settingsDialog.requestedCategory = null;
});

describe('reportGatedPlugins', () => {
  it('adds a re-approval notification for a previously-approved plugin that changed', () => {
    reportGatedPlugins([changed('com.a.plugin', 'Plugin A')]);
    const n = notificationState.items.find((i) => i.kind === 'plugin-gated');
    expect(n).toBeTruthy();
    const msg = (n?.data as { message: string; title: string }).message;
    expect(msg).toContain('Plugin A');
    expect(msg.toLowerCase()).toContain('changed');
  });

  it('adds a separate approval notification for a newly-installed plugin', () => {
    reportGatedPlugins([fresh('com.b.plugin', 'Plugin B')]);
    const changedN = notificationState.items.find(
      (i) => i.kind === 'plugin-gated'
    );
    const newN = notificationState.items.find((i) => i.kind === 'plugin-new');
    expect(changedN).toBeFalsy();
    expect(newN).toBeTruthy();
    expect((newN?.data as { message: string }).message).toContain('Plugin B');
  });

  it('surfaces both notifications when both cases are present', () => {
    reportGatedPlugins([changed('com.a', 'A'), fresh('com.b', 'B')]);
    expect(
      notificationState.items.filter((i) => i.kind === 'plugin-gated')
    ).toHaveLength(1);
    expect(
      notificationState.items.filter((i) => i.kind === 'plugin-new')
    ).toHaveLength(1);
  });

  it('clears each category independently', () => {
    reportGatedPlugins([changed('com.a', 'A'), fresh('com.b', 'B')]);
    // Only the changed one remains gated now → the "new" notification clears.
    reportGatedPlugins([changed('com.a', 'A')]);
    expect(notificationState.items.some((i) => i.kind === 'plugin-new')).toBe(
      false
    );
    expect(notificationState.items.some((i) => i.kind === 'plugin-gated')).toBe(
      true
    );
    reportGatedPlugins([]);
    expect(notificationState.items).toHaveLength(0);
  });

  it('keeps a single notification per category across repeated reports', () => {
    reportGatedPlugins([changed('com.a.plugin', 'A')]);
    reportGatedPlugins([changed('com.b.plugin', 'B')]);
    expect(
      notificationState.items.filter((i) => i.kind === 'plugin-gated')
    ).toHaveLength(1);
  });

  it('onOpen deep-links to the Plugins settings category', () => {
    reportGatedPlugins([changed('com.a.plugin', 'A')]);
    const n = notificationState.items.find((i) => i.kind === 'plugin-gated');
    void n?.onOpen?.();
    expect(settingsDialog.open).toBe(true);
    expect(settingsDialog.requestedCategory).toBe('plugins');
  });
});

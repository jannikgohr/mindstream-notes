/**
 * A notice is replaced by a newer copy of itself whenever its source is read
 * again: every rescan of the invitations does it, and every sync that still
 * runs into a limit. The widget showing it has to stay where it is. Taken
 * down and put up again, a button can be replaced under a click, and
 * whatever the widget held, an error it had just shown, is gone.
 */
import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppNotification } from './types';

// The widgets load on demand. Here the load takes a turn of the event loop,
// as a first load does in the app. A widget that is taken down and loaded
// again is then gone from the page in between, which is what the second
// test looks for.
vi.mock('./widgets', async () => {
  const generic = (await import('./GenericNotificationWidget.svelte')).default;
  const later = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return generic;
  };
  return {
    NOTIFICATION_WIDGET_LOADERS: { generic: later },
    FALLBACK_NOTIFICATION_WIDGET_LOADER: later
  };
});

import LazyNotificationWidget from './LazyNotificationWidget.svelte';

function notice(title: string, over: Partial<AppNotification> = {}) {
  return {
    id: 'sync:limit:own:storage_full',
    kind: 'sync-limit',
    widgetType: 'generic',
    createdAt: 0,
    data: { title },
    ...over
  } satisfies AppNotification;
}

afterEach(cleanup);

describe('LazyNotificationWidget', () => {
  it('shows the widget for the kind of notice once it has loaded', async () => {
    render(LazyNotificationWidget, { notification: notice('First') });
    expect(await screen.findByText('First')).toBeTruthy();
  });

  it('keeps the widget in place when the notice is replaced by a newer copy', async () => {
    const { rerender } = render(LazyNotificationWidget, {
      notification: notice('First')
    });
    const before = (await screen.findByText('First')).closest('button');
    expect(before).not.toBeNull();

    // A new object with the same id and kind, as a rescan produces.
    await rerender({ notification: notice('Second', { createdAt: 5 }) });

    // At once, with no load in between: the same button, with the new text.
    expect(screen.getByText('Second').closest('button')).toBe(before);
    expect(screen.queryByText('First')).toBeNull();
    // And still the same one after a load would have finished.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(screen.getByText('Second').closest('button')).toBe(before);
  });
});

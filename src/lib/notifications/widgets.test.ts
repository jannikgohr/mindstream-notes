import { describe, expect, it, vi } from 'vitest';

// Stub the actual widget components so invoking a loader resolves instantly
// (importing the real Svelte components pulls in a heavy chain).
vi.mock('./GenericNotificationWidget.svelte', () => ({
  default: 'GenericWidget'
}));
vi.mock('./UpdateNotificationWidget.svelte', () => ({
  default: 'UpdateWidget'
}));
vi.mock('./CollaborationInviteNotificationWidget.svelte', () => ({
  default: 'InviteWidget'
}));
vi.mock('./ShareBundleNotificationWidget.svelte', () => ({
  default: 'ShareBundleWidget'
}));

import {
  FALLBACK_NOTIFICATION_WIDGET_LOADER,
  NOTIFICATION_WIDGET_LOADERS
} from './widgets';

describe('NOTIFICATION_WIDGET_LOADERS', () => {
  it('registers a loader for the generic and update widget types', () => {
    expect(Object.keys(NOTIFICATION_WIDGET_LOADERS).sort()).toEqual([
      'collaboration-invite',
      'generic',
      'share-bundle',
      'update'
    ]);
    for (const loader of Object.values(NOTIFICATION_WIDGET_LOADERS)) {
      expect(typeof loader).toBe('function');
    }
  });

  it('uses the shared fallback loader for the generic type', () => {
    expect(NOTIFICATION_WIDGET_LOADERS.generic).toBe(
      FALLBACK_NOTIFICATION_WIDGET_LOADER
    );
  });

  it('resolves each loader to its widget component default export', async () => {
    expect(await NOTIFICATION_WIDGET_LOADERS.generic()).toBe('GenericWidget');
    expect(await NOTIFICATION_WIDGET_LOADERS['collaboration-invite']()).toBe(
      'InviteWidget'
    );
    expect(await NOTIFICATION_WIDGET_LOADERS['share-bundle']()).toBe(
      'ShareBundleWidget'
    );
    expect(await NOTIFICATION_WIDGET_LOADERS.update()).toBe('UpdateWidget');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UiSettingsSnapshot } from '$lib/api/ui-settings';

const api = vi.hoisted(() => ({
  initialize: vi.fn(),
  load: vi.fn(),
  patch: vi.fn(),
  listen: vi.fn()
}));
vi.mock('$lib/api/core', () => ({ isTauri: () => true }));
vi.mock('$lib/api/ui-settings', () => ({
  initializeUiSettings: api.initialize,
  loadUiSettings: api.load,
  patchUiSetting: api.patch
}));
vi.mock('$lib/api/events', () => ({
  TauriEventName: { UiSettingsChanged: 'ui-settings-changed' },
  listen: api.listen
}));
vi.mock('./registry.svelte', () => ({
  SETTING_BINDINGS: {
    'appearance.leftSidebarWidth': {
      get: async () => (await import('$lib/state.svelte')).ui.leftSidebarWidth,
      set: async (value: unknown) =>
        (await import('$lib/state.svelte')).setLeftSidebarWidth(Number(value))
    }
  }
}));

const snapshot = (
  values: Record<string, unknown> = {},
  revision = 0
): UiSettingsSnapshot => ({
  deviceRevision: revision,
  vaultRevision: revision,
  values
});

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  localStorage.clear();
  vi.spyOn(window, 'addEventListener').mockImplementation(() => {});
  api.initialize.mockResolvedValue(snapshot());
  api.load.mockResolvedValue(snapshot());
  api.patch.mockResolvedValue(snapshot());
  api.listen.mockResolvedValue(() => {});
});

describe('native settings documents', () => {
  it('shares canonical toolbar preferences, retains browser evidence, and rolls back a failed edit', async () => {
    const toolbar = { toolbar: ['folder'], more: ['note'] };
    const raw = JSON.stringify(toolbar);
    localStorage.setItem('notes-app:file-tree-create-toolbar:v1', raw);
    localStorage.setItem('notes-app:mobile:displayMode', 'grid');
    api.initialize.mockResolvedValue(
      snapshot({
        'ui.fileTreeToolbar': toolbar,
        'ui.mobileDisplayMode': 'grid'
      })
    );
    const store = await import('./store.svelte');
    const device = await import('$lib/native-device-ui.svelte');
    const prefs = await import('$lib/components/file-tree-toolbar-preferences');
    await store.setSettingsVaultId('default');
    expect(api.initialize.mock.calls[0][5]).toEqual({
      toolbarRaw: raw,
      hadExistingData: true,
      displayModeRaw: 'grid'
    });
    expect(prefs.loadFileTreeToolbarPreferences(['note', 'folder'])).toEqual(
      toolbar
    );
    expect(device.nativeDeviceUi.displayMode).toBe('grid');
    api.patch.mockRejectedValueOnce(new Error('disk full'));
    api.load.mockResolvedValue(
      snapshot({
        'ui.fileTreeToolbar': toolbar,
        'ui.mobileDisplayMode': 'grid'
      })
    );
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      prefs.saveFileTreeToolbarPreferences({
        toolbar: ['note'],
        more: ['folder']
      })
    ).rejects.toThrow('disk full');
    expect(prefs.loadFileTreeToolbarPreferences(['note', 'folder'])).toEqual(
      toolbar
    );
    expect(localStorage.getItem('notes-app:file-tree-create-toolbar:v1')).toBe(
      raw
    );
    api.load.mockResolvedValue(
      snapshot(
        {
          'ui.fileTreeToolbar': { toolbar: ['note'], more: ['folder'] },
          'ui.mobileDisplayMode': 'list'
        },
        8
      )
    );
    await store.refreshNativeSettings();
    expect(
      prefs.loadFileTreeToolbarPreferences(['note', 'folder']).toolbar
    ).toEqual(['note']);
    expect(device.nativeDeviceUi.displayMode).toBe('list');
    warning.mockRestore();
  });
  it('initializes even the default vault, loads canonical values, and retains raw migration inputs', async () => {
    const raw = '{"appearance.reduceMotion":"on"}';
    localStorage.setItem('notes-app:settings:v1', raw);
    localStorage.setItem(
      'notes-app:settings:v1:vault:default',
      'corrupt legacy'
    );
    api.initialize.mockResolvedValue(
      snapshot({ 'appearance.reduceMotion': 'off' })
    );
    const store = await import('./store.svelte');
    expect(store.settings.values['appearance.reduceMotion']).toBeUndefined();
    await store.setSettingsVaultId('default');
    expect(api.initialize).toHaveBeenCalledWith(
      'default',
      raw,
      'corrupt legacy',
      null,
      null,
      { toolbarRaw: null, hadExistingData: true, displayModeRaw: null }
    );
    expect(store.getSettingValue('appearance.reduceMotion')).toBe('off');
    await store.setSettingsVaultId('default');
    expect(api.initialize).toHaveBeenCalledTimes(1);
    api.patch.mockResolvedValue(
      snapshot({ 'appearance.reduceMotion': 'on' }, 1)
    );
    await store.setSettingValue('appearance.reduceMotion', 'on');
    expect(api.patch).toHaveBeenCalledWith(
      'default',
      'appearance.reduceMotion',
      'on',
      false
    );
    expect(localStorage.getItem('notes-app:settings:v1')).toBe(raw);
    expect(localStorage.getItem('notes-app:settings:v1:vault:default')).toBe(
      'corrupt legacy'
    );
  });

  it('serializes writes while keeping the latest optimistic value and pending status', async () => {
    const store = await import('./store.svelte');
    await store.setSettingsVaultId('default');
    let finishFirst!: (value: UiSettingsSnapshot) => void;
    api.patch.mockImplementationOnce(
      () =>
        new Promise<UiSettingsSnapshot>((resolve) => {
          finishFirst = resolve;
        })
    );
    api.patch.mockResolvedValueOnce(
      snapshot(
        {
          'appearance.reduceMotion': 'off',
          'account.serverUrl': 'https://worker.example'
        },
        2
      )
    );
    const first = store.setSettingValue('appearance.reduceMotion', 'on');
    await vi.waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    const second = store.setSettingValue('appearance.reduceMotion', 'off');
    await vi.waitFor(() =>
      expect(store.getSettingValue('appearance.reduceMotion')).toBe('off')
    );
    expect(store.isPending('appearance.reduceMotion')).toBe(true);
    finishFirst(snapshot({ 'appearance.reduceMotion': 'on' }, 1));
    await first;
    expect(store.getSettingValue('appearance.reduceMotion')).toBe('off');
    await second;
    expect(store.isPending('appearance.reduceMotion')).toBe(false);
    expect(store.getSettingValue('account.serverUrl')).toBe(
      'https://worker.example'
    );
  });

  it('reports a failed write and restores the latest canonical value', async () => {
    const store = await import('./store.svelte');
    await store.setSettingsVaultId('default');
    const failure = new Error('root busy');
    api.patch.mockRejectedValueOnce(failure);
    api.load.mockResolvedValueOnce(
      snapshot({ 'appearance.reduceMotion': 'off' }, 3)
    );
    await expect(
      store.setSettingValue('appearance.reduceMotion', 'on')
    ).rejects.toBe(failure);
    expect(store.getSettingValue('appearance.reduceMotion')).toBe('off');
    expect(store.isPending('appearance.reduceMotion')).toBe(false);
    api.patch.mockRejectedValueOnce(failure);
    api.load.mockRejectedValueOnce(new Error('unreadable document'));
    await expect(
      store.setSettingValue('appearance.reduceMotion', 'on')
    ).rejects.toBe(failure);
    expect(store.getSettingValue('appearance.reduceMotion')).toBe('off');
  });

  it('blocks writes when migration fails, preserves inputs, and permits an explicit retry', async () => {
    localStorage.setItem('notes-app:settings:v1', 'corrupt');
    const store = await import('./store.svelte');
    api.initialize.mockRejectedValueOnce(
      new Error('malformed migration input')
    );
    await expect(store.setSettingsVaultId('default')).rejects.toThrow(
      'malformed'
    );
    await expect(
      store.setSettingValue('appearance.reduceMotion', 'on')
    ).rejects.toThrow('not initialized');
    expect(api.patch).not.toHaveBeenCalled();
    expect(localStorage.getItem('notes-app:settings:v1')).toBe('corrupt');
    await store.setSettingsVaultId('default');
    await expect(store.setSettingsVaultId('other')).rejects.toThrow(
      'cannot change'
    );
  });

  it('refreshes on focus and popout events, including a recovered older revision', async () => {
    api.initialize.mockResolvedValue(
      snapshot({ 'appearance.reduceMotion': 'on' }, 8)
    );
    const store = await import('./store.svelte');
    await store.setSettingsVaultId('default');
    api.load.mockResolvedValue(
      snapshot({ 'appearance.reduceMotion': 'off' }, 2)
    );
    await store.refreshNativeSettings();
    expect(store.getSettingValue('appearance.reduceMotion')).toBe('off');
    expect(window.addEventListener).toHaveBeenCalledWith(
      'focus',
      expect.any(Function)
    );
    const eventHandler = api.listen.mock.calls[0][1] as () => void;
    api.load.mockResolvedValue(
      snapshot({ 'account.serverUrl': 'https://changed.example' }, 3)
    );
    eventHandler();
    await vi.waitFor(() =>
      expect(store.getSettingValue('account.serverUrl')).toBe(
        'https://changed.example'
      )
    );
  });

  it('hydrates mixed UI preferences and patches only the changed field', async () => {
    localStorage.setItem(
      'notes-app:preferences:v1',
      '{"leftSidebarWidth":360}'
    );
    api.initialize.mockResolvedValue(
      snapshot({
        'appearance.leftSidebarWidth': 320,
        'appearance.sortStrategy': 'modified',
        'ui.leftSidebarOpen': false
      })
    );
    const store = await import('./store.svelte');
    const state = await import('$lib/state.svelte');
    await store.setSettingsVaultId('default');
    expect(api.initialize.mock.calls[0][3]).toBe('{"leftSidebarWidth":360}');
    expect(state.ui.leftSidebarWidth).toBe(320);
    expect(state.ui.leftSidebarOpen).toBe(false);
    expect(state.ui.sortStrategy).toBe('modified');
    api.patch.mockResolvedValue(
      snapshot({
        'appearance.leftSidebarWidth': 330,
        'appearance.sortStrategy': 'modified',
        'ui.leftSidebarOpen': false
      })
    );
    await state.setLeftSidebarWidth(330);
    expect(api.patch).toHaveBeenCalledWith(
      'default',
      'appearance.leftSidebarWidth',
      330,
      false
    );
    expect(localStorage.getItem('notes-app:preferences:v1')).toBe(
      '{"leftSidebarWidth":360}'
    );
    api.load.mockResolvedValue(
      snapshot({
        'appearance.leftSidebarWidth': 300,
        'appearance.sortStrategy': 'created',
        'ui.leftSidebarOpen': true
      })
    );
    await store.refreshNativeSettings();
    expect(state.ui.leftSidebarWidth).toBe(300);
    expect(state.ui.leftSidebarOpen).toBe(true);
    expect(state.ui.sortStrategy).toBe('created');
  });

  it('restores canonical sidebar state and shows feedback after a failed save', async () => {
    const store = await import('./store.svelte');
    const state = await import('$lib/state.svelte');
    const { toasts } = await import('$lib/components/toast.svelte');
    await store.setSettingsVaultId('default');
    api.patch.mockRejectedValueOnce(new Error('root busy'));
    api.load.mockResolvedValueOnce(
      snapshot({ 'appearance.leftSidebarWidth': 310 })
    );
    await expect(state.setLeftSidebarWidth(330)).rejects.toThrow('root busy');
    expect(state.ui.leftSidebarWidth).toBe(310);
    expect(toasts.items.at(-1)?.variant).toBe('error');
  });

  it('owns the native dock layout by vault and leaves its migration bucket unchanged', async () => {
    const saved = {
      version: 1,
      dock: { panels: { a: { title: 'A' } } },
      activeNoteId: 'a',
      savedAt: '2026-10-10T00:00:00.000Z'
    };
    const raw = JSON.stringify(saved);
    localStorage.setItem('notes-app:dock-layout:v1:vault:default', raw);
    api.initialize.mockResolvedValue(snapshot({ 'ui.dockLayout': saved }));
    const store = await import('./store.svelte');
    const layout = await import('$lib/api/layout');
    await store.setSettingsVaultId('default');
    expect(api.initialize.mock.calls[0][4]).toBe(raw);
    expect(layout.loadSavedLayout('default')).toEqual(saved);
    expect(layout.loadSavedLayout('other')).toBeNull();
    api.patch.mockResolvedValue(snapshot({ 'ui.dockLayout': saved }));
    await layout.saveLayout('default', saved.dock, 'a');
    expect(layout.loadSavedLayout('default')).toEqual(saved);
    const loaded = layout.loadSavedLayout('default')!;
    (loaded.dock as typeof saved.dock).panels.a.title = 'local mutation';
    expect(layout.loadSavedLayout('default')).toEqual(saved);
    expect(api.patch).toHaveBeenCalledWith(
      'default',
      'ui.dockLayout',
      expect.objectContaining({ activeNoteId: 'a' }),
      false
    );
    expect(localStorage.getItem('notes-app:dock-layout:v1:vault:default')).toBe(
      raw
    );
    api.patch.mockResolvedValue(snapshot({ 'ui.dockLayout': null }));
    await layout.clearSavedLayout('default');
    expect(layout.loadSavedLayout('default')).toBeNull();
    expect(localStorage.getItem('notes-app:dock-layout:v1:vault:default')).toBe(
      raw
    );
    await expect(layout.saveLayout('other', saved.dock, 'a')).rejects.toThrow(
      'does not match'
    );
  });
});

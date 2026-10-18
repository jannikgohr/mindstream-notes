import { beforeEach, expect, it, vi } from 'vitest';
import type {
  DockviewApi,
  IDockviewGroupPanel,
  IDockviewPanel
} from 'dockview';
import { openNoteWindow } from './window';

const fixture = vi.hoisted(() => ({
  handlers: new Map<string, () => void | Promise<void>>(),
  options: vi.fn(),
  close: vi.fn(),
  decorations: vi.fn(),
  existing: vi.fn()
}));
vi.mock('./core', () => ({ isTauri: () => true }));
vi.mock('./desktop-settings', () => ({
  getCustomWindowDecorations: fixture.decorations
}));
vi.mock('./browser-identity', () => ({
  getWorkerBrowserOptions: async () => ({
    dataDirectory: 'C:/disposable/worker',
    additionalBrowserArgs: '--renderer-process-limit=1'
  })
}));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: class {
    static getByLabel = fixture.existing;
    constructor(label: string, options: unknown) {
      fixture.options(label, options);
    }
    async once(event: string, handler: () => void | Promise<void>) {
      fixture.handlers.set(event, handler);
      return () => fixture.handlers.delete(event);
    }
    close = fixture.close;
  }
}));

beforeEach(() => {
  vi.clearAllMocks();
  fixture.handlers.clear();
  fixture.existing.mockResolvedValue(null);
  fixture.decorations.mockResolvedValue(true);
});

function source() {
  const panel = {
    id: 'note:note_one',
    title: 'Disposable note',
    api: { component: 'editor' },
    params: { noteId: 'note_one' }
  } as unknown as IDockviewPanel;
  const group = { id: 'group_one', activePanel: panel } as IDockviewGroupPanel;
  const dock = {
    getPanel: vi.fn(() => panel),
    getGroup: vi.fn(() => undefined),
    removePanel: vi.fn(),
    addPanel: vi.fn()
  };
  return { panel, group, dock, api: dock as unknown as DockviewApi };
}

it('retains the source through native creation followed by a WebView failure', async () => {
  const { group, dock, api } = source();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  await openNoteWindow('note_one', 'Disposable note', group, api);
  await fixture.handlers.get('tauri://webview-created')?.();
  await fixture.handlers.get('tauri://error')?.();
  await fixture.handlers.get('tauri://close-requested')?.();
  expect(dock.removePanel).not.toHaveBeenCalled();
  expect(dock.addPanel).not.toHaveBeenCalled();
  log.mockRestore();
});

it('detaches after successful creation and restores once even if the group disappeared', async () => {
  const { panel, group, dock, api } = source();
  await openNoteWindow('note_one', 'Disposable note', group, api);
  expect(fixture.options).toHaveBeenCalledWith(
    'note_one',
    expect.objectContaining({
      dataDirectory: 'C:/disposable/worker',
      url: '?window=editor&id=note_one',
      additionalBrowserArgs: '--renderer-process-limit=1'
    })
  );
  await fixture.handlers.get('tauri://created')?.();
  expect(dock.removePanel).toHaveBeenCalledWith(panel);
  dock.getPanel.mockReturnValue(undefined as unknown as IDockviewPanel);
  await fixture.handlers.get('tauri://close-requested')?.();
  expect(dock.addPanel).toHaveBeenCalledWith({
    id: panel.id,
    component: 'editor',
    params: panel.params,
    title: panel.title
  });
  expect(fixture.close).toHaveBeenCalledOnce();
});

it('does not remove a replacement panel if the source changed during creation', async () => {
  const { group, dock, api } = source();
  await openNoteWindow('note_one', 'Disposable note', group, api);
  dock.getPanel.mockReturnValue({ id: 'note:note_one' } as IDockviewPanel);
  await fixture.handlers.get('tauri://created')?.();
  expect(dock.removePanel).not.toHaveBeenCalled();
});

it('gives seeded/imported note IDs the popout capability namespace and explicit editor route', async () => {
  await openNoteWindow('seed_welcome', 'Welcome', null, null);
  expect(fixture.existing).toHaveBeenCalledWith('note_seed_welcome');
  expect(fixture.options).toHaveBeenCalledWith(
    'note_seed_welcome',
    expect.objectContaining({
      url: '?window=editor&id=seed_welcome'
    })
  );
});

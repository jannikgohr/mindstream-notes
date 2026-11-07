import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  native: false,
  mobile: false,
  pick: vi.fn(),
  write: vi.fn(),
  download: vi.fn(),
  save: vi.fn(),
  export: vi.fn(),
  flush: vi.fn(),
  result: vi.fn(),
  alert: vi.fn()
}));
vi.mock('$lib/api', () => ({
  isTauri: () => mocks.native,
  pickExportDir: mocks.pick,
  writeExportFile: mocks.write
}));
vi.mock('$lib/platform', () => ({ isMobile: () => mocks.mobile }));
vi.mock('$lib/stores/tree.svelte', () => ({}));
vi.mock('$lib/components/import-choice-dialog.svelte', () => ({}));
vi.mock('$lib/components/import-notes-dialog.svelte', () => ({}));
vi.mock('$lib/components/confirm-dialog.svelte', () => ({
  alert: mocks.alert
}));
vi.mock('$lib/components/export-result-dialog.svelte', () => ({
  showExportResult: mocks.result
}));
vi.mock('../i18n.svelte', () => ({ tUi: (key: string) => key }));
vi.mock('$lib/editor/suspend-flush', () => ({
  flushPendingEditorSaves: mocks.flush
}));
vi.mock('$lib/notes-export', () => ({
  downloadVaultExport: mocks.download,
  saveVaultExport: mocks.save,
  exportVault: mocks.export
}));
import { DATA_ACTIONS } from './data';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.native = false;
  mocks.mobile = false;
  mocks.pick.mockResolvedValue('/export');
  mocks.save.mockResolvedValue({ errors: 0 });
  mocks.download.mockResolvedValue({ errors: 0 });
  mocks.export.mockImplementation(async (write) => {
    await write('Note.md', new Uint8Array([1]));
    return { errors: 0 };
  });
});

describe('notes export platform routing', () => {
  it('uses the native ZIP save flow on Android', async () => {
    mocks.native = true;
    mocks.mobile = true;
    await DATA_ACTIONS['export-vault']();
    expect(mocks.pick).not.toHaveBeenCalled();
    expect(mocks.flush).toHaveBeenCalledOnce();
    expect(mocks.save).toHaveBeenCalledOnce();
    expect(mocks.result).toHaveBeenCalledWith({ errors: 0 }, null);
  });

  it('keeps desktop folder export', async () => {
    mocks.native = true;
    await DATA_ACTIONS['export-vault']();
    expect(mocks.pick).toHaveBeenCalledOnce();
    expect(mocks.write).toHaveBeenCalledWith(
      '/export',
      'Note.md',
      new Uint8Array([1])
    );
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.result).toHaveBeenCalledWith({ errors: 0 }, '/export');
  });

  it.each([false, true])(
    'downloads a ZIP in web, mobile=%s',
    async (mobile) => {
      mocks.mobile = mobile;
      await DATA_ACTIONS['export-vault']();
      expect(mocks.download).toHaveBeenCalledOnce();
      expect(mocks.pick).not.toHaveBeenCalled();
      expect(mocks.save).not.toHaveBeenCalled();
    }
  );

  it('stays quiet when the Android save picker is cancelled', async () => {
    mocks.native = mocks.mobile = true;
    mocks.save.mockResolvedValue(null);
    await DATA_ACTIONS['export-vault']();
    expect(mocks.result).not.toHaveBeenCalled();
    expect(mocks.alert).not.toHaveBeenCalled();
  });

  it('stays quiet when the desktop folder picker is cancelled', async () => {
    mocks.native = true;
    mocks.pick.mockResolvedValue(null);
    await DATA_ACTIONS['export-vault']();
    expect(mocks.export).not.toHaveBeenCalled();
    expect(mocks.result).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  native: false,
  mobile: false,
  pick: vi.fn(),
  download: vi.fn(),
  save: vi.fn(),
  folder: vi.fn(),
  stream: vi.fn(),
  browserPick: vi.fn(),
  flush: vi.fn(),
  result: vi.fn(),
  alert: vi.fn(),
  confirm: vi.fn(),
  importBegin: vi.fn(),
  importRestore: vi.fn(),
  importCleanup: vi.fn(),
  choice: vi.fn(),
  restoreReady: vi.fn(),
  restart: vi.fn()
}));
vi.mock('$lib/api', () => ({
  isTauri: () => mocks.native,
  pickExportDir: mocks.pick,
  importBegin: mocks.importBegin,
  importRestore: mocks.importRestore,
  importCleanup: mocks.importCleanup
}));
vi.mock('$lib/app-restart', () => ({ restartToApply: mocks.restart }));
vi.mock('$lib/api/file-export', () => ({
  pickBrowserSaveFile: mocks.browserPick
}));
vi.mock('$lib/platform', () => ({ isMobile: () => mocks.mobile }));
vi.mock('$lib/stores/tree.svelte', () => ({}));
vi.mock('$lib/components/import-choice-dialog.svelte', () => ({
  pickImportChoice: mocks.choice
}));
vi.mock('$lib/components/import-notes-dialog.svelte', () => ({}));
vi.mock('$lib/components/confirm-dialog.svelte', () => ({
  alert: mocks.alert,
  confirm: mocks.confirm
}));
vi.mock('$lib/components/export-result-dialog.svelte', () => ({
  showExportResult: mocks.result,
  showRestoreReadyResult: mocks.restoreReady
}));
vi.mock('../i18n.svelte', () => ({ tUi: (key: string) => key }));
vi.mock('$lib/editor/suspend-flush', () => ({
  flushPendingEditorSaves: mocks.flush
}));
vi.mock('$lib/notes-export', () => ({
  downloadVaultExport: mocks.download,
  saveVaultArchive: mocks.save,
  exportVaultToFolder: mocks.folder,
  streamVaultExport: mocks.stream
}));
import { DATA_ACTIONS } from './data';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.native = false;
  mocks.mobile = false;
  mocks.pick.mockResolvedValue('/export');
  mocks.save.mockResolvedValue({ errors: 0 });
  mocks.download.mockResolvedValue({ errors: 0 });
  mocks.folder.mockResolvedValue({ errors: 0 });
  mocks.stream.mockResolvedValue({ errors: 0 });
  mocks.browserPick.mockResolvedValue(undefined);
});

describe('notes export platform routing', () => {
  it('builds and saves a native ZIP on Android', async () => {
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
    expect(mocks.folder).toHaveBeenCalledWith('/export');
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

  it('streams to a picked file in a browser with a save picker', async () => {
    const file = { write: vi.fn(), close: vi.fn(), abort: vi.fn() };
    mocks.browserPick.mockResolvedValue(file);
    await DATA_ACTIONS['export-vault']();
    expect(mocks.browserPick).toHaveBeenCalledOnce();
    // Picked before the editor flush, while the click still counts.
    expect(mocks.browserPick.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.flush.mock.invocationCallOrder[0]
    );
    expect(mocks.stream).toHaveBeenCalledWith(file);
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.result).toHaveBeenCalledWith({ errors: 0 }, null);
  });

  it('discards the picked file when the export fails before streaming', async () => {
    const file = { write: vi.fn(), close: vi.fn(), abort: vi.fn() };
    mocks.browserPick.mockResolvedValue(file);
    mocks.flush.mockRejectedValueOnce(new Error('editor save failed'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await DATA_ACTIONS['export-vault']();
    log.mockRestore();
    expect(file.abort).toHaveBeenCalledOnce();
    expect(mocks.stream).not.toHaveBeenCalled();
    expect(mocks.alert).toHaveBeenCalledOnce();
  });

  it('leaves discarding to the stream once it has the picked file', async () => {
    const file = { write: vi.fn(), close: vi.fn(), abort: vi.fn() };
    mocks.browserPick.mockResolvedValue(file);
    mocks.stream.mockRejectedValueOnce(new Error('disk full'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await DATA_ACTIONS['export-vault']();
    log.mockRestore();
    expect(file.abort).not.toHaveBeenCalled();
    expect(mocks.alert).toHaveBeenCalledOnce();
  });

  it('stays quiet when the browser save picker is cancelled', async () => {
    mocks.browserPick.mockResolvedValue(null);
    await DATA_ACTIONS['export-vault']();
    expect(mocks.flush).not.toHaveBeenCalled();
    expect(mocks.stream).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.result).not.toHaveBeenCalled();
  });

  it('never opens the browser picker in the app', async () => {
    mocks.native = mocks.mobile = true;
    await DATA_ACTIONS['export-vault']();
    expect(mocks.browserPick).not.toHaveBeenCalled();
  });

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
    expect(mocks.folder).not.toHaveBeenCalled();
    expect(mocks.result).not.toHaveBeenCalled();
  });
});

describe('restore restart', () => {
  const preview = { token: 't', same_account: false };

  beforeEach(() => {
    mocks.native = true;
    mocks.importBegin.mockResolvedValue(preview);
    mocks.choice.mockResolvedValue('restore');
    mocks.confirm.mockResolvedValue(true);
    mocks.importRestore.mockResolvedValue({ restart_required: true });
    mocks.restoreReady.mockResolvedValue('restart');
  });

  it('restarts through the platform helper once the backup is staged', async () => {
    mocks.restart.mockResolvedValue(true);
    await DATA_ACTIONS['restore-backup']();
    expect(mocks.restart).toHaveBeenCalledOnce();
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(mocks.importCleanup).not.toHaveBeenCalled();
  });

  it('asks for a manual restart instead of reporting a failed import', async () => {
    mocks.restart.mockResolvedValue(false);
    await DATA_ACTIONS['restore-backup']();
    expect(mocks.alert).toHaveBeenCalledOnce();
    expect(mocks.alert).toHaveBeenCalledWith({
      title: 'data.import.restart.manual.title',
      message: 'data.import.restart.manual.message'
    });
    // The staged restore must survive for the next launch to apply.
    expect(mocks.importCleanup).not.toHaveBeenCalled();
  });

  it('does not restart when the user picks Later', async () => {
    mocks.restoreReady.mockResolvedValue('later');
    await DATA_ACTIONS['restore-backup']();
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(mocks.alert).not.toHaveBeenCalled();
  });
});

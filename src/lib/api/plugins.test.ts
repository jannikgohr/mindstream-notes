import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parsePluginRecord,
  pluginsApprove,
  pluginsArtifactsStatus,
  pluginsDisable,
  pluginsDiscover,
  pluginsDownloadArtifact,
  pluginsEnable,
  pluginsGet,
  pluginsList,
  pluginsNativeServiceStatus,
  pluginsNativeToolStatus,
  pluginsPreviewStart,
  pluginsPreviewStop,
  pluginsPreviewUpdate,
  pluginsReadArtifact,
  pluginsReadFile,
  pluginsRemove,
  pluginsRunNativeTool,
  pluginsRunScript,
  pluginsSetLoadError,
  pluginsStorageDelete,
  pluginsStorageList,
  pluginsStorageReadText,
  pluginsStorageWriteText
} from './plugins';

// The wrappers route through `invokeOrFallback`, which branches on `isTauri()`
// (i.e. `'__TAURI_INTERNALS__' in window`). The happy-dom env has no such key,
// so by default every call takes the browser fallback. The `in Tauri` block
// installs the key and a mocked `@tauri-apps/api/core` invoke to drive the
// real IPC + validation path (where the `parse*` logic lives).

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: unknown) => invoke(command, args)
}));

const RAW = {
  id: 'com.example.plugin',
  version: '1.0.0',
  enabled: true,
  source: 'builtin',
  sourcePath: null,
  acceptedHash: 'abcd1234',
  grantedPermissions: ['templates.contribute', 'notes.create'],
  lastLoadError: null,
  signer: null,
  signatureStatus: 'unsigned',
  installedAt: '2026-07-25T00:00:00Z',
  updatedAt: '2026-07-25T00:00:00Z'
};

describe('parsePluginRecord', () => {
  it('parses a well-formed record', () => {
    const rec = parsePluginRecord(RAW);
    expect(rec.id).toBe('com.example.plugin');
    expect(rec.enabled).toBe(true);
    expect(rec.grantedPermissions).toHaveLength(2);
    expect(rec.sourcePath).toBeNull();
  });

  it('carries optional signer/sourcePath through when present', () => {
    const rec = parsePluginRecord({
      ...RAW,
      source: 'installed',
      sourcePath: '/plugins/example',
      signer: 'deadbeef',
      signatureStatus: 'valid',
      lastLoadError: 'boom'
    });
    expect(rec.sourcePath).toBe('/plugins/example');
    expect(rec.signer).toBe('deadbeef');
    expect(rec.signatureStatus).toBe('valid');
    expect(rec.lastLoadError).toBe('boom');
  });

  it('throws on a missing field', () => {
    const { acceptedHash: _omit, ...missing } = RAW;
    expect(() => parsePluginRecord(missing)).toThrow(/acceptedHash/);
  });

  it('throws when the value is not an object', () => {
    expect(() => parsePluginRecord('nope')).toThrow(/PluginRecord/);
  });
});

describe('no-Tauri fallbacks', () => {
  it('list/discover/get return empty defaults', async () => {
    await expect(pluginsList()).resolves.toEqual([]);
    await expect(pluginsDiscover()).resolves.toEqual([]);
    await expect(pluginsGet('x')).resolves.toBeNull();
    await expect(pluginsArtifactsStatus('x')).resolves.toEqual([]);
    await expect(pluginsStorageList('x')).resolves.toEqual([]);
  });

  it('read helpers return null outside Tauri', async () => {
    await expect(pluginsReadFile('x', 'a.md')).resolves.toBeNull();
    await expect(pluginsStorageReadText('x', 'a.txt')).resolves.toBeNull();
  });

  it('mutating storage calls resolve to undefined outside Tauri', async () => {
    await expect(pluginsSetLoadError('x', null)).resolves.toBeUndefined();
    await expect(pluginsRemove('x')).resolves.toBeUndefined();
    await expect(
      pluginsStorageWriteText('x', 'a.txt', 'body')
    ).resolves.toBeUndefined();
    await expect(pluginsStorageDelete('x', 'a.txt')).resolves.toBeUndefined();
    await expect(pluginsPreviewUpdate('s', 'body')).resolves.toBeUndefined();
    await expect(pluginsPreviewStop('s')).resolves.toBeUndefined();
  });

  it('app-only commands reject outside Tauri', async () => {
    await expect(pluginsEnable('x')).rejects.toThrow(
      /unavailable outside Tauri/
    );
    await expect(pluginsDisable('x')).rejects.toThrow(
      /unavailable outside Tauri/
    );
    await expect(pluginsApprove('x')).rejects.toThrow(
      /unavailable outside Tauri/
    );
    await expect(pluginsDownloadArtifact('x', 'a')).rejects.toThrow(
      /unavailable outside Tauri/
    );
    await expect(pluginsReadArtifact('x', 'a')).rejects.toThrow(
      /unavailable outside Tauri/
    );
    await expect(pluginsNativeToolStatus('x', 't')).rejects.toThrow(
      /unavailable outside Tauri/
    );
    await expect(pluginsRunNativeTool('x', 't', [])).rejects.toThrow(
      /unavailable outside Tauri/
    );
    await expect(pluginsNativeServiceStatus('x', 's')).rejects.toThrow(
      /unavailable outside Tauri/
    );
    await expect(pluginsPreviewStart('x', 's', 'k', 'in')).rejects.toThrow(
      /unavailable outside Tauri/
    );
    await expect(pluginsRunScript('x', 'fn', {})).rejects.toThrow(
      /only available in the app/
    );
  });
});

describe('in Tauri (IPC + validation path)', () => {
  beforeEach(() => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    invoke.mockReset();
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it('discover parses each reconciled view and forwards the raw manifest', async () => {
    invoke.mockResolvedValue([{ record: RAW, manifest: { kind: 'typst' } }]);
    const views = await pluginsDiscover();
    expect(views).toHaveLength(1);
    expect(views[0].record.id).toBe(RAW.id);
    expect(views[0].manifest).toEqual({ kind: 'typst' });
  });

  it('discover throws when the backend returns a non-array', async () => {
    invoke.mockResolvedValue({});
    await expect(pluginsDiscover()).rejects.toThrow(/must be an array/);
  });

  it('list parses records; get passes null through', async () => {
    invoke.mockResolvedValueOnce([RAW]);
    await expect(pluginsList()).resolves.toHaveLength(1);
    invoke.mockResolvedValueOnce(null);
    await expect(pluginsGet('x')).resolves.toBeNull();
    invoke.mockResolvedValueOnce(RAW);
    await expect(pluginsGet('x')).resolves.toMatchObject({ id: RAW.id });
  });

  it('enable/disable/approve forward the id and parse the record', async () => {
    invoke.mockResolvedValue(RAW);
    await expect(pluginsEnable('p')).resolves.toMatchObject({ id: RAW.id });
    expect(invoke).toHaveBeenLastCalledWith('plugins_enable', { id: 'p' });
    await pluginsDisable('p');
    expect(invoke).toHaveBeenLastCalledWith('plugins_disable', { id: 'p' });
    await pluginsApprove('p');
    expect(invoke).toHaveBeenLastCalledWith('plugins_approve', { id: 'p' });
  });

  it('set-load-error rejects when the backend returns a value', async () => {
    invoke.mockResolvedValue(undefined);
    await expect(pluginsSetLoadError('p', 'err')).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith('plugins_set_load_error', {
      id: 'p',
      error: 'err'
    });
    invoke.mockResolvedValue('unexpected');
    await expect(pluginsSetLoadError('p', null)).rejects.toThrow(
      /must not return a value/
    );
  });

  it('read-file returns null or the string body', async () => {
    invoke.mockResolvedValueOnce(null);
    await expect(pluginsReadFile('p', 'a.md')).resolves.toBeNull();
    invoke.mockResolvedValueOnce('# docs');
    await expect(pluginsReadFile('p', 'a.md')).resolves.toBe('# docs');
  });

  it('artifact status parses null and numeric byte counts', async () => {
    invoke.mockResolvedValue([
      {
        pluginId: 'p',
        artifactId: 'a',
        kind: 'binary',
        version: '1',
        fileName: 'tool.exe',
        installed: true,
        bytes: 1024,
        sha256: 'ff'
      },
      {
        pluginId: 'p',
        artifactId: 'b',
        kind: 'binary',
        version: '1',
        fileName: 'other',
        installed: false,
        bytes: null,
        sha256: null
      }
    ]);
    const statuses = await pluginsArtifactsStatus('p');
    expect(statuses[0].bytes).toBe(1024);
    expect(statuses[1].bytes).toBeNull();
    expect(statuses[1].sha256).toBeNull();
  });

  it('download-artifact parses the single returned status', async () => {
    invoke.mockResolvedValue({
      pluginId: 'p',
      artifactId: 'a',
      kind: 'binary',
      version: '1',
      fileName: 'tool',
      installed: true,
      bytes: 8,
      sha256: null
    });
    await expect(pluginsDownloadArtifact('p', 'a')).resolves.toMatchObject({
      installed: true
    });
  });

  it('read-artifact validates the byte array and rejects bad bytes', async () => {
    invoke.mockResolvedValueOnce([0, 127, 255]);
    const bytes = await pluginsReadArtifact('p', 'a');
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes)).toEqual([0, 127, 255]);
    invoke.mockResolvedValueOnce([0, 256]);
    await expect(pluginsReadArtifact('p', 'a')).rejects.toThrow(
      /must be a byte/
    );
    invoke.mockResolvedValueOnce('nope');
    await expect(pluginsReadArtifact('p', 'a')).rejects.toThrow(
      /must be an array/
    );
  });

  it('storage read/write/delete/list round-trip through IPC', async () => {
    invoke.mockResolvedValueOnce('stored');
    await expect(pluginsStorageReadText('p', 'k')).resolves.toBe('stored');
    invoke.mockResolvedValueOnce(undefined);
    await pluginsStorageWriteText('p', 'k', 'v');
    expect(invoke).toHaveBeenLastCalledWith('plugins_storage_write_text', {
      id: 'p',
      path: 'k',
      contents: 'v'
    });
    invoke.mockResolvedValueOnce(undefined);
    await pluginsStorageDelete('p', 'k');
    invoke.mockResolvedValueOnce([
      { path: 'dir', isDir: true, bytes: null },
      { path: 'dir/f', isDir: false, bytes: 3 }
    ]);
    const entries = await pluginsStorageList('p', 'dir');
    expect(entries).toHaveLength(2);
    expect(entries[0].isDir).toBe(true);
    expect(entries[1].bytes).toBe(3);
  });

  it('native tool status + run parse their payloads', async () => {
    invoke.mockResolvedValueOnce({
      pluginId: 'p',
      toolId: 't',
      binaryName: 'typst',
      available: true,
      path: '/usr/bin/typst'
    });
    await expect(pluginsNativeToolStatus('p', 't')).resolves.toMatchObject({
      available: true,
      path: '/usr/bin/typst'
    });
    invoke.mockResolvedValueOnce({
      statusCode: null,
      stdout: 'out',
      stderr: '',
      timedOut: true
    });
    const out = await pluginsRunNativeTool('p', 't', ['--version'], 'in', 500);
    expect(out.statusCode).toBeNull();
    expect(out.timedOut).toBe(true);
    expect(invoke).toHaveBeenLastCalledWith('plugins_run_native_tool', {
      id: 'p',
      toolId: 't',
      args: ['--version'],
      stdin: 'in',
      timeoutMs: 500
    });
  });

  it('run-native-tool defaults optional stdin/timeout to null', async () => {
    invoke.mockResolvedValue({
      statusCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false
    });
    await pluginsRunNativeTool('p', 't', []);
    expect(invoke).toHaveBeenLastCalledWith('plugins_run_native_tool', {
      id: 'p',
      toolId: 't',
      args: [],
      stdin: null,
      timeoutMs: null
    });
  });

  it('native service status + preview start parse handles/urls', async () => {
    invoke.mockResolvedValueOnce({
      serviceId: 's',
      binaryName: 'typst',
      available: false,
      path: null
    });
    await expect(pluginsNativeServiceStatus('p', 's')).resolves.toMatchObject({
      available: false,
      path: null
    });
    invoke.mockResolvedValueOnce({
      sessionKey: 'k',
      dataUrl: 'http://127.0.0.1:1/index.html',
      controlUrl: 'ws://127.0.0.1:1/control',
      proxyUrl: null
    });
    const handle = await pluginsPreviewStart('p', 's', 'k', 'body');
    expect(handle.controlUrl).toContain('ws://');
    expect(handle.proxyUrl).toBeNull();
  });

  it('preview update/stop resolve as void; run-script passes the value through', async () => {
    invoke.mockResolvedValueOnce(undefined);
    await expect(pluginsPreviewUpdate('k', 'body')).resolves.toBeUndefined();
    invoke.mockResolvedValueOnce(undefined);
    await expect(pluginsPreviewStop('k')).resolves.toBeUndefined();
    invoke.mockResolvedValueOnce({ ok: 1 });
    await expect(pluginsRunScript('p', 'fn', { a: 1 })).resolves.toEqual({
      ok: 1
    });
    expect(invoke).toHaveBeenLastCalledWith('plugins_run_script', {
      id: 'p',
      export: 'fn',
      input: { a: 1 }
    });
  });
});

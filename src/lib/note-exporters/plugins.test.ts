import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  loadNote,
  pluginsNativeToolStatus,
  pluginsRunScript,
  saveAnnotatedPdf,
  sanitizePdfFilename
} = vi.hoisted(() => ({
  loadNote: vi.fn(),
  pluginsNativeToolStatus: vi.fn(),
  pluginsRunScript: vi.fn(),
  saveAnnotatedPdf: vi.fn(),
  sanitizePdfFilename: vi.fn((name: string) => name)
}));

vi.mock('$lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/api')>();
  return { ...actual, loadNote };
});
vi.mock('$lib/api/plugins', () => ({
  pluginsNativeToolStatus,
  pluginsRunScript
}));
vi.mock('$lib/api/pdf-export', () => ({ saveAnnotatedPdf }));
vi.mock('$lib/pdf/filename', () => ({ sanitizePdfFilename }));

import {
  pluginNoteExportersForKind,
  registerPlugin,
  resetPluginRegistry
} from '$lib/plugins/registry.svelte';
import { pluginExportersForNote, runPluginNoteExporter } from './plugins';

const typstKind = 'plugin.com.example.typst.document';

function registerTypstExporter() {
  registerPlugin({
    id: 'com.example.typst',
    name: 'Typst',
    version: '1.0.0',
    runtime: 'luau',
    entry: 'main.luau',
    permissions: ['nativeTools.runDeclared'],
    contributes: {
      i18n: { en: { 'notes.document': 'Typst', 'export.pdf': 'PDF' } },
      nativeTools: [
        {
          id: 'typst',
          binaryName: 'typst'
        }
      ],
      noteKinds: [
        {
          id: 'document',
          labelKey: 'notes.document',
          render: { export: 'renderDocument' }
        }
      ],
      noteExporters: [
        {
          id: 'pdf',
          labelKey: 'export.pdf',
          noteKind: typstKind,
          format: 'pdf',
          export: 'exportDocument',
          requiresNativeTool: 'typst'
        }
      ]
    }
  });
  return pluginNoteExportersForKind(typstKind)[0];
}

beforeEach(() => {
  resetPluginRegistry();
  loadNote.mockReset();
  pluginsNativeToolStatus.mockReset();
  pluginsRunScript.mockReset();
  saveAnnotatedPdf.mockReset().mockResolvedValue(true);
  sanitizePdfFilename.mockReset().mockImplementation((name: string) => name);
});

describe('runPluginNoteExporter', () => {
  it('runs the plugin script and saves returned PDF bytes', async () => {
    const ref = registerTypstExporter();
    loadNote.mockResolvedValue({
      id: 'n1',
      title: 'Letter',
      note_kind: typstKind,
      body: '= Hello',
      yrs_state: [],
      payload_schema: 2
    });
    pluginsNativeToolStatus.mockResolvedValue({
      pluginId: 'com.example.typst',
      toolId: 'typst',
      binaryName: 'typst',
      available: true,
      path: 'C:/bin/typst.exe'
    });
    pluginsRunScript.mockResolvedValue({
      preview: { mime: 'application/pdf', dataBase64: 'JVBERg==' }
    });

    await runPluginNoteExporter(ref, 'n1');

    expect(pluginsRunScript).toHaveBeenCalledWith(
      'com.example.typst',
      'exportDocument',
      {
        noteId: 'n1',
        noteKind: typstKind,
        title: 'Letter',
        body: '= Hello',
        format: 'pdf'
      }
    );
    expect(saveAnnotatedPdf).toHaveBeenCalledWith({
      suggestedName: 'Letter.pdf',
      dialogTitle: 'Save PDF',
      bytes: new Uint8Array([37, 80, 68, 70])
    });
  });

  it('fails before running the script when a required native tool is unavailable', async () => {
    const ref = registerTypstExporter();
    loadNote.mockResolvedValue({
      id: 'n1',
      title: 'Letter',
      note_kind: typstKind,
      body: '= Hello',
      yrs_state: [],
      payload_schema: 2
    });
    pluginsNativeToolStatus.mockResolvedValue({
      pluginId: 'com.example.typst',
      toolId: 'typst',
      binaryName: 'typst',
      available: false,
      path: null
    });

    await expect(runPluginNoteExporter(ref, 'n1')).rejects.toThrow(
      /typst.*PATH/i
    );
    expect(pluginsRunScript).not.toHaveBeenCalled();
    expect(saveAnnotatedPdf).not.toHaveBeenCalled();
  });

  function primeAvailable(): ReturnType<typeof registerTypstExporter> {
    const ref = registerTypstExporter();
    loadNote.mockResolvedValue({
      id: 'n1',
      title: 'Letter',
      note_kind: typstKind,
      body: '= Hello',
      yrs_state: [],
      payload_schema: 2
    });
    pluginsNativeToolStatus.mockResolvedValue({
      pluginId: 'com.example.typst',
      toolId: 'typst',
      binaryName: 'typst',
      available: true,
      path: 'C:/bin/typst.exe'
    });
    return ref;
  }

  it('rejects when the note kind does not match the exporter', async () => {
    const ref = registerTypstExporter();
    loadNote.mockResolvedValue({
      id: 'n1',
      title: 'Letter',
      note_kind: 'markdown',
      body: 'x',
      yrs_state: [],
      payload_schema: 2
    });
    await expect(runPluginNoteExporter(ref, 'n1')).rejects.toThrow(
      /exporter is for/i
    );
    expect(pluginsNativeToolStatus).not.toHaveBeenCalled();
  });

  it('rejects when the export result is missing a MIME type', async () => {
    const ref = primeAvailable();
    pluginsRunScript.mockResolvedValue({ file: { dataBase64: 'JVBERg==' } });
    await expect(runPluginNoteExporter(ref, 'n1')).rejects.toThrow(/MIME/);
  });

  it('rejects (plain) when no file bytes and no diagnostics are present', async () => {
    const ref = primeAvailable();
    pluginsRunScript.mockResolvedValue({
      file: { mime: 'application/pdf', dataBase64: '' }
    });
    await expect(runPluginNoteExporter(ref, 'n1')).rejects.toThrow(
      /did not produce file bytes\.$/
    );
  });

  it('surfaces diagnostics when the export produced no bytes', async () => {
    const ref = primeAvailable();
    pluginsRunScript.mockResolvedValue({
      mime: 'application/pdf',
      dataBase64: '',
      diagnostics: [
        { message: 'unexpected token' },
        { message: 'at line 3' },
        { notmessage: 'ignored' }
      ]
    });
    await expect(runPluginNoteExporter(ref, 'n1')).rejects.toThrow(
      /unexpected token\nat line 3/
    );
  });

  it('rejects when the produced file is not a PDF', async () => {
    const ref = primeAvailable();
    pluginsRunScript.mockResolvedValue({
      file: { mime: 'image/png', dataBase64: 'AAAA' }
    });
    await expect(runPluginNoteExporter(ref, 'n1')).rejects.toThrow(
      /expected application\/pdf/
    );
  });

  it('uses a plugin-suggested filename and keeps an existing .pdf extension', async () => {
    const ref = primeAvailable();
    pluginsRunScript.mockResolvedValue({
      file: {
        mime: 'application/pdf',
        dataBase64: 'JVBERg==',
        suggestedName: 'Report.pdf'
      }
    });
    await runPluginNoteExporter(ref, 'n1');
    expect(saveAnnotatedPdf).toHaveBeenCalledWith(
      expect.objectContaining({ suggestedName: 'Report.pdf' })
    );
  });
});

describe('pluginExportersForNote', () => {
  it('returns [] for a nullish note', () => {
    expect(pluginExportersForNote(null)).toEqual([]);
    expect(pluginExportersForNote(undefined)).toEqual([]);
  });

  it('maps registered exporters to runnable NoteExporter entries', async () => {
    registerTypstExporter();
    const exporters = pluginExportersForNote({ note_kind: typstKind });
    expect(exporters).toHaveLength(1);
    expect(exporters[0].id).toBe('plugin.com.example.typst.pdf');
    expect(exporters[0].label).toBe('PDF');
    expect(exporters[0].noteKind).toBe(typstKind);
    expect(typeof exporters[0].run).toBe('function');
  });
});

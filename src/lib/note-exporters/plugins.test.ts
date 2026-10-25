import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { unzipSync } from 'fflate';
const saveFileExport = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock('$lib/api/file-export', () => ({ saveFileExport }));

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
    manifestVersion: 2,
    id: 'com.example.typst',
    name: 'Typst',
    version: '1.0.0',
    runtime: 'wasm',
    entry: 'plugin.wasm',
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
  saveFileExport.mockReset().mockResolvedValue(true);
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

  it.each([null, undefined, [], 'not an object'])(
    'rejects a malformed export result %s before saving',
    async (result) => {
      const ref = primeAvailable();
      pluginsRunScript.mockResolvedValue(result);
      await expect(runPluginNoteExporter(ref, 'n1')).rejects.toThrow(
        'Plugin export result must be an object'
      );
      expect(saveAnnotatedPdf).not.toHaveBeenCalled();
      expect(saveFileExport).not.toHaveBeenCalled();
    }
  );

  it('rejects a non-object file and ignores malformed diagnostics', async () => {
    const ref = primeAvailable();
    pluginsRunScript.mockResolvedValueOnce({ file: [] });
    await expect(runPluginNoteExporter(ref, 'n1')).rejects.toThrow(
      'Plugin export file must be an object'
    );
    pluginsRunScript.mockResolvedValueOnce({
      mime: 'application/pdf',
      diagnostics: [null, 1, 'error', { message: 42 }]
    });
    await expect(runPluginNoteExporter(ref, 'n1')).rejects.toThrow(
      'Plugin export did not produce file bytes.'
    );
    expect(saveAnnotatedPdf).not.toHaveBeenCalled();
  });

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
    loadNote.mockResolvedValue({
      id: 'n1',
      title: 'Letter',
      note_kind: typstKind,
      body: '= Hello'
    });
    pluginsNativeToolStatus.mockResolvedValue({ available: true });
    pluginsRunScript.mockResolvedValue({
      mime: 'application/pdf',
      dataBase64: 'JVBERg=='
    });
    await exporters[0].run('n1');
    expect(saveAnnotatedPdf).toHaveBeenCalledWith(
      expect.objectContaining({
        suggestedName: 'Letter.pdf',
        bytes: new Uint8Array([37, 80, 68, 70])
      })
    );
  });
});

describe('additional plugin formats', () => {
  function imageExporter(format: 'png' | 'svg' = 'png') {
    const ref = registerTypstExporter();
    ref.exporter = { ...ref.exporter, format, requiresNativeTool: undefined };
    loadNote.mockResolvedValue({
      id: 'n1',
      title: 'Pages',
      note_kind: typstKind,
      body: '= Test'
    });
    return ref;
  }

  it('rejects paged results for formats other than PNG and SVG', async () => {
    const ref = imageExporter();
    ref.exporter = { ...ref.exporter, format: 'typ' };
    pluginsRunScript.mockResolvedValue({
      pagesPdf: { mime: 'application/pdf', dataBase64: 'JVBERg==' }
    });
    await expect(runPluginNoteExporter(ref, 'n1')).rejects.toThrow(
      'Paged plugin exports must produce PNG or SVG'
    );
    expect(saveFileExport).not.toHaveBeenCalled();
  });

  it.each([
    { mime: 'image/png', dataBase64: 'AAAA' },
    { mime: 'application/pdf', text: 'no binary preview' }
  ])('requires PDF bytes for a page-count preview', async (pagesPdf) => {
    const ref = imageExporter();
    pluginsRunScript.mockResolvedValue({ pagesPdf });
    await expect(runPluginNoteExporter(ref, 'n1')).rejects.toThrow(
      'Paged export requires a PDF page-count preview'
    );
    expect(saveFileExport).not.toHaveBeenCalled();
  });

  it('rejects more than 1000 pages before rendering or saving any page', async () => {
    const ref = imageExporter();
    const pdf = await PDFDocument.create();
    for (let page = 0; page < 1001; page++) pdf.addPage([10, 10]);
    pluginsRunScript.mockResolvedValue({
      pagesPdf: {
        mime: 'application/pdf',
        dataBase64: await pdf.saveAsBase64()
      }
    });
    await expect(runPluginNoteExporter(ref, 'n1')).rejects.toThrow(
      'up to 1000 pages'
    );
    expect(pluginsRunScript).toHaveBeenCalledOnce();
    expect(saveFileExport).not.toHaveBeenCalled();
  });

  it('saves a single PNG page directly under the note title', async () => {
    const ref = imageExporter();
    const pdf = await PDFDocument.create();
    pdf.addPage();
    pluginsRunScript.mockResolvedValueOnce({
      pagesPdf: {
        mime: 'application/pdf',
        dataBase64: await pdf.saveAsBase64()
      }
    });
    pluginsRunScript.mockResolvedValueOnce({
      file: {
        mime: 'image/png',
        dataBase64: 'iVBORw==',
        suggestedName: 'wrong.png'
      }
    });
    await runPluginNoteExporter(ref, 'n1');
    expect(saveFileExport).toHaveBeenCalledWith(
      expect.objectContaining({
        suggestedName: 'Pages.png',
        bytes: new Uint8Array([137, 80, 78, 71]),
        mime: 'image/png'
      })
    );
    expect(pluginsRunScript.mock.calls[1][2]).toMatchObject({
      page: 1,
      format: 'png',
      noteId: 'n1'
    });
  });
  it('saves even empty Typst source without checking for a compiler', async () => {
    const ref = registerTypstExporter();
    ref.exporter = {
      ...ref.exporter,
      format: 'typ',
      requiresNativeTool: undefined
    };
    loadNote.mockResolvedValue({
      id: 'n1',
      title: 'Empty',
      note_kind: typstKind,
      body: ''
    });
    pluginsRunScript.mockResolvedValue({
      file: { mime: 'text/plain', text: '' }
    });
    await runPluginNoteExporter(ref, 'n1');
    expect(pluginsNativeToolStatus).not.toHaveBeenCalled();
    expect(saveFileExport).toHaveBeenCalledWith(
      expect.objectContaining({
        suggestedName: 'Empty.typ',
        bytes: new Uint8Array(),
        mime: 'text/plain',
        extensions: ['typ']
      })
    );
  });

  it('exports every SVG page and bundles numbered files, even when the script suggests duplicate names', async () => {
    const ref = registerTypstExporter();
    ref.exporter = {
      ...ref.exporter,
      format: 'svg',
      requiresNativeTool: undefined
    };
    loadNote.mockResolvedValue({
      id: 'n1',
      title: 'Pages',
      note_kind: typstKind,
      body: '= Test'
    });
    const pdf = await PDFDocument.create();
    pdf.addPage();
    pdf.addPage();
    const base64 = await pdf.saveAsBase64();
    pluginsRunScript.mockImplementation(async (_id, _export, input) =>
      input.page
        ? {
            file: {
              mime: 'image/svg+xml',
              text: `<svg>Page ${input.page}</svg>`,
              suggestedName: 'same.svg'
            }
          }
        : { pagesPdf: { mime: 'application/pdf', dataBase64: base64 } }
    );
    await runPluginNoteExporter(ref, 'n1');
    const saved = saveFileExport.mock.calls.at(-1)![0];
    expect(saved.suggestedName).toBe('Pages.zip');
    expect(Object.keys(unzipSync(saved.bytes))).toEqual([
      'Pages - 001.svg',
      'Pages - 002.svg'
    ]);
    expect(pluginsRunScript).toHaveBeenCalledTimes(3);
  });
});

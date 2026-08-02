import { afterEach, describe, expect, it } from 'vitest';
import { exportersForNote } from './index';
import type { NoteKind } from '$lib/api';
import {
  registerPlugin,
  resetPluginRegistry
} from '$lib/plugins/registry.svelte';

function note(kind: NoteKind) {
  return { note_kind: kind };
}

afterEach(() => resetPluginRegistry());

describe('note exporters', () => {
  it('offers PDF export for handwritten notes', () => {
    expect(
      exportersForNote(note('ink')).map((exporter) => exporter.id)
    ).toEqual(['ink.pdf']);
  });

  it('keeps annotated PDF export for PDF notes', () => {
    expect(
      exportersForNote(note('pdf')).map((exporter) => exporter.id)
    ).toEqual(['pdf.annotated']);
  });

  it('does not offer exporters for note kinds without direct exports', () => {
    expect(exportersForNote(note('markdown'))).toEqual([]);
    expect(exportersForNote(note('freeform'))).toEqual([]);
  });

  it('adds plugin exporters for existing note types', () => {
    registerPlugin({
      id: 'com.example.markdown-export',
      name: 'Markdown Export',
      version: '1.0.0',
      runtime: 'luau',
      entry: 'main.luau',
      permissions: ['noteExporters.contribute'],
      contributes: {
        i18n: { en: { 'export.pdf': 'PDF' } },
        noteExporters: [
          {
            id: 'pdf',
            labelKey: 'export.pdf',
            noteKind: 'markdown',
            format: 'pdf',
            export: 'exportPdf'
          }
        ]
      }
    });

    expect(
      exportersForNote(note('markdown')).map((exporter) => exporter.id)
    ).toEqual(['plugin.com.example.markdown-export.pdf']);
  });

  it('adds plugin exporters for plugin-owned note types', () => {
    registerPlugin({
      id: 'com.example.typst',
      name: 'Typst',
      version: '1.0.0',
      runtime: 'luau',
      entry: 'main.luau',
      permissions: ['noteKinds.contribute', 'noteExporters.contribute'],
      contributes: {
        i18n: { en: { 'notes.document': 'Typst', 'export.pdf': 'PDF' } },
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
            noteKind: 'plugin.com.example.typst.document',
            format: 'pdf',
            export: 'exportPdf'
          }
        ]
      }
    });

    expect(
      exportersForNote(note('plugin.com.example.typst.document')).map(
        (exporter) => exporter.label
      )
    ).toEqual(['PDF']);
  });
});

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
    ).toEqual(['ink.pdf', 'ink.png']);
  });

  it('offers annotated and print-ready PDF export for PDF notes', () => {
    expect(
      exportersForNote(note('pdf')).map((exporter) => exporter.id)
    ).toEqual([
      'pdf.annotated',
      'pdf.print-ready',
      'pdf.original',
      'pdf.markdown'
    ]);
  });

  it('offers direct exports for Markdown, freeform, and Kanban', () => {
    expect(exportersForNote(note('markdown')).map((entry) => entry.id)).toEqual(
      ['markdown.md', 'markdown.html', 'markdown.pdf', 'markdown.docx']
    );
    expect(exportersForNote(note('freeform')).map((entry) => entry.id)).toEqual(
      ['freeform.excalidraw', 'freeform.png', 'freeform.svg']
    );
    expect(exportersForNote(note('kanban')).map((entry) => entry.id)).toEqual([
      'kanban.csv',
      'kanban.xlsx',
      'kanban.md',
      'kanban.json'
    ]);
  });

  it('adds plugin exporters for existing note types', () => {
    registerPlugin({
      manifestVersion: 2,
      id: 'com.example.markdown-export',
      name: 'Markdown Export',
      version: '1.0.0',
      runtime: 'wasm',
      entry: 'plugin.wasm',
      permissions: [],
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
    ).toEqual([
      'markdown.md',
      'markdown.html',
      'markdown.pdf',
      'markdown.docx',
      'plugin.com.example.markdown-export.pdf'
    ]);
  });

  it('adds plugin exporters for plugin-owned note types', () => {
    registerPlugin({
      manifestVersion: 2,
      id: 'com.example.typst',
      name: 'Typst',
      version: '1.0.0',
      runtime: 'wasm',
      entry: 'plugin.wasm',
      permissions: [],
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

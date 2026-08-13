import { loadNote } from '$lib/api';
import { pluginsNativeToolStatus, pluginsRunScript } from '$lib/api/plugins';
import { base64ToBytes } from '$lib/editor/base64';
import {
  pluginNoteExportersForKind,
  type PluginNoteExporterRef
} from '$lib/plugins/registry.svelte';
import { resolvePluginString } from '$lib/plugins/plugin-i18n';
import { saveAnnotatedPdf } from '$lib/api/pdf-export';
import { sanitizePdfFilename } from '$lib/pdf/filename';
import type { NoteExporter } from './types';

interface PluginExportFile {
  mime: string;
  dataBase64: string;
  suggestedName?: string;
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function diagnosticsMessage(result: Record<string, unknown>): string | null {
  const diagnostics = result.diagnostics;
  if (!Array.isArray(diagnostics)) return null;
  const messages = diagnostics
    .map((diagnostic) =>
      diagnostic && typeof diagnostic === 'object'
        ? (diagnostic as Record<string, unknown>).message
        : null
    )
    .filter((message): message is string => typeof message === 'string');
  return messages.length > 0 ? messages.join('\n') : null;
}

function parseExportFile(result: unknown): PluginExportFile {
  const resultRecord = asRecord(result, 'Plugin export result');
  const payload = resultRecord.file ?? resultRecord.preview ?? resultRecord;
  const file = asRecord(payload, 'Plugin export file');
  if (typeof file.mime !== 'string' || file.mime.trim() === '') {
    throw new Error('Plugin export file is missing a MIME type.');
  }
  if (typeof file.dataBase64 !== 'string' || file.dataBase64.trim() === '') {
    const detail = diagnosticsMessage(resultRecord);
    throw new Error(
      detail
        ? `Plugin export did not produce file bytes:\n${detail}`
        : 'Plugin export did not produce file bytes.'
    );
  }
  const suggestedName =
    typeof file.suggestedName === 'string' && file.suggestedName.trim() !== ''
      ? file.suggestedName.trim()
      : undefined;
  return {
    mime: file.mime,
    dataBase64: file.dataBase64,
    suggestedName
  };
}

function pdfName(name: string): string {
  const sanitized = sanitizePdfFilename(name);
  return sanitized.toLowerCase().endsWith('.pdf')
    ? sanitized
    : `${sanitized}.pdf`;
}

async function ensureNativeToolAvailable(
  ref: PluginNoteExporterRef
): Promise<void> {
  const toolId = ref.exporter.requiresNativeTool;
  if (!toolId) return;
  const status = await pluginsNativeToolStatus(ref.pluginId, toolId);
  if (!status.available) {
    throw new Error(
      `${ref.exporter.format.toUpperCase()} export requires ${status.binaryName}, but it was not found on PATH.`
    );
  }
}

export async function runPluginNoteExporter(
  ref: PluginNoteExporterRef,
  noteId: string
): Promise<void> {
  const note = await loadNote(noteId);
  if (note.note_kind !== ref.exporter.noteKind) {
    throw new Error(
      `This exporter is for ${ref.exporter.noteKind} notes, but this note is ${note.note_kind}.`
    );
  }

  await ensureNativeToolAvailable(ref);
  const result = await pluginsRunScript(ref.pluginId, ref.exporter.export, {
    noteId: note.id,
    noteKind: note.note_kind,
    title: note.title,
    body: note.body,
    format: ref.exporter.format
  });
  const file = parseExportFile(result);

  if (ref.exporter.format !== 'pdf' || file.mime !== 'application/pdf') {
    throw new Error(
      `Plugin exporter returned ${file.mime}; expected application/pdf.`
    );
  }

  await saveAnnotatedPdf({
    suggestedName: pdfName(file.suggestedName ?? note.title),
    dialogTitle: `Save ${resolvePluginString(ref.pluginId, ref.exporter.labelKey)}`,
    bytes: base64ToBytes(file.dataBase64)
  });
}

export function pluginExportersForNote(
  note: { note_kind: string } | null | undefined
): NoteExporter[] {
  if (!note) return [];
  return pluginNoteExportersForKind(note.note_kind).map((ref) => ({
    id: `plugin.${ref.pluginId}.${ref.exporter.id}`,
    noteKind: ref.exporter.noteKind,
    label: resolvePluginString(ref.pluginId, ref.exporter.labelKey),
    run: (noteId) => runPluginNoteExporter(ref, noteId)
  }));
}

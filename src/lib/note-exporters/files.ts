import { saveFileExport } from '$lib/api/file-export';
import { sanitizeName } from '$lib/notes-export/sanitize';

export const EXPORT_FORMATS = {
  pdf: { mime: 'application/pdf', label: 'PDF' },
  md: { mime: 'text/markdown', label: 'Markdown' },
  html: { mime: 'text/html', label: 'HTML' },
  csv: { mime: 'text/csv', label: 'CSV' },
  xlsx: {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    label: 'Excel'
  },
  docx: {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    label: 'Word'
  },
  json: { mime: 'application/json', label: 'JSON' },
  excalidraw: { mime: 'application/json', label: 'Excalidraw' },
  png: { mime: 'image/png', label: 'PNG' },
  svg: { mime: 'image/svg+xml', label: 'SVG' },
  typ: { mime: 'text/plain', label: 'Typst source' },
  zip: { mime: 'application/zip', label: 'ZIP archive' }
} as const;

export type ExportFormat = keyof typeof EXPORT_FORMATS;
export interface ExportFile {
  name: string;
  bytes: Uint8Array;
  format: ExportFormat;
}

export function exportFilename(title: string, format: ExportFormat): string {
  const name = sanitizeName(title);
  return name.toLowerCase().endsWith(`.${format}`) ? name : `${name}.${format}`;
}

export function textFile(
  title: string,
  format: ExportFormat,
  text: string
): ExportFile {
  return {
    name: exportFilename(title, format),
    format,
    bytes: new TextEncoder().encode(text)
  };
}

export async function saveExportFile(
  file: ExportFile,
  dialogTitle?: string
): Promise<boolean> {
  const { mime, label } = EXPORT_FORMATS[file.format];
  return saveFileExport({
    suggestedName: file.name,
    dialogTitle: dialogTitle ?? `Save ${label}`,
    bytes: file.bytes,
    mime,
    filterName: label,
    extensions: [file.format]
  });
}

/** One page saves directly. Multiple pages are bundled into one download. */
export async function bundleExportFiles(
  title: string,
  files: ExportFile[]
): Promise<ExportFile> {
  if (!files.length) throw new Error('The export did not produce any files.');
  if (files.length === 1)
    return { ...files[0], name: exportFilename(title, files[0].format) };
  const { zip } = await import('fflate');
  // Reserve all originals so a duplicate cannot take a later page's name.
  // ZIP keys are exact strings, unlike case-folded filesystem names.
  const reserved = new Set(files.map((file) => file.name));
  const nextSuffix = new Map<string, number>();
  const entries = files.map((file) => {
    let suffix = nextSuffix.get(file.name);
    if (suffix === undefined) {
      nextSuffix.set(file.name, 2);
      return [file.name, file.bytes];
    }
    const dot = file.name.lastIndexOf('.');
    const base = dot > 0 ? file.name.slice(0, dot) : file.name;
    const extension = dot > 0 ? file.name.slice(dot) : '';
    let name: string;
    do {
      name = `${base}_${suffix++}${extension}`;
    } while (reserved.has(name));
    nextSuffix.set(file.name, suffix);
    reserved.add(name);
    return [name, file.bytes];
  });
  const bytes = await new Promise<Uint8Array>((resolve, reject) => {
    zip(Object.fromEntries(entries), { level: 6 }, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
  return { name: exportFilename(title, 'zip'), format: 'zip', bytes };
}

/**
 * Reduce a note title to a string safe to use as the suggested
 * filename in a save dialog: strip Windows-illegal characters, collapse
 * whitespace, cap the length, and fall back to a sensible default
 * when the result would be empty.
 *
 * Note: deliberately keeps spaces and most unicode — the OS save
 * dialog will further sanitise if needed.
 */
export function sanitizePdfFilename(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 120) || 'pdf-note';
}

/**
 * Word counting — TS mirror of src-tauri/src/content_stats.rs.
 *
 * The Rust side is the source of truth (the sidebar reads its word count from
 * the `note_word_count` command, and history deltas are computed there). This
 * mirror exists only for the browser-dev mock store, so dev behaves like the
 * real app. Keep the two in sync.
 */

const WORD_RE = /[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu;

/** Strip markdown noise to plain prose, keeping link labels. */
export function markdownToPlain(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_~|[\](){}:]/g, ' ');
}

export function wordTokens(text: string): string[] {
  return text.match(WORD_RE) ?? [];
}

export function countWords(text: string): number {
  return wordTokens(text).length;
}

/** The three editor surfaces a note can be shown in. Persisted default lives in
 *  the `editor.defaultMode` setting; each open note also keeps a live override. */
export type EditorViewMode = 'wysiwyg' | 'source' | 'split';

const MODES: readonly EditorViewMode[] = ['wysiwyg', 'source', 'split'];

/** Coerce an untrusted value (settings read, persisted state) into a valid mode,
 *  falling back to WYSIWYG. */
export function coerceViewMode(value: unknown): EditorViewMode {
  return MODES.includes(value as EditorViewMode)
    ? (value as EditorViewMode)
    : 'wysiwyg';
}

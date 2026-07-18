/** The three editor surfaces a note can be shown in. Persisted default lives in
 *  the `editor.defaultMode` setting; each open note also keeps a live override. */
export type EditorViewMode = 'wysiwyg' | 'source' | 'split';

const MODES: readonly EditorViewMode[] = ['wysiwyg', 'source', 'split'];

/**
 * Viewport width (px) below which Split isn't offered.
 *
 * Split puts the two panes side by side, so what it needs is WIDTH — at 768
 * each pane still gets a readable ~384px. Below that they're too narrow to
 * work in, so the mode is withheld rather than shipped in a state nobody
 * would want: it disappears from the `editor.defaultMode` options and the
 * mode toggle cycles straight from Source back to WYSIWYG.
 *
 * Width, not `isMobile()`, because width is the actual constraint: a tablet
 * in landscape has room and gets Split; the same tablet in portrait may not.
 * The rule applies to desktop too — a 700px-wide window is just as cramped —
 * so there's one rule rather than one per platform.
 */
export const SPLIT_MIN_WIDTH = 768;

/**
 * Whether Split fits in a viewport this wide. `undefined` (no `window` — SSR
 * / prerender) counts as available: the client re-evaluates on mount, and
 * hiding the option in server-rendered HTML would make it flicker in.
 */
export function splitFitsWidth(width: number | undefined): boolean {
  return width === undefined || width >= SPLIT_MIN_WIDTH;
}

/** The modes on offer right now, in cycle order. */
export function viewModesFor(
  splitAvailable: boolean
): readonly EditorViewMode[] {
  return splitAvailable ? MODES : MODES.filter((m) => m !== 'split');
}

/**
 * Coerce an untrusted value (settings read, persisted state) into a mode that
 * is valid AND currently available, falling back to WYSIWYG.
 *
 * `editor.defaultMode` is vault-scoped, so it syncs across devices: a user who
 * picks Split on their desktop carries that value to their phone. Coercing it
 * HERE — at the point of use — is what lets the phone open the note in WYSIWYG
 * without writing back and clobbering the desktop preference.
 */
export function coerceViewMode(
  value: unknown,
  splitAvailable = true
): EditorViewMode {
  const mode = MODES.includes(value as EditorViewMode)
    ? (value as EditorViewMode)
    : 'wysiwyg';
  return mode === 'split' && !splitAvailable ? 'wysiwyg' : mode;
}

/** The next mode in the cycle, skipping Split when it isn't available. */
export function nextViewMode(
  current: EditorViewMode,
  splitAvailable: boolean
): EditorViewMode {
  const modes = viewModesFor(splitAvailable);
  // A current mode that's no longer on offer (the viewport shrank out from
  // under an open Split pane) resumes the cycle from the start.
  const i = modes.indexOf(current);
  return modes[(i + 1) % modes.length];
}

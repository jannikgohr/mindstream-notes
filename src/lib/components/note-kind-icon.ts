/**
 * Central note-kind → Lucide icon mapping.
 *
 * Every place that renders a per-note icon (file tree, search results,
 * mobile note list, wikilink picker, …) goes through `noteKindIcon()` so
 * a new editor variant — or a fix to one of the existing glyphs — only
 * has to land here. Adding a new editor kind means: extend `NoteKind` in
 * `$lib/api/notes`, then add a case below.
 *
 * Fallbacks:
 *   - `null` / `undefined` → markdown's FileText. Matches the Rust
 *     `default_note_kind` for legacy rows that pre-date the column.
 *   - String that isn't in `KNOWN_NOTE_KINDS` (typically a future kind
 *     synced down from a newer app version) → FileQuestion. The dispatch
 *     sites already render an "unknown kind" error component; the icon
 *     hint here makes that future-kind row visually distinguishable
 *     from a plain markdown note in the tree / search list.
 *
 * Lucide 0.469.x (the version pinned in this app) ships the icon as
 * `FileQuestion`. Upstream Lucide renamed it to `file-question-mark` in
 * a later release; when we bump the dep, this file is the single import
 * to update.
 */

import type { Component } from 'svelte';
import {
  Feather,
  FileQuestion,
  FileText,
  FileType2,
  PencilRuler,
  SquareKanban
} from '@lucide/svelte';
import { isKnownNoteKind } from '$lib/api/notes';
import type { IconComponent } from '$lib/settings/icons';

// Lucide's exported components are widened to `Component<any>` for the
// same reason `SETTINGS_ICONS` does it — see the comment there. We only
// pass `class` through, no event handlers, so the cast is sound.
const FILE_TEXT = FileText as unknown as IconComponent;
const PENCIL_RULER = PencilRuler as unknown as IconComponent;
const FEATHER = Feather as unknown as IconComponent;
const FILE_TYPE_2 = FileType2 as unknown as IconComponent;
const SQUARE_KANBAN = SquareKanban as unknown as IconComponent;
const FILE_QUESTION = FileQuestion as unknown as IconComponent;

/**
 * Resolve the right Lucide component for a note's `note_kind`.
 *
 * Returns a Svelte 5 `Component` so callers render it with the
 * `<Icon class="..." />` pattern (component-as-value, not a snippet).
 */
export function noteKindIcon(kind: string | null | undefined): IconComponent {
  if (kind == null) return FILE_TEXT;
  if (!isKnownNoteKind(kind)) return FILE_QUESTION;
  switch (kind) {
    case 'markdown':
      return FILE_TEXT;
    case 'freeform':
      return PENCIL_RULER;
    case 'ink':
      return FEATHER;
    case 'pdf':
      return FILE_TYPE_2;
    case 'kanban':
      return SQUARE_KANBAN;
    default:
      return FILE_QUESTION;
  }
}

/**
 * Re-export of `Component` so callers don't have to dance between the
 * Svelte type module and this one when typing a `let Icon =
 * noteKindIcon(...)` variable.
 */
export type { Component };

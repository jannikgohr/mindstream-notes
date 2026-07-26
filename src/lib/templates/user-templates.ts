/**
 * User-authored templates: ordinary notes the user designates as templates,
 * with none of the app's premade ones required.
 *
 * Two opt-in sources, both configured by the **Templates plugin**
 * (Settings → Plugins → Templates → Template sources), using the reusable
 * `folder` and `tag` setting primitives:
 *   - a **folder** (`source-folder`, a folder id): every markdown note inside
 *     that folder (at any depth) is a template;
 *   - a **tag** (`source-tag`): every markdown note carrying that tag is a
 *     template.
 *
 * Because they are folder/tag pickers, both auto-clear when their target is
 * deleted (settings/pickers.svelte.ts). Creating a note from a user template
 * copies the source note's body (and title) through the same `{{…}}`
 * interpolation the plugin templates use — so a user template can contain
 * `{{date}}`, `{{uuid}}`, `{{date+7d:YYYY-MM-DD}}`, etc. The app performs the
 * note write, exactly as for plugin templates.
 */

import { loadNote } from '$lib/api/notes';
import { createNoteIn, tree } from '$lib/stores/tree.svelte';
import { requestOpenNote } from '$lib/stores/open-note-intent.svelte';
import { getSettingValue } from '$lib/settings/store.svelte';
import {
  renderTemplateString,
  shouldOpenOnCreate
} from '$lib/plugins/templates';

/** The Templates plugin owns the source-folder / source-tag settings. */
export const TEMPLATES_PLUGIN_ID = 'com.mindstream.templates.core';
const SOURCE_FOLDER_KEY = `plugins.${TEMPLATES_PLUGIN_ID}.source-folder`;
const SOURCE_TAG_KEY = `plugins.${TEMPLATES_PLUGIN_ID}.source-tag`;

/** A create-menu entry for one user template (a note acting as a template). */
export interface UserTemplateEntry {
  noteId: string;
  label: string;
  /** Which rule surfaced it (a note can match both; tag wins for labelling). */
  source: 'folder' | 'tag';
}

function trimmedSetting(key: string): string {
  const value = getSettingValue(key);
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * True when `collectionId` is `folderId` or has it as an ancestor. Walks the
 * parent chain via the tree's collection map, guarding against cycles.
 */
function isInFolder(collectionId: string | null, folderId: string): boolean {
  const seen = new Set<string>();
  let current = collectionId;
  while (current && !seen.has(current)) {
    if (current === folderId) return true;
    seen.add(current);
    const folder = tree.collectionsById[current];
    if (!folder) return false;
    current = folder.parent_collection_id;
  }
  return false;
}

/**
 * Every markdown note that qualifies as a user template under the current
 * settings, sorted by title. Empty when neither source is configured. Reads the
 * reactive tree + settings, so it re-derives when notes, tags, or the settings
 * change.
 */
export function userTemplateEntries(): UserTemplateEntry[] {
  const folderId = trimmedSetting(SOURCE_FOLDER_KEY);
  const tag = trimmedSetting(SOURCE_TAG_KEY);
  if (!folderId && !tag) return [];

  const entries: UserTemplateEntry[] = [];
  for (const note of Object.values(tree.notesById)) {
    if (note.trashed || note.note_kind !== 'markdown') continue;
    let source: 'folder' | 'tag' | null = null;
    if (tag && note.tags.includes(tag)) source = 'tag';
    else if (folderId && isInFolder(note.parent_collection_id, folderId)) {
      source = 'folder';
    }
    if (!source) continue;
    entries.push({
      noteId: note.id,
      label: note.title.trim() || 'Untitled',
      source
    });
  }
  entries.sort((a, b) => a.label.localeCompare(b.label));
  return entries;
}

/** True when at least one user template is currently configured + present. */
export function hasUserTemplates(): boolean {
  return userTemplateEntries().length > 0;
}

/**
 * Create a new markdown note from a user template note and open it. The source
 * note's title + body are interpolated (`{{date}}`, `{{title}}`, …) and the new
 * note is created via the app's own `createNoteIn`. Returns the new note id.
 */
export async function createNoteFromUserTemplate(
  templateNoteId: string,
  parentId: string | null,
  now: Date = new Date()
): Promise<string> {
  const summary = tree.notesById[templateNoteId];
  const rawTitle = summary?.title ?? 'Untitled';
  const full = await loadNote(templateNoteId);

  const title = renderTemplateString(rawTitle, {}, now).trim() || rawTitle;
  const body = renderTemplateString(full.body ?? '', { title }, now);

  const id = await createNoteIn(parentId, title, 'markdown', body);
  if (shouldOpenOnCreate(TEMPLATES_PLUGIN_ID)) requestOpenNote(id);
  return id;
}

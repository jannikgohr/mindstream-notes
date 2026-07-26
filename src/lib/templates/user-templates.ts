/**
 * User-authored templates: ordinary notes the user designates as templates,
 * with none of the app's premade ones required.
 *
 * Two opt-in sources, both configured in Settings → General → Templates:
 *   - a **folder name** (`templates.sourceFolder`): every markdown note inside a
 *     folder with that name (at any depth) is a template;
 *   - a **tag** (`templates.sourceTag`): every markdown note carrying that tag is
 *     a template.
 *
 * Creating a note from a user template copies the source note's body (and title)
 * through the same `{{…}}` interpolation the plugin templates use — so a user
 * template can contain `{{date}}`, `{{uuid}}`, `{{date+7d:YYYY-MM-DD}}`, etc.
 * The app performs the note write, exactly as for plugin templates.
 *
 * The premade templates are the Core Templates *plugin*; they're hidden from the
 * create menus by turning off `templates.showBuiltIn` (see [`showBuiltInTemplates`]),
 * or removed entirely by disabling that plugin in Plugin settings.
 */

import { loadNote } from '$lib/api/notes';
import { createNoteIn, tree } from '$lib/stores/tree.svelte';
import { requestOpenNote } from '$lib/stores/open-note-intent.svelte';
import { getSettingValue } from '$lib/settings/store.svelte';
import { renderTemplateString } from '$lib/plugins/templates';

/** Setting keys (mirrored in settings/schema.json). */
export const TEMPLATE_SHOW_BUILTIN = 'templates.showBuiltIn';
export const TEMPLATE_SOURCE_FOLDER = 'templates.sourceFolder';
export const TEMPLATE_SOURCE_TAG = 'templates.sourceTag';

/** A create-menu entry for one user template (a note acting as a template). */
export interface UserTemplateEntry {
  noteId: string;
  label: string;
  /** Which rule surfaced it (a note can match both; tag wins for labelling). */
  source: 'folder' | 'tag';
}

/** Whether the app's premade (plugin) templates should appear in create menus. */
export function showBuiltInTemplates(): boolean {
  return getSettingValue(TEMPLATE_SHOW_BUILTIN) !== false;
}

function trimmedSetting(key: string): string {
  const value = getSettingValue(key);
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * True when `collectionId` or any ancestor folder is named `name`. Walks the
 * parent chain via the tree's collection map, guarding against cycles.
 */
function hasAncestorFolderNamed(
  collectionId: string | null,
  name: string
): boolean {
  const seen = new Set<string>();
  let current = collectionId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const folder = tree.collectionsById[current];
    if (!folder) return false;
    if (folder.name === name) return true;
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
  const folderName = trimmedSetting(TEMPLATE_SOURCE_FOLDER);
  const tag = trimmedSetting(TEMPLATE_SOURCE_TAG);
  if (!folderName && !tag) return [];

  const entries: UserTemplateEntry[] = [];
  for (const note of Object.values(tree.notesById)) {
    if (note.trashed || note.note_kind !== 'markdown') continue;
    let source: 'folder' | 'tag' | null = null;
    if (tag && note.tags.includes(tag)) source = 'tag';
    else if (
      folderName &&
      hasAncestorFolderNamed(note.parent_collection_id, folderName)
    ) {
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
  requestOpenNote(id);
  return id;
}

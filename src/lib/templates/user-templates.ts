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
 * copies the source note's body (and title) with `{{…}}` placeholders
 * (`{{date}}`, `{{uuid}}`, `{{date+7d:YYYY-MM-DD}}`, …) interpolated by the
 * **Templates plugin's Luau** (`renderTemplate`) — the plugin owns the macro
 * engine; the app only performs the note write. Rendering therefore needs the
 * backend, so user templates are offered only in the app, not the web build.
 */

import { loadNote } from '$lib/api/notes';
import { isTauri } from '$lib/api/core';
import { pluginsRunScript } from '$lib/api/plugins';
import { createNoteIn, tree } from '$lib/stores/tree.svelte';
import { requestOpenNote } from '$lib/stores/open-note-intent.svelte';
import { getSettingValue } from '$lib/settings/store.svelte';
import { i18n } from '$lib/settings/i18n.svelte';
import { shouldOpenOnCreate } from '$lib/plugins/templates';

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
  // Rendering a user template runs the Templates plugin's Luau, which only
  // executes in the app's backend — so there are no user templates to offer in a
  // backend-less (web/preview) build.
  if (!isTauri()) return [];

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
 * Render a user template note's title + body into their final form, without
 * creating anything. The `{{…}}` interpolation is done by the **Templates
 * plugin's Luau** (`renderTemplate` export) — the plugin owns the macro engine;
 * the app only feeds it the raw note and performs the resulting write. The title
 * is rendered first so the body can reference the final `{{title}}` (handled
 * inside the plugin). Backend-only: `pluginsRunScript` rejects without the app.
 */
async function renderUserTemplate(
  templateNoteId: string,
  now: Date
): Promise<{ title: string; body: string }> {
  const summary = tree.notesById[templateNoteId];
  const rawTitle = summary?.title ?? 'Untitled';
  const full = await loadNote(templateNoteId);

  const rendered = (await pluginsRunScript(
    TEMPLATES_PLUGIN_ID,
    'renderTemplate',
    {
      title: rawTitle,
      body: full.body ?? '',
      now: now.toISOString(),
      locale: i18n.language
    }
  )) as { title?: unknown; body?: unknown } | null;

  const renderedTitle =
    typeof rendered?.title === 'string' ? rendered.title.trim() : '';
  const body = typeof rendered?.body === 'string' ? rendered.body : '';
  return { title: renderedTitle || rawTitle, body };
}

/**
 * The rendered body of a user template, for inserting into an existing note
 * (the command palette's "Insert into note" action). Only the body is
 * returned — insertion drops content at the caret and never touches the host
 * note's title.
 */
export async function renderUserTemplateBody(
  templateNoteId: string,
  now: Date = new Date()
): Promise<string> {
  return (await renderUserTemplate(templateNoteId, now)).body;
}

/**
 * Create a new markdown note by copying a source note — its title + body are
 * interpolated (`{{date}}`, `{{title}}`, …) and written via the app's own
 * `createNoteIn`. The mechanical half of "create from template": the *policy*
 * (which note, whether to open) is the caller's. Backs the `createNoteFromNote`
 * plugin effect and `createNoteFromUserTemplate`. Returns the new note id.
 */
export async function createNoteFromNote(
  sourceNoteId: string,
  parentId: string | null,
  opts: { open?: boolean } = {},
  now: Date = new Date()
): Promise<string> {
  const { title, body } = await renderUserTemplate(sourceNoteId, now);
  const id = await createNoteIn(parentId, title, 'markdown', body);
  if (opts.open ?? true) requestOpenNote(id);
  return id;
}

/**
 * Create a new markdown note from a user template note and open it (honouring
 * the Templates plugin's `open-on-create` setting). Thin policy wrapper over
 * {@link createNoteFromNote}.
 */
export async function createNoteFromUserTemplate(
  templateNoteId: string,
  parentId: string | null,
  now: Date = new Date()
): Promise<string> {
  return createNoteFromNote(
    templateNoteId,
    parentId,
    { open: shouldOpenOnCreate(TEMPLATES_PLUGIN_ID) },
    now
  );
}

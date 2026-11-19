/**
 * The host half of the `openOrCreateNote` effect. A plugin answers from a
 * snapshot taken when its call started, so it cannot tell whether a note it
 * asked for a moment ago exists yet. The host looks in its live tree instead,
 * and runs one creation at a time per folder and title.
 */

import type { NoteKind } from '$lib/api';
import { noteIsUnderTrash } from '$lib/stores/note-source.svelte';
import { requestOpenNote } from '$lib/stores/open-note-intent.svelte';
import { createNoteIn, tree } from '$lib/stores/tree.svelte';
import {
  renderUserTemplateBody,
  TEMPLATES_PLUGIN_ID
} from '$lib/templates/user-templates';
import { pluginById } from './registry.svelte';

export interface OpenOrCreateRequest {
  title: string;
  parentId: string | null;
  template?: { sourceNoteId: string; date?: string };
}

const creating = new Map<string, Promise<string>>();

function findNote(parentId: string | null, title: string): string | undefined {
  return Object.values(tree.notesById).find(
    (note) =>
      note.parent_collection_id === parentId &&
      note.title === title &&
      !noteIsUnderTrash(note, tree.collectionsById)
  )?.id;
}

/** Open the note, creating it first when it doesn't exist. Returns its id. */
export async function openOrCreateNote(
  request: OpenOrCreateRequest
): Promise<string> {
  const { title, parentId } = request;
  let id = findNote(parentId, title);
  if (!id) {
    const key = JSON.stringify([parentId, title]);
    let pending = creating.get(key);
    if (!pending) {
      pending = createNote(request).finally(() => creating.delete(key));
      creating.set(key, pending);
    }
    id = await pending;
  }
  requestOpenNote(id);
  return id;
}

async function createNote({
  title,
  parentId,
  template
}: OpenOrCreateRequest): Promise<string> {
  const source = template ? tree.notesById[template.sourceNoteId] : undefined;
  // Templates renders the template; with it disabled the note starts blank.
  const renders = pluginById(TEMPLATES_PLUGIN_ID)?.enabled === true;
  if (
    !template ||
    !source ||
    !renders ||
    noteIsUnderTrash(source, tree.collectionsById)
  ) {
    return createNoteIn(parentId, title, 'markdown');
  }
  const body = await renderUserTemplateBody(
    source.id,
    templateAnchor(template.date),
    title
  );
  return createNoteIn(parentId, title, source.note_kind as NoteKind, body);
}

/** `YYYY-MM-DD` at the current time of day, so `{{time}}` still reads as now. */
function templateAnchor(date: string | undefined): Date {
  const now = new Date();
  const match = date ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null;
  if (!match) return now;
  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    now.getHours(),
    now.getMinutes(),
    now.getSeconds()
  );
}

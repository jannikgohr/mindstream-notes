import {
  listNoteLinks,
  loadNote,
  type Note,
  type NoteLinks,
  type NoteSummary
} from '$lib/api';
import { parseNoteHref } from '$lib/editor/plugins/wikilink-href';

export interface NoteRelations {
  outgoing: string[];
  backlinks: string[];
}

type NoteLoader = (id: string) => Promise<Pick<Note, 'body'>>;
type LinkLister = () => Promise<NoteLinks[]>;

// Past this many notes to read, one read of every note's links is cheaper
// than loading each body.
const BULK_READ_AFTER = 20;
let pendingBulkLoad: Promise<void> | null = null;

const linkCache = new Map<string, { modified: string; targetIds: string[] }>();
const pendingLinkLoads = new Map<string, Promise<string[]>>();

/** Extract stable internal note IDs from serialized Markdown links. */
export function noteLinkIds(markdown: string): string[] {
  const ids = new Set<string>();
  for (const match of markdown.matchAll(
    /\]\((mindstream:\/\/note\/[^\s)]+)\)/g
  )) {
    const id = parseNoteHref(match[1]);
    if (id) ids.add(id);
  }
  return [...ids];
}

function canContainNoteLinks(kind: string): boolean {
  return kind === 'markdown';
}

async function linksForNote(
  summary: NoteSummary,
  loader: NoteLoader
): Promise<string[]> {
  const cached = linkCache.get(summary.id);
  if (cached?.modified === summary.modified) return cached.targetIds;
  const pendingKey = `${summary.id}:${summary.modified}`;
  const pending = pendingLinkLoads.get(pendingKey);
  if (pending) return pending;
  const load = loader(summary.id)
    .then((note) => {
      const targetIds = noteLinkIds(note.body ?? '');
      linkCache.set(summary.id, { modified: summary.modified, targetIds });
      return targetIds;
    })
    .catch(() => [])
    .finally(() => pendingLinkLoads.delete(pendingKey));
  pendingLinkLoads.set(pendingKey, load);
  return load;
}

function bulkLoad(lister: LinkLister): Promise<void> {
  pendingBulkLoad ??= lister()
    .then((all) => {
      for (const { id, modified, targets } of all)
        linkCache.set(id, { modified, targetIds: targets });
    })
    .catch((error) => console.warn('[links] bulk read failed', error))
    .finally(() => (pendingBulkLoad = null));
  return pendingBulkLoad;
}

/** Every live note's links to other live notes, by source note ID. */
export async function loadNoteLinks(
  summaries: NoteSummary[],
  loader: NoteLoader = loadNote,
  lister: LinkLister = listNoteLinks
): Promise<Map<string, string[]>> {
  const liveNotes = summaries.filter((note) => !note.trashed);
  const knownIds = new Set(liveNotes.map((note) => note.id));
  const candidates = liveNotes.filter((note) =>
    canContainNoteLinks(note.note_kind)
  );
  const stale = (note: NoteSummary) =>
    linkCache.get(note.id)?.modified !== note.modified;
  if (candidates.filter(stale).length > BULK_READ_AFTER) await bulkLoad(lister);
  // Whatever the bulk read missed, or changed since, loads one by one.
  await Promise.all(
    candidates.filter(stale).map((note) => linksForNote(note, loader))
  );
  return new Map(
    candidates.map((note) => [
      note.id,
      (linkCache.get(note.id)?.targetIds ?? []).filter((id) => knownIds.has(id))
    ])
  );
}

/** Build outgoing links and backlinks for one note from the current vault. */
export async function loadNoteRelations(
  noteId: string,
  summaries: NoteSummary[],
  loader: NoteLoader = loadNote
): Promise<NoteRelations> {
  const links = await loadNoteLinks(summaries, loader);
  return {
    outgoing: links.get(noteId) ?? [],
    backlinks: [...links]
      .filter(
        ([sourceId, targetIds]) =>
          sourceId !== noteId && targetIds.includes(noteId)
      )
      .map(([sourceId]) => sourceId)
  };
}

export function clearNoteRelationsCache(): void {
  linkCache.clear();
  pendingBulkLoad = null;
  pendingLinkLoads.clear();
}

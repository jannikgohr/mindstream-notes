import { loadNote, type Note, type NoteSummary } from '$lib/api';
import { parseNoteHref } from '$lib/editor/plugins/wikilink-href';

export interface NoteRelations {
  outgoing: string[];
  backlinks: string[];
}

type NoteLoader = (id: string) => Promise<Pick<Note, 'body'>>;

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
  return kind !== 'pdf' && kind !== 'freeform' && kind !== 'ink';
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

/** Build outgoing links and backlinks for one note from the current vault. */
export async function loadNoteRelations(
  noteId: string,
  summaries: NoteSummary[],
  loader: NoteLoader = loadNote
): Promise<NoteRelations> {
  const liveNotes = summaries.filter((note) => !note.trashed);
  const candidates = liveNotes.filter((note) =>
    canContainNoteLinks(note.note_kind)
  );
  const knownIds = new Set(liveNotes.map((note) => note.id));
  const links = await Promise.all(
    candidates.map(
      async (note) => [note.id, await linksForNote(note, loader)] as const
    )
  );
  const bySource = new Map(links);

  return {
    outgoing: (bySource.get(noteId) ?? []).filter((id) => knownIds.has(id)),
    backlinks: links
      .filter(
        ([sourceId, targetIds]) =>
          sourceId !== noteId && targetIds.includes(noteId)
      )
      .map(([sourceId]) => sourceId)
  };
}

export function clearNoteRelationsCache(): void {
  linkCache.clear();
  pendingLinkLoads.clear();
}

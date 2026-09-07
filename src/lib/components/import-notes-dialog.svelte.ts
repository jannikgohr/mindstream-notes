/**
 * Queue + imperative API for the "Import notes" dialog, plus the pure helpers
 * it renders from.
 *
 * Mirrors `import-choice-dialog.svelte.ts`: the store lives in a standalone
 * `.svelte.ts` so non-component callers (the Data settings actions) can
 * `await openImportDialog()` without pulling bits-ui into their static graph.
 * The folder-list and default-destination logic lives here too, because that
 * is the part worth testing without mounting anything.
 */

import type { Collection, ImportReport, ImportSourceKind } from '$lib/api';
import { TRASH_ID } from '$lib/api';

export interface PendingImport {
  /** Resolves with the report, or `null` if the user backed out. */
  resolve: (report: ImportReport | null) => void;
}

export const importNotesQueue = $state<{ items: PendingImport[] }>({
  items: []
});

/**
 * Open the import dialog and wait for it to finish.
 *
 * Resolves with the report when a run completes — including a cancelled run,
 * which still reports what it managed to write — and with `null` when the user
 * closes the dialog without importing anything.
 */
export function openImportDialog(): Promise<ImportReport | null> {
  return new Promise((resolve) => {
    importNotesQueue.items = [...importNotesQueue.items, { resolve }];
  });
}

/** A folder the user can import into, ready to render in a flat list. */
export interface FolderOption {
  /** `null` is the vault root. */
  id: string | null;
  name: string;
  /** Nesting level, for indenting the label. */
  depth: number;
}

/**
 * Flatten the collection tree into a list suitable for a `<select>`.
 *
 * Trash is excluded along with everything under it: importing into the trash
 * would file a fresh vault as already-deleted.
 */
export function folderOptions(
  collectionsById: Record<string, Collection>
): FolderOption[] {
  const childrenOf = new Map<string | null, Collection[]>();
  for (const collection of Object.values(collectionsById)) {
    if (collection.id === TRASH_ID) continue;
    const parent = collection.parent_collection_id ?? null;
    if (parent === TRASH_ID) continue;
    const bucket = childrenOf.get(parent) ?? [];
    bucket.push(collection);
    childrenOf.set(parent, bucket);
  }

  const out: FolderOption[] = [];
  const visit = (parent: string | null, depth: number) => {
    const children = [...(childrenOf.get(parent) ?? [])].sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    for (const child of children) {
      out.push({ id: child.id, name: child.name, depth });
      visit(child.id, depth + 1);
    }
  };
  visit(null, 0);
  return out;
}

/**
 * Turn the source's suggested name into one that doesn't already exist at the
 * destination.
 *
 * Repeated imports of the same vault are normal — re-running the big-vault
 * performance test, or retrying after a cancel — and silently merging the
 * second run into the first folder would make the result impossible to read.
 */
export function uniqueFolderName(
  suggested: string,
  collectionsById: Record<string, Collection>,
  destination: string | null
): string {
  const base = suggested.trim() || 'Imported notes';
  const taken = new Set(
    Object.values(collectionsById)
      .filter((c) => (c.parent_collection_id ?? null) === destination)
      .map((c) => c.name.toLowerCase())
  );
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${Date.now()}`;
}

/**
 * i18n key for a format's display name. Kept beside the type so adding a
 * format is one arm here and one entry in each bundle.
 */
export function sourceKindLabelKey(kind: ImportSourceKind): string {
  return `data.importNotes.kind.${kind}`;
}

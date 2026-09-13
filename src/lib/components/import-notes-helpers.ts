/**
 * Pure helpers behind the "Import notes" dialog: the destination folder list
 * and the default name for the new folder an import lands in.
 *
 * Kept out of `import-notes-dialog.svelte.ts` so they stay plain functions
 * over plain data — nothing here needs reactivity, and it is the part of the
 * dialog worth testing without mounting anything.
 */

import type { Collection, ImportSourceKind } from '$lib/api';
import { TRASH_ID } from '$lib/api';

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

/**
 * Resolve "who can see this note" — the note's owner plus the members of the
 * nearest shared collection above it. Two features consume the same list: the
 * `@`-mention dropdown in the markdown editor and the assignee picker on Kanban
 * cards. Both branch off the note's position in the collection tree and the
 * async share state, so the logic lives here once instead of being duplicated.
 */

import type { Collection } from '$lib/api';
import { getCollectionShareState } from '$lib/api/sharing';
import type { CollectionShareAccessLevel } from '$lib/api/sharing';
import {
  collectionIsSharedByMe,
  collectionIsSharedWithMe
} from '$lib/stores/note-source.svelte';

/** A person in a note's share scope. Structurally the mention `MentionUser`. */
export interface ShareScopeUser {
  username: string;
  /** Access level within the scope; `null` for the owner / self. */
  accessLevel: CollectionShareAccessLevel | null;
  /** True for the signed-in user. */
  isSelf: boolean;
}

/**
 * Walk up from `parentId` to the nearest collection that is shared (with me or
 * by me) — the scope whose membership defines who can see the note. Returns
 * `null` when the note lives outside any shared collection.
 */
export function findShareScopeCollectionId(
  parentId: string | null,
  collectionsById: Record<string, Collection>
): string | null {
  let current = parentId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const c = collectionsById[current];
    if (!c) return null;
    if (collectionIsSharedWithMe(c) || collectionIsSharedByMe(c)) {
      return current;
    }
    current = c.parent_collection_id;
  }
  return null;
}

/**
 * Resolve the full candidate list for a note: yourself, plus — when the note is
 * in a shared scope — that scope's owner and members, de-duplicated
 * case-insensitively with `self` first. Falls back to self-only (or empty when
 * signed out) when the note isn't shared or the share state can't be fetched.
 */
export async function resolveShareScopeUsers(
  parentId: string | null,
  collectionsById: Record<string, Collection>,
  me: string | null
): Promise<ShareScopeUser[]> {
  const selfOnly: ShareScopeUser[] = me
    ? [{ username: me, accessLevel: null, isSelf: true }]
    : [];

  const scopeId = findShareScopeCollectionId(parentId, collectionsById);
  if (!scopeId) return selfOnly;

  try {
    const share = await getCollectionShareState(scopeId);
    const users: ShareScopeUser[] = [];
    const seen = new Set<string>();
    const add = (
      username: string | null,
      accessLevel: ShareScopeUser['accessLevel']
    ) => {
      const name = username?.trim();
      if (!name) return;
      const key = name.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      users.push({
        username: name,
        accessLevel,
        isSelf: me !== null && me.toLowerCase() === key
      });
    };
    add(me, null); // self first
    add(share.shared_owner, null);
    for (const member of share.members)
      add(member.username, member.access_level);
    return users;
  } catch {
    return selfOnly;
  }
}

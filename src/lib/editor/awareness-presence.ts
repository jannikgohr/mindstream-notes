import type { Awareness } from 'y-protocols/awareness';

/**
 * Number of *other* clients currently present in an awareness room (excludes
 * this client). Used to warn before a history restore overwrites content that
 * collaborators are editing live. Awareness prunes a client's state on
 * disconnect, so this reflects who is present now — not everyone who ever
 * joined. Returns 0 when there's no awareness (single-device / not synced).
 */
export function otherPeerCount(awareness: Awareness | null): number {
  if (!awareness) return 0;
  let others = 0;
  for (const clientId of awareness.getStates().keys()) {
    if (clientId !== awareness.clientID) others += 1;
  }
  return others;
}

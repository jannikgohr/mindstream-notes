/** Suggested filename for a vault export archive, dated in UTC. */
export function vaultArchiveName(now = new Date()): string {
  return `mindstream-notes-${now.toISOString().slice(0, 10)}.zip`;
}

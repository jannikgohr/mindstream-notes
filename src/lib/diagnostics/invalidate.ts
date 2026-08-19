/**
 * "Your results are stale" — broadcast to whoever is drawing diagnostics.
 *
 * Its own module rather than living with the bus because both the bus and
 * the personal dictionary need to raise it, and the personal dictionary is
 * consulted BY the bus's provider. Putting the emitter with either one puts
 * a cycle between them.
 *
 * An editor can see its own document change and re-check itself. It cannot
 * see a language get enabled, a dictionary finish installing, or a word get
 * added to the personal dictionary — each of which silently changes the
 * verdict for text nobody has touched.
 */

const listeners = new Set<() => void>();

export function subscribeDiagnosticsInvalidated(
  recheck: () => void
): () => void {
  listeners.add(recheck);
  return () => listeners.delete(recheck);
}

export function invalidateDiagnostics(): void {
  for (const listener of listeners) listener();
}

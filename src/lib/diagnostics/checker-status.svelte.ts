/**
 * What each checker is actually doing right now.
 *
 * This exists because of a specific, repeated failure mode: a checker that
 * contributes nothing looks exactly like a document with nothing wrong in
 * it. Three bugs in this feature have had that shape — an unconfigured
 * LanguageTool silently suppressed the local dictionary, a rejected
 * manifest made the plugin vanish, and a mis-decoded dictionary quietly
 * accepted every accented word. In each case the app produced LESS output
 * rather than an error, and there was nowhere to look.
 *
 * So status is reported from the checking pipeline itself, not from a
 * button the user has to press. A checker's real state is whatever happened
 * on its last actual run over the user's own text.
 */

export type CheckerState =
  /** Registered but has not run yet. */
  | 'idle'
  /** Missing configuration, so it contributes nothing. */
  | 'unconfigured'
  /** Last run succeeded. */
  | 'active'
  /** Last run failed — unreachable server, bad response, rejected key. */
  | 'failed';

export interface CheckerStatus {
  state: CheckerState;
  /** Server-provided or error text; not translated. */
  detail?: string;
  /** When the state was last set, for "checked N ago" style output. */
  at: number;
}

const statuses = $state<Record<string, CheckerStatus>>({});

export function checkerStatus(providerId: string): CheckerStatus {
  return statuses[providerId] ?? { state: 'idle', at: 0 };
}

export function reportCheckerStatus(
  providerId: string,
  state: CheckerState,
  detail?: string
): void {
  const previous = statuses[providerId];
  // Only rewrite on a real change. Every keystroke drives a check, and a
  // reactive write per paragraph per keystroke would redraw the settings
  // pane continuously for no new information.
  if (previous?.state === state && previous.detail === detail) return;
  statuses[providerId] = { state, detail, at: Date.now() };
}

/** Forget a checker's status — used when its plugin unregisters. */
export function clearCheckerStatus(providerId: string): void {
  delete statuses[providerId];
}

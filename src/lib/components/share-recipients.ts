/**
 * Parse the share dialog's recipient field into a clean list of usernames.
 *
 * The field accepts several names at once so a folder can be shared with a
 * group in one action. Names are separated by commas (newlines too, harmlessly,
 * in case the input ever becomes multi-line); whitespace around each is
 * trimmed. We deliberately do NOT split on spaces — a username is a single
 * token, and splitting on spaces would turn one fat-fingered "alice bob" into
 * two invites rather than one clear failure.
 *
 * De-duplication is case-insensitive (the backend treats usernames that way for
 * the self-invite and already-a-member guards), keeping the first spelling the
 * user typed.
 */
export function parseRecipients(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,\n]/)) {
    const name = part.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

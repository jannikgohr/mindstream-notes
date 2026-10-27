/** Shared looks for the account forms, so the sign-in form and the security
 *  panel under it read as one thing. */

export const FIELD_CLASS =
  'h-8 min-w-0 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60';

export const FIELD_LABEL_CLASS = 'text-xs text-muted-foreground';

/** Passwords shorter than this are refused before anything is sent. The
 *  server never sees a password, so it cannot refuse one itself. */
export const MIN_PASSWORD_LENGTH = 8;

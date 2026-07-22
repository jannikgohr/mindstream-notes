/**
 * Etebase auth bridge. Mirror of src-tauri/src/auth/mod.rs.
 *
 * The browser fallback (used when running outside Tauri, e.g. `pnpm dev`)
 * just reports "not signed in" and rejects login attempts — there's no
 * sensible way to talk to a real Etebase server without the OS keystore
 * to back the saved session.
 */

import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import {
  assertBoolean,
  assertNumber,
  assertRecord,
  assertString,
  assertVoid,
  TauriCommandName,
  isTauri
} from './core';

export type ServerType = 'managed' | 'self-hosted';

/** The fixed endpoint "managed" mode talks to. Mirrors MANAGED_SERVER_URL in
 *  src-tauri/src/auth/mod.rs — keep both in sync when changing. */
export const MANAGED_SERVER_URL = 'https://api.mindstream-notes.invalid/';

export interface LoginInput {
  serverType: ServerType;
  serverUrl?: string;
  username: string;
  password: string;
}

export interface SessionInfo {
  username: string;
  /** Resolved server URL (managed → api.etebase.com, otherwise the user's). */
  server_url: string;
}

export interface ServerCheckResult {
  ok: boolean;
  status: number;
  url: string;
}

type AuthSessionState =
  | { status: 'loading' }
  | { status: 'signedOut' }
  | { status: 'signedIn'; session: SessionInfo };

/**
 * Pub/sub for session-state transitions. Login + logout both dispatch
 * a 'change' event after the Rust side completes; long-lived consumers
 * (the collab provider in particular) listen so they can tear down or
 * re-init when the user signs in or out without forcing a route change.
 *
 * The bus lives at the module level so any caller sees the same target;
 * EventTarget is built-in and pulls in no dependencies.
 */
const sessionEvents = new EventTarget();

/**
 * Subscribe to session-state changes. Returns an unsubscribe function
 * — call it from your component's onDestroy (or Svelte's cleanup
 * return) so the listener doesn't leak across hot reloads.
 */
export function onSessionChange(handler: () => void): () => void {
  const listener = () => handler();
  sessionEvents.addEventListener('change', listener);
  return () => sessionEvents.removeEventListener('change', listener);
}

function emitSessionChange() {
  sessionEvents.dispatchEvent(new Event('change'));
}

/**
 * Reactive session store. Cheap to read from any Svelte component
 * (`authSession.current` in a `$derived`) without each one having to
 * keep its own `etebaseSession()` polling state. Hydrated lazily on
 * first read via `refreshAuthSession()` and re-fetched after every
 * login/logout below, so the value stays correct across windows that
 * share the underlying session file.
 *
 * `initialised` is false until the first refresh completes, which lets
 * callers distinguish "we're still loading" from "definitely signed
 * out" — important for the settings UI that gates a radio on session
 * state and doesn't want to flicker.
 */
class AuthSessionStore {
  state = $state<AuthSessionState>({ status: 'loading' });
  initialised = $state(false);

  get current(): SessionInfo | null {
    return this.state.status === 'signedIn' ? this.state.session : null;
  }

  set current(session: SessionInfo | null) {
    this.state =
      session === null
        ? { status: 'signedOut' }
        : { status: 'signedIn', session };
  }
}

export const authSession = new AuthSessionStore();

/**
 * Pull the live session from Rust into `authSession.current`. Safe to
 * call repeatedly; the Rust side is just a file read + keyring probe.
 * Errors are swallowed and treated as "not signed in" — same fallback
 * the old per-component refresh() used.
 */
export async function refreshAuthSession(): Promise<void> {
  try {
    authSession.current = await etebaseSession();
  } catch (err) {
    console.warn('[auth] session refresh failed', err);
    authSession.current = null;
  } finally {
    authSession.initialised = true;
  }
}

// Kick off an initial hydration once at module load so the first
// component that reads `authSession.current` doesn't have to await.
// Tauri-only — outside Tauri the Rust IPC isn't available and
// `etebaseSession()` resolves to null synchronously anyway.
if (typeof window !== 'undefined') {
  void refreshAuthSession();
}

export async function etebaseLogin(input: LoginInput): Promise<SessionInfo> {
  assertLoginInput(input);
  if (!isTauri()) {
    throw new Error('Sign-in is only available in the desktop app.');
  }
  const session = parseSessionInfo(
    await tauriInvoke<unknown>(TauriCommandName.EtebaseLogin, {
      args: {
        server_type: input.serverType,
        server_url: input.serverUrl ?? null,
        username: input.username,
        password: input.password
      }
    })
  );
  authSession.current = session;
  authSession.initialised = true;
  emitSessionChange();
  return session;
}

export async function etebaseLogout(): Promise<void> {
  if (!isTauri()) return;
  assertVoid(
    await tauriInvoke<unknown>(TauriCommandName.EtebaseLogout),
    'etebase_logout response'
  );
  authSession.current = null;
  authSession.initialised = true;
  emitSessionChange();
}

export async function etebaseSession(): Promise<SessionInfo | null> {
  if (!isTauri()) return null;
  return parseNullableSessionInfo(
    await tauriInvoke<unknown>(TauriCommandName.EtebaseSession)
  );
}

/**
 * Which server type a live session implies, derived from its resolved
 * server URL. The on-disk Etebase session is the source of truth for
 * "where am I connected"; the vault-scoped `account.serverType` setting
 * can be lost (cleared web storage, a fresh WebView profile) while the
 * session survives, so this lets the account UI recover from the session
 * alone instead of decaying to "local-only" and stranding a signed-in
 * user with the server-type radios locked.
 */
export function serverTypeForSession(session: SessionInfo): ServerType {
  assertRequiredString(session.server_url, 'session.server_url');
  const strip = (url: string) => url.replace(/\/+$/, '');
  return strip(session.server_url) === strip(MANAGED_SERVER_URL)
    ? 'managed'
    : 'self-hosted';
}

export async function checkEtebaseServerUrl(
  serverUrl: string
): Promise<ServerCheckResult> {
  assertRequiredString(serverUrl, 'serverUrl');
  if (!isTauri()) {
    return { ok: true, status: 200, url: serverUrl };
  }
  return parseServerCheckResult(
    await tauriInvoke<unknown>(TauriCommandName.CheckEtebaseServerUrl, {
      serverUrl
    })
  );
}

function assertLoginInput(input: LoginInput): void {
  switch (input.serverType) {
    case 'managed':
      break;
    case 'self-hosted':
      assertRequiredString(input.serverUrl ?? '', 'input.serverUrl');
      break;
    default: {
      const _exhaustive: never = input.serverType;
      throw new Error(`input.serverType is unsupported: ${_exhaustive}`);
    }
  }
  assertRequiredString(input.username, 'input.username');
  assertRequiredString(input.password, 'input.password');
}

function assertRequiredString(value: string, context: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${context} must be a non-empty string`);
  }
}

function parseSessionInfo(value: unknown): SessionInfo {
  const raw = assertRecord(value, 'session info');
  return {
    username: assertString(raw.username, 'session info.username'),
    server_url: assertString(raw.server_url, 'session info.server_url')
  };
}

function parseNullableSessionInfo(value: unknown): SessionInfo | null {
  if (value === null || value === undefined) return null;
  return parseSessionInfo(value);
}

function parseServerCheckResult(value: unknown): ServerCheckResult {
  const raw = assertRecord(value, 'server check result');
  return {
    ok: assertBoolean(raw.ok, 'server check result.ok'),
    status: assertNumber(raw.status, 'server check result.status'),
    url: assertString(raw.url, 'server check result.url')
  };
}

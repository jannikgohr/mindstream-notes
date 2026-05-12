/**
 * Etebase auth bridge. Mirror of src-tauri/src/auth/mod.rs.
 *
 * The browser fallback (used when running outside Tauri, e.g. `pnpm dev`)
 * just reports "not signed in" and rejects login attempts — there's no
 * sensible way to talk to a real Etebase server without the OS keystore
 * to back the saved session.
 */

import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { isTauri } from './index';

export type ServerType = 'managed' | 'self-hosted';

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

export async function etebaseLogin(input: LoginInput): Promise<SessionInfo> {
  if (!isTauri()) {
    throw new Error('Sign-in is only available in the desktop app.');
  }
  const session = await tauriInvoke<SessionInfo>('etebase_login', {
    args: {
      server_type: input.serverType,
      server_url: input.serverUrl ?? null,
      username: input.username,
      password: input.password
    }
  });
  emitSessionChange();
  return session;
}

export async function etebaseLogout(): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke<void>('etebase_logout');
  emitSessionChange();
}

export async function etebaseSession(): Promise<SessionInfo | null> {
  if (!isTauri()) return null;
  return await tauriInvoke<SessionInfo | null>('etebase_session');
}

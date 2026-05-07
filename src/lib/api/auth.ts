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

export async function etebaseLogin(input: LoginInput): Promise<SessionInfo> {
  if (!isTauri()) {
    throw new Error('Sign-in is only available in the desktop app.');
  }
  return await tauriInvoke<SessionInfo>('etebase_login', {
    args: {
      server_type: input.serverType,
      server_url: input.serverUrl ?? null,
      username: input.username,
      password: input.password
    }
  });
}

export async function etebaseLogout(): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke<void>('etebase_logout');
}

export async function etebaseSession(): Promise<SessionInfo | null> {
  if (!isTauri()) return null;
  return await tauriInvoke<SessionInfo | null>('etebase_session');
}

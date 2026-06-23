import { invoke as tauriInvoke } from '@tauri-apps/api/core';

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function invokeOrFallback<T>(
  command: string,
  args: Record<string, unknown> | undefined,
  fallback: () => T | Promise<T>
): Promise<T> {
  if (!isTauri()) return await fallback();
  return await tauriInvoke<T>(command, args);
}

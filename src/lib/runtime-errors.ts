import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '$lib/api/core';
import { toErrorMessage } from '$lib/api/errors';

export function reportRuntimeError(reason: unknown): void {
  const message = toErrorMessage(reason).slice(0, 4096);
  console.error('[client] unhandled error', message);
  if (isTauri()) {
    void invoke('report_client_error', { message }).catch((error: unknown) => {
      console.error('[client] error reporting failed', error);
    });
  }
}

export function installRuntimeErrorReporting(
  target: Window = window
): () => void {
  const onRejection = (event: PromiseRejectionEvent) =>
    reportRuntimeError(event.reason);
  const onError = (event: ErrorEvent) =>
    reportRuntimeError(event.error ?? event.message);
  target.addEventListener('unhandledrejection', onRejection);
  target.addEventListener('error', onError);
  return () => {
    target.removeEventListener('unhandledrejection', onRejection);
    target.removeEventListener('error', onError);
  };
}

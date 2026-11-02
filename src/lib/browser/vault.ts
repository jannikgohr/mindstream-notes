import { BrowserStorageClient } from './client';
import {
  recoverBrowserNotes,
  rememberBrowserNote,
  beginBrowserWrite,
  clearBrowserTestRecovery
} from './recovery';
import type { BrowserCommand, BrowserRequest } from './commands';
import { browserTestVaultId } from './testing';
import { vaultNamespace } from './namespace';
import {
  storageError,
  type BrowserBackup,
  type StorageError
} from './protocol';
import { tUi } from '$lib/settings/i18n.svelte';

// The healthy connection, if any. Set only after a successful open so a failed
// attempt never leaves a dead client cached.
let client: BrowserStorageClient | undefined;
// The in-flight open attempt, shared by concurrent callers so they all observe
// one outcome. Cleared when the attempt settles, success or failure.
let opening: Promise<BrowserStorageClient> | undefined;
let resetting = false;
let startupChecked = false;
let resetFailure: StorageError | undefined;

function failedReset(cause?: unknown): StorageError {
  const error = cause ? storageError(cause) : { code: 'refused' as const };
  return {
    ...error,
    message:
      tUi('browser.testing.blocked') +
      ('message' in error ? ` ${error.message}` : '')
  };
}

async function openVault(): Promise<BrowserStorageClient> {
  const testId = browserTestVaultId();
  const resetKey = vaultNamespace(testId).reset;
  let reset = false;
  // Read reset intent once, before the first open. Consume it before spawning
  // the worker: a crash or refusal must never leave an automatic future wipe.
  if (!startupChecked) {
    startupChecked = true;
    if (testId && resetKey) {
      try {
        const intent = sessionStorage.getItem(resetKey);
        if (intent === '1') {
          sessionStorage.setItem(resetKey, 'failed');
          reset = true;
        } else if (intent !== null) {
          resetFailure = failedReset();
        }
      } catch (cause) {
        resetFailure = failedReset(cause);
      }
    }
  }
  if (resetFailure) throw resetFailure;
  let connection: BrowserStorageClient | undefined;
  try {
    // Constructor failures participate in the same startup reset gate.
    connection = new BrowserStorageClient();
    if (reset && testId && resetKey) {
      await connection.request('resetTestVault', { testId });
      clearBrowserTestRecovery(testId);
      sessionStorage.removeItem(resetKey);
    } else {
      await connection.request('open', {
        scope: 'vault',
        ...(testId ? { testId } : {})
      });
      await recoverBrowserNotes(connection);
    }
  } catch (error) {
    connection?.dispose();
    if (reset) {
      resetFailure = failedReset(error);
      throw resetFailure;
    }
    throw error;
  }
  client = connection;
  return connection;
}

function connect(): Promise<BrowserStorageClient> {
  if (resetFailure) return Promise.reject(resetFailure);
  if (resetting)
    return Promise.reject({
      code: 'closed',
      message: 'The test vault is being reset'
    });
  // A client whose worker was terminated is replaced here, on the next call,
  // rather than being retried inside the failed call.
  if (client && !client.isClosed) return Promise.resolve(client);
  opening ??= openVault().finally(() => {
    opening = undefined;
  });
  return opening;
}

/** A large vault takes minutes to snapshot and compress. A stalled worker is
 * still caught, but this must not look like one. */
const BACKUP_TIMEOUT_MS = 10 * 60_000;

export async function backupBrowserVault(): Promise<BrowserBackup> {
  const connection = await connect();
  return connection.request('backup', undefined, BACKUP_TIMEOUT_MS);
}

export async function invokeBrowser(
  command: BrowserCommand,
  args: Record<string, unknown> = {}
): Promise<unknown> {
  const connection = await connect();
  // The IPC adapter retains its existing validators. Rust deserializes this
  // request into VaultRequest before any query or mutation can execute.
  const { recoveryToken, ...operationArgs } = args;
  const writeId =
    command === 'save_note'
      ? (args.input as { id?: string } | undefined)?.id
      : command === 'drawing_save_ink_state'
        ? (args.noteId as string)
        : undefined;
  const write =
    writeId && typeof recoveryToken === 'string'
      ? beginBrowserWrite(writeId, recoveryToken)
      : { finish: () => {}, token: undefined };
  try {
    const result = await connection.request('invoke', {
      command,
      args: operationArgs,
      ...(write.token ? { recoveryToken: write.token } : {})
    } as BrowserRequest & { recoveryToken?: string });
    rememberBrowserNote(result);
    if (command === 'drawing_save_ink_state') {
      // The native-compatible ink command returns void. Read its merged state so
      // a concurrent pending checkpoint can be based on the acknowledged content.
      rememberBrowserNote(
        await connection.request('invoke', {
          command: 'load_note',
          args: { id: args.noteId as string }
        })
      );
    }
    return result;
  } finally {
    write.finish();
  }
}

/** Request one test-only reset attempt before the next page opens storage.
 * Closing first prevents old editors from reopening storage during navigation. The fresh
 * worker acquires the test lock before deletion, reseeding, and journal cleanup. */
export async function prepareBrowserTestReset(): Promise<void> {
  const id = browserTestVaultId();
  if (!id)
    throw new Error(
      'Reset is available only for an isolated browser test vault'
    );
  const key = vaultNamespace(id).reset!;
  sessionStorage.setItem(key, '1');
  resetting = true;
  const connection = client ?? (await opening?.catch(() => undefined));
  try {
    await connection?.close();
  } catch {
    // Reset intentionally discards this test vault. A failed close still
    // terminates its worker, and the new owner must obtain the lock to delete.
  } finally {
    connection?.dispose();
    client = undefined;
    opening = undefined;
  }
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    client?.dispose();
    client = undefined;
    opening = undefined;
  });
}

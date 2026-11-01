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

// The healthy connection, if any. Set only after a successful open so a failed
// attempt never leaves a dead client cached.
let client: BrowserStorageClient | undefined;
// The in-flight open attempt, shared by concurrent callers so they all observe
// one outcome. Cleared when the attempt settles, success or failure.
let opening: Promise<BrowserStorageClient> | undefined;
let resetting = false;

async function openVault(): Promise<BrowserStorageClient> {
  // The constructor can throw (for example when CSP blocks workers), so it runs
  // inside the attempt and its failure is cleared like any other open failure.
  const connection = new BrowserStorageClient();
  try {
    const testId = browserTestVaultId();
    const resetKey = vaultNamespace(testId).reset;
    if (testId && resetKey && sessionStorage.getItem(resetKey) === '1') {
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
    connection.dispose();
    throw error;
  }
  client = connection;
  return connection;
}

function connect(): Promise<BrowserStorageClient> {
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

/** Mark a test-only reset for the next page load. Closing first prevents old
 * editors from reopening storage while the page is navigating away. The fresh
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

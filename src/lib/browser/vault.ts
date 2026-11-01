import { BrowserStorageClient } from './client';
import {
  recoverBrowserNotes,
  rememberBrowserNote,
  beginBrowserWrite
} from './recovery';
import type { BrowserCommand, BrowserRequest } from './commands';

// The healthy connection, if any. Set only after a successful open so a failed
// attempt never leaves a dead client cached.
let client: BrowserStorageClient | undefined;
// The in-flight open attempt, shared by concurrent callers so they all observe
// one outcome. Cleared when the attempt settles, success or failure.
let opening: Promise<BrowserStorageClient> | undefined;

async function openVault(): Promise<BrowserStorageClient> {
  // The constructor can throw (for example when CSP blocks workers), so it runs
  // inside the attempt and its failure is cleared like any other open failure.
  const connection = new BrowserStorageClient();
  try {
    await connection.request('open', { scope: 'vault' });
    await recoverBrowserNotes(connection);
  } catch (error) {
    connection.dispose();
    throw error;
  }
  client = connection;
  return connection;
}

function connect(): Promise<BrowserStorageClient> {
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

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    client?.dispose();
    client = undefined;
    opening = undefined;
  });
}

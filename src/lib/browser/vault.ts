import { BrowserStorageClient } from './client';
import type { BrowserCommand, BrowserRequest } from './commands';

let client: BrowserStorageClient | undefined;
let opening: Promise<BrowserStorageClient> | undefined;

function connect(): Promise<BrowserStorageClient> {
  opening ??= (async () => {
    const connection = new BrowserStorageClient();
    client = connection;
    try {
      await connection.request('open', { scope: 'vault' });
      return connection;
    } catch (error) {
      connection.dispose();
      opening = undefined;
      throw error;
    }
  })();
  return opening;
}

export async function invokeBrowser(
  command: BrowserCommand,
  args: Record<string, unknown> = {}
): Promise<unknown> {
  const connection = await connect();
  // The IPC adapter retains its existing validators. Rust deserializes this
  // request into VaultRequest before any query or mutation can execute.
  return connection.request('invoke', { command, args } as BrowserRequest);
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    client?.dispose();
    opening = undefined;
  });
}

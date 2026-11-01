import {
  parseRequest,
  storageError,
  type StorageRequest,
  type StorageResponse
} from './protocol';

interface WasmDatabase {
  verify(): unknown;
  write(body: string): void;
  read(): string | undefined;
  close(): void;
  free(): void;
}
interface WasmModule {
  default(): Promise<unknown>;
  BrowserDatabase: { open(): Promise<WasmDatabase> };
}

const worker = self as unknown as {
  navigator: Pick<Navigator, 'storage' | 'locks'>;
  isSecureContext: boolean;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: StorageResponse): void;
};
let database: WasmDatabase | undefined;
let releaseOwnership: (() => void) | undefined;

async function open() {
  if (database) return;
  if (
    !worker.isSecureContext ||
    !worker.navigator.storage?.getDirectory ||
    !worker.navigator.locks
  ) {
    throw {
      code: 'unsupported',
      message: 'This browser needs a secure context, OPFS, and Web Locks.'
    };
  }
  // Lock the entire pool, not just a database filename. SAH pools acquire all
  // their handles during installation, including the rollback journal files.
  await new Promise<void>((resolve, reject) => {
    void worker.navigator.locks
      .request(
        'mindstream:sqlite-proof:pool',
        { mode: 'exclusive', ifAvailable: true },
        async (lock) => {
          if (!lock) {
            reject({
              code: 'databaseBusy',
              message:
                'The database is open in another tab. Close it there and retry.'
            });
            return;
          }
          await new Promise<void>((release) => {
            releaseOwnership = release;
            resolve();
          });
        }
      )
      .catch(reject);
  });
  try {
    const moduleUrl = new URL(
      `${import.meta.env.BASE_URL}browser-wasm/storage.js`,
      self.location.origin
    ).href;
    const wasm = (await import(/* @vite-ignore */ moduleUrl)) as WasmModule;
    await wasm.default();
    database = await wasm.BrowserDatabase.open();
  } catch (error) {
    releaseOwnership?.();
    releaseOwnership = undefined;
    throw error;
  }
}

async function handle(request: StorageRequest): Promise<unknown> {
  if (request.method === 'close') {
    database?.close();
    database?.free();
    database = undefined;
    releaseOwnership?.();
    releaseOwnership = undefined;
    return;
  }
  await open();
  if (!database) throw new Error('Database did not initialize');
  switch (request.method) {
    case 'open':
      return;
    case 'verify':
      return database.verify();
    case 'read':
      return database.read() ?? null;
    case 'write':
      return database.write(request.args.body);
  }
}

// Initialization and every operation run in order, including concurrent callers.
let queue = Promise.resolve();
worker.onmessage = (event) => {
  queue = queue.then(async () => {
    let id = 0;
    try {
      if (
        event.data &&
        typeof event.data === 'object' &&
        'id' in event.data &&
        typeof event.data.id === 'number'
      )
        id = event.data.id;
      let request: StorageRequest;
      try {
        request = parseRequest(event.data);
      } catch {
        throw { code: 'invalidArgument', message: 'Invalid storage request' };
      }
      const result = await handle(request);
      worker.postMessage({ id: request.id, ok: true, result });
    } catch (error) {
      worker.postMessage({ id, ok: false, error: storageError(error) });
    }
  });
};

import { packBackup, unpackBackup, type BackupParts } from './backup-archive';
import { vaultNamespace } from './namespace';
import {
  parseRequest,
  storageError,
  type StorageRequest,
  type StorageResponse
} from './protocol';

interface WasmDatabase {
  invoke(request: unknown, recoveryToken?: string): unknown;
  receipt(noteId: string): string | undefined;
  backup(): BackupParts;
  import_begin(
    manifest: string,
    entries: string[],
    database: Uint8Array
  ): unknown;
  import_merge(token: string): unknown;
  import_restore(token: string, sameAccount: boolean): boolean;
  import_cleanup(token: string): void;
  prepare_interrupted_write(): void;
  check_interrupted_write(): number;
  verify(): unknown;
  write(body: string): void;
  read(): string | undefined;
  close(): void;
  free(): void;
}
interface WasmModule {
  default(): Promise<unknown>;
  BrowserDatabase: {
    open(): Promise<WasmDatabase>;
    open_vault(): Promise<WasmDatabase>;
    open_test_vault(id: string): Promise<WasmDatabase>;
  };
}

const worker = self as unknown as {
  navigator: Pick<Navigator, 'storage' | 'locks'>;
  isSecureContext: boolean;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: StorageResponse): void;
};
let database: WasmDatabase | undefined;
let scope: 'proof' | 'vault' = 'proof';
let testId: string | undefined;
let releaseOwnership: (() => void) | undefined;

async function open(reset = false) {
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
        scope === 'vault'
          ? vaultNamespace(testId).lock
          : 'mindstream:sqlite-proof:pool',
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
    if (reset) {
      if (!testId) throw new Error('Only a test vault can be reset');
      const root = await worker.navigator.storage.getDirectory();
      try {
        await root.removeEntry(vaultNamespace(testId).directory, {
          recursive: true
        });
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'NotFoundError'))
          throw error;
      }
    }
    const moduleUrl = new URL(
      `${import.meta.env.BASE_URL}browser-wasm/storage.js`,
      self.location.origin
    ).href;
    const wasm = (await import(/* @vite-ignore */ moduleUrl)) as WasmModule;
    await wasm.default();
    database = await (scope === 'vault'
      ? testId
        ? wasm.BrowserDatabase.open_test_vault(testId)
        : wasm.BrowserDatabase.open_vault()
      : wasm.BrowserDatabase.open());
  } catch (error) {
    releaseOwnership?.();
    releaseOwnership = undefined;
    throw error;
  }
}

async function handle(request: StorageRequest): Promise<unknown> {
  if (request.method === 'resetTestVault') {
    // Reset is performed by a fresh worker, holding the test pool lock before
    // removing any files. It never opens or deletes the normal/proof pools.
    if (database || releaseOwnership)
      throw {
        code: 'invalidArgument',
        message: 'Reset requires a fresh storage worker'
      };
    scope = 'vault';
    testId = request.args.testId;
    await open(true);
    return;
  }
  if (request.method === 'open') {
    const requestedScope = request.args?.scope ?? 'proof';
    if (
      database &&
      (scope !== requestedScope || testId !== request.args?.testId)
    )
      throw {
        code: 'invalidArgument',
        message: 'Storage scope cannot change while open'
      };
    scope = requestedScope;
    testId = request.args?.testId;
  }
  if (
    [
      'invoke',
      'receipt',
      'backup',
      'importBegin',
      'importMerge',
      'importRestore',
      'importCleanup'
    ].includes(request.method) &&
    scope !== 'vault'
  )
    throw {
      code: 'invalidArgument',
      message: 'Vault storage has not been opened'
    };
  if (
    [
      'verify',
      'read',
      'write',
      'prepareInterruptedWrite',
      'checkInterruptedWrite'
    ].includes(request.method) &&
    scope !== 'proof'
  )
    throw {
      code: 'invalidArgument',
      message: 'Proof operations require proof storage'
    };
  if (request.method === 'close') {
    database?.close();
    release();
    return;
  }
  await open();
  if (!database) throw new Error('Database did not initialize');
  switch (request.method) {
    case 'open':
      return;
    case 'invoke':
      // Match Tauri's JSON arguments: undefined object fields are omitted,
      // while null remains an explicit clear for partial note updates.
      return database.invoke(
        JSON.parse(
          JSON.stringify({
            command: request.args.command,
            args: request.args.args
          })
        ),
        request.args.recoveryToken
      );
    case 'receipt':
      return database.receipt(request.args.id) ?? null;
    case 'backup':
      return packBackup(database.backup());
    case 'importBegin': {
      const {
        manifest,
        entries,
        database: snapshot
      } = unpackBackup(
        new Uint8Array(await request.args.archive.arrayBuffer())
      );
      return database.import_begin(manifest, entries, snapshot);
    }
    case 'importMerge':
      return database.import_merge(request.args.token);
    case 'importRestore': {
      const sanitized = database.import_restore(
        request.args.token,
        request.args.sameAccount
      );
      // Rust closed the vault. The page reloads onto the restored data.
      release();
      return sanitized;
    }
    case 'importCleanup':
      return database.import_cleanup(request.args.token);
    case 'prepareInterruptedWrite':
      return database.prepare_interrupted_write();
    case 'checkInterruptedWrite':
      return database.check_interrupted_write();
    case 'verify':
      return database.verify();
    case 'read':
      return database.read() ?? null;
    case 'write':
      return database.write(request.args.body);
  }
}

function release() {
  database?.free();
  database = undefined;
  releaseOwnership?.();
  releaseOwnership = undefined;
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

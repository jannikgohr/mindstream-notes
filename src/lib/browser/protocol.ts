import { isBrowserCommand, type BrowserRequest } from './commands';
import { isTestVaultId } from './namespace';
import type { ImportReport } from '../api/notes-import';
export interface ProofReport {
  schemaVersion: number;
  upgrades: number;
  sqliteVersion: string;
  journalMode: string;
  fts5: boolean;
  transactions: boolean;
  foreignKeys: boolean;
  crdt: boolean;
}

export interface BrowserBackup {
  archive: Blob;
  filename: string;
  counts: { notes: number; folders: number; assets_bytes: number };
  accountPresent: boolean;
}

/** What the user picked for a notes import. Paths are relative to the pick. */
export interface PickedSource {
  name: string;
  /** One export file, not a folder of notes. */
  single: boolean;
  files: { path: string; file: File }[];
}

export interface ImportProgressMessage {
  phase: string;
  /** Items processed, failures included. Not a count of notes written. */
  done: number;
  total: number;
  /**
   * Every report counter as of the last commit. A stopped run reports this
   * snapshot. Optional so a payload without it still parses.
   */
  committed?: ImportReport;
}

export interface StorageMethods {
  open: { args: undefined | { scope: 'vault'; testId?: string }; result: void };
  resetTestVault: { args: { testId: string }; result: void };
  invoke: {
    args: BrowserRequest & { recoveryToken?: string };
    result: unknown;
  };
  receipt: { args: { id: string }; result: string | null };
  backup: { args: undefined; result: BrowserBackup };
  importBegin: { args: { archive: Blob }; result: unknown };
  importMerge: { args: { token: string }; result: unknown };
  importRestore: {
    args: { token: string; sameAccount: boolean };
    result: boolean;
  };
  importCleanup: { args: { token: string }; result: void };
  notesDetect: { args: { source: PickedSource }; result: unknown };
  notesImport: {
    args: { source: PickedSource; options: Record<string, unknown> };
    result: unknown;
  };
  prepareInterruptedWrite: { args: undefined; result: void };
  checkInterruptedWrite: { args: undefined; result: number };
  verify: { args: undefined; result: ProofReport };
  read: { args: undefined; result: string | null };
  write: { args: { body: string }; result: void };
  close: { args: undefined; result: void };
}

export type StorageMethod = keyof StorageMethods;
export type StorageRequest = {
  [K in StorageMethod]: {
    id: number;
    method: K;
    args: StorageMethods[K]['args'];
  };
}[StorageMethod];

export type StorageErrorCode =
  | 'io'
  | 'notFound'
  | 'refused'
  | 'database'
  | 'databaseBusy'
  | 'unsupported'
  | 'invalidArgument'
  | 'worker'
  | 'timeout'
  | 'closed';

export interface StorageError {
  code: StorageErrorCode;
  message: string;
  reason?: string;
}

export type StorageResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: StorageError }
  | { id?: undefined; progress: ImportProgressMessage };

const errorCodes = new Set<StorageErrorCode>([
  'io',
  'notFound',
  'refused',
  'database',
  'databaseBusy',
  'unsupported',
  'invalidArgument',
  'worker',
  'timeout',
  'closed'
]);

export function storageError(error: unknown): StorageError {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    errorCodes.has(error.code as StorageErrorCode) &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return {
      code: error.code as StorageErrorCode,
      message: error.message,
      ...('reason' in error && typeof error.reason === 'string'
        ? { reason: error.reason }
        : {})
    };
  }
  return {
    code: 'worker',
    message: error instanceof Error ? error.message : String(error)
  };
}

function isPickedSource(value: unknown): value is PickedSource {
  const source = value as Partial<PickedSource> | null | undefined;
  return (
    typeof source?.name === 'string' &&
    typeof source.single === 'boolean' &&
    Array.isArray(source.files) &&
    source.files.every(
      (entry) => typeof entry?.path === 'string' && entry.file instanceof File
    )
  );
}

export function parseRequest(value: unknown): StorageRequest {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid storage request');
  const request = value as Record<string, unknown>;
  if (!Number.isSafeInteger(request.id) || (request.id as number) < 1) {
    throw new Error('Invalid storage request ID');
  }
  if (
    ![
      'open',
      'resetTestVault',
      'invoke',
      'receipt',
      'backup',
      'importBegin',
      'importMerge',
      'importRestore',
      'importCleanup',
      'notesDetect',
      'notesImport',
      'prepareInterruptedWrite',
      'checkInterruptedWrite',
      'verify',
      'read',
      'write',
      'close'
    ].includes(request.method as string)
  ) {
    throw new Error('Unknown storage method');
  }
  if (request.method === 'invoke') {
    if (
      !request.args ||
      typeof request.args !== 'object' ||
      !('command' in request.args) ||
      !isBrowserCommand(request.args.command) ||
      !('args' in request.args) ||
      !request.args.args ||
      typeof request.args.args !== 'object' ||
      Array.isArray(request.args.args)
    ) {
      throw new Error('Invalid vault operation');
    }
    if (
      'recoveryToken' in request.args &&
      request.args.recoveryToken !== undefined &&
      (typeof request.args.recoveryToken !== 'string' ||
        !request.args.recoveryToken.length ||
        request.args.recoveryToken.length > 128)
    )
      throw new Error('Invalid save receipt');
  } else if (request.method === 'receipt') {
    if (
      !request.args ||
      typeof request.args !== 'object' ||
      !('id' in request.args) ||
      typeof request.args.id !== 'string'
    )
      throw new Error('receipt requires a note id');
  } else if (
    request.method === 'notesDetect' ||
    request.method === 'notesImport'
  ) {
    if (
      !request.args ||
      typeof request.args !== 'object' ||
      !('source' in request.args) ||
      !isPickedSource(request.args.source) ||
      (request.method === 'notesImport' &&
        (!('options' in request.args) ||
          !request.args.options ||
          typeof request.args.options !== 'object'))
    )
      throw new Error('Import requires picked files');
  } else if (request.method === 'importBegin') {
    if (
      !request.args ||
      typeof request.args !== 'object' ||
      !('archive' in request.args) ||
      !(request.args.archive instanceof Blob)
    )
      throw new Error('importBegin requires a backup file');
  } else if (
    request.method === 'importMerge' ||
    request.method === 'importCleanup' ||
    request.method === 'importRestore'
  ) {
    if (
      !request.args ||
      typeof request.args !== 'object' ||
      !('token' in request.args) ||
      typeof request.args.token !== 'string' ||
      !request.args.token ||
      (request.method === 'importRestore' &&
        (!('sameAccount' in request.args) ||
          typeof request.args.sameAccount !== 'boolean'))
    )
      throw new Error('Import requires a staged backup');
  } else if (request.method === 'resetTestVault') {
    if (
      !request.args ||
      typeof request.args !== 'object' ||
      !('testId' in request.args) ||
      !isTestVaultId(request.args.testId)
    )
      throw new Error('Reset requires a valid test vault identifier');
  } else if (request.method === 'open') {
    if (
      request.args !== undefined &&
      (!request.args ||
        typeof request.args !== 'object' ||
        !('scope' in request.args) ||
        request.args.scope !== 'vault' ||
        ('testId' in request.args &&
          request.args.testId !== undefined &&
          !isTestVaultId(request.args.testId)))
    )
      throw new Error('Invalid storage scope');
  } else if (request.method === 'write') {
    if (
      !request.args ||
      typeof request.args !== 'object' ||
      !('body' in request.args) ||
      typeof request.args.body !== 'string'
    ) {
      throw new Error('write requires a string body');
    }
  } else if (request.args !== undefined) {
    throw new Error('This storage method does not accept arguments');
  }
  return request as StorageRequest;
}

export function parseResult<K extends StorageMethod>(
  method: K,
  value: unknown
): StorageMethods[K]['result'] {
  // The API layer validates these with the same parsers it uses for IPC.
  if (
    method === 'invoke' ||
    method === 'importBegin' ||
    method === 'importMerge' ||
    method === 'notesDetect' ||
    method === 'notesImport'
  )
    return value as StorageMethods[K]['result'];
  if (method === 'verify') {
    const r = value as Partial<ProofReport> | null;
    if (
      !r ||
      !Number.isSafeInteger(r.schemaVersion) ||
      !Number.isSafeInteger(r.upgrades) ||
      typeof r.sqliteVersion !== 'string' ||
      typeof r.journalMode !== 'string' ||
      ['fts5', 'transactions', 'foreignKeys', 'crdt'].some(
        (key) => typeof r[key as keyof ProofReport] !== 'boolean'
      )
    ) {
      throw new Error('Invalid SQLite proof response');
    }
  } else if (method === 'checkInterruptedWrite') {
    if (!Number.isSafeInteger(value) || (value as number) < 0)
      throw new Error('Invalid interrupted-write report');
  } else if (method === 'importRestore') {
    if (typeof value !== 'boolean') throw new Error('Invalid restore response');
  } else if (method === 'backup') {
    const backup = value as Partial<BrowserBackup> | null;
    if (
      !(backup?.archive instanceof Blob) ||
      typeof backup.filename !== 'string' ||
      typeof backup.accountPresent !== 'boolean' ||
      [
        backup.counts?.notes,
        backup.counts?.folders,
        backup.counts?.assets_bytes
      ].some((count) => !Number.isSafeInteger(count))
    )
      throw new Error('Invalid backup response');
  } else if (method === 'read' || method === 'receipt') {
    if (value !== null && typeof value !== 'string')
      throw new Error('Invalid marker response');
  } else if (value !== undefined && value !== null) {
    throw new Error('Invalid storage response');
  }
  return value as StorageMethods[K]['result'];
}

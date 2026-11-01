import { isBrowserCommand, type BrowserRequest } from './commands';
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

export interface StorageMethods {
  open: { args: undefined | { scope: 'vault' }; result: void };
  invoke: {
    args: BrowserRequest & { recoveryToken?: string };
    result: unknown;
  };
  receipt: { args: { id: string }; result: string | null };
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
  | { id: number; ok: false; error: StorageError };

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
      'invoke',
      'receipt',
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
  } else if (request.method === 'open') {
    if (
      request.args !== undefined &&
      (!request.args ||
        typeof request.args !== 'object' ||
        !('scope' in request.args) ||
        request.args.scope !== 'vault')
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
  if (method === 'invoke') return value as StorageMethods[K]['result'];
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
  } else if (method === 'read' || method === 'receipt') {
    if (value !== null && typeof value !== 'string')
      throw new Error('Invalid marker response');
  } else if (value !== undefined && value !== null) {
    throw new Error('Invalid storage response');
  }
  return value as StorageMethods[K]['result'];
}

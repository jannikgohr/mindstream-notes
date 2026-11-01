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
  open: { args: undefined; result: void };
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
}

export type StorageResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: StorageError };

const errorCodes = new Set<StorageErrorCode>([
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
    return { code: error.code as StorageErrorCode, message: error.message };
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
    !['open', 'verify', 'read', 'write', 'close'].includes(
      request.method as string
    )
  ) {
    throw new Error('Unknown storage method');
  }
  if (request.method === 'write') {
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
  } else if (method === 'read') {
    if (value !== null && typeof value !== 'string')
      throw new Error('Invalid marker response');
  } else if (value !== undefined && value !== null) {
    throw new Error('Invalid storage response');
  }
  return value as StorageMethods[K]['result'];
}

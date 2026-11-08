import {
  parseResult,
  storageError,
  type ImportProgressMessage,
  type StorageError,
  type StorageMethod,
  type StorageMethods,
  type StorageResponse
} from './protocol';

type Pending = {
  method: StorageMethod;
  resolve: (result: unknown) => void;
  reject: (error: StorageError) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class BrowserStorageClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;
  // The worker runs one request at a time, so a request that arrives behind a
  // slow one can't start until it ends. Its deadline has to allow for that, or
  // an ordinary read would time out and terminate a healthy backup.
  private slowUntil = 0;
  private slowRequests = 0;
  /** Hears a running notes import, which reports between its batches. */
  onProgress?: (progress: ImportProgressMessage) => void;
  /** Called once when the worker stops, for whatever reason. */
  onClose?: () => void;

  constructor(
    createWorker = () =>
      new Worker(new URL('./sqlite.worker.ts', import.meta.url), {
        type: 'module'
      }),
    private timeoutMs = 30_000
  ) {
    this.worker = createWorker();
    this.worker.onmessage = (event: MessageEvent<StorageResponse>) => {
      const response = event.data;
      if (!response || typeof response !== 'object') return;
      if ('progress' in response) {
        this.onProgress?.(response.progress);
        return;
      }
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.ok === true) pending.resolve(response.result);
      else {
        const error = storageError(response.error);
        pending.reject(error);
        // A failed VFS installation may have acquired some OPFS handles.
        // Termination releases those before the caller creates a new worker.
        if (pending.method === 'open') this.fail(error);
      }
    };
    this.worker.onerror = (event) =>
      this.fail({
        code: 'worker',
        message: event.message || 'Storage worker failed'
      });
    this.worker.onmessageerror = () =>
      this.fail({
        code: 'worker',
        message: 'Storage worker returned an unreadable message'
      });
  }

  async request<K extends StorageMethod>(
    method: K,
    args: StorageMethods[K]['args'],
    timeoutMs = this.timeoutMs
  ): Promise<StorageMethods[K]['result']> {
    if (this.closed)
      throw { code: 'closed', message: 'Storage worker is closed' };
    const id = this.nextId++;
    const behind = Math.max(0, this.slowUntil - Date.now());
    const slow = timeoutMs > this.timeoutMs;
    if (slow) {
      this.slowRequests += 1;
      this.slowUntil = Date.now() + behind + timeoutMs;
    }
    try {
      const result = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            this.fail({
              code: 'timeout',
              message: 'Storage request timed out'
            }),
          behind + timeoutMs
        );
        this.pending.set(id, { method, resolve, reject, timer });
        try {
          this.worker.postMessage({ id, method, args });
        } catch (error) {
          this.fail(storageError(error));
        }
      });
      return parseResult(method, result);
    } finally {
      if (slow) {
        this.slowRequests -= 1;
        if (this.slowRequests === 0) this.slowUntil = 0;
      }
    }
  }

  // True once the worker has been terminated by an error, timeout, or close.
  // A closed client rejects every request, so callers must open a new one.
  get isClosed() {
    return this.closed;
  }

  async close() {
    try {
      await this.request('close', undefined);
    } finally {
      this.dispose();
    }
  }

  dispose() {
    this.fail({ code: 'closed', message: 'Storage worker is closed' });
  }

  private fail(error: StorageError) {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.onClose?.();
  }
}

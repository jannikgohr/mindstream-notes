import {
  parseResult,
  storageError,
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
    args: StorageMethods[K]['args']
  ): Promise<StorageMethods[K]['result']> {
    if (this.closed)
      throw { code: 'closed', message: 'Storage worker is closed' };
    const id = this.nextId++;
    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.fail({ code: 'timeout', message: 'Storage request timed out' }),
        this.timeoutMs
      );
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.worker.postMessage({ id, method, args });
      } catch (error) {
        this.fail(storageError(error));
      }
    });
    return parseResult(method, result);
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
  }
}

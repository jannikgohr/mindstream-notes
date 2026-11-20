/**
 * Runs the bundled Wasm plugins in one Worker per plugin, under the deadline
 * the app gives them.
 *
 * A Wasm call cannot be interrupted from outside, so an overrun terminates the
 * plugin's Worker, the way Wasmtime's epoch deadline stops the guest in the
 * app. Calls queued behind it are cancelled with it, and the next call starts
 * a fresh Worker. The deadline starts when the Worker has the component
 * loaded, so a slow first download does not count against the plugin.
 */

import type { HostCall } from './browser-host';
import {
  bundledTimeoutMs,
  type PluginRequest,
  type PluginResponse
} from './browser-runtime';

interface Pending {
  resolve(output: string): void;
  reject(error: Error): void;
  start(): void;
  timer?: ReturnType<typeof setTimeout>;
}

interface Running {
  worker: Worker;
  pending: Map<number, Pending>;
}

const workers = new Map<string, Running>();
let nextId = 1;

function spawn(pluginId: string): Running {
  const existing = workers.get(pluginId);
  if (existing) return existing;
  const running: Running = {
    worker: new Worker(new URL('./plugin-worker.ts', import.meta.url), {
      type: 'module'
    }),
    pending: new Map()
  };
  running.worker.onmessage = ({ data }: MessageEvent<PluginResponse>) => {
    const entry = running.pending.get(data.id);
    if (!entry) return;
    if ('started' in data) return entry.start();
    running.pending.delete(data.id);
    clearTimeout(entry.timer);
    if ('output' in data) entry.resolve(data.output);
    else entry.reject(new Error(data.error));
  };
  // A Worker that fails to load must not leave its callers waiting forever.
  running.worker.onerror = (event) =>
    kill(pluginId, `plugin worker failed: ${event.message}`);
  workers.set(pluginId, running);
  return running;
}

/** Terminate a plugin's Worker and reject everything it was carrying. */
function kill(pluginId: string, reason: string): void {
  const running = workers.get(pluginId);
  if (!running) return;
  workers.delete(pluginId);
  running.worker.terminate();
  for (const entry of running.pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
  }
}

/** Run one export of a bundled plugin with `input` and return its JSON result. */
export async function runBundledPlugin(
  exportName: string,
  input: unknown,
  call: HostCall
): Promise<unknown> {
  const { worker, pending } = spawn(call.pluginId);
  const id = nextId++;
  const request: PluginRequest = {
    id,
    exportName,
    input: JSON.stringify(input),
    call
  };
  const output = await new Promise<string>((resolve, reject) => {
    const entry: Pending = {
      resolve,
      reject,
      start() {
        entry.timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('script exceeded its time budget'));
          kill(call.pluginId, 'plugin call was cancelled');
        }, bundledTimeoutMs(call.pluginId));
      }
    };
    pending.set(id, entry);
    worker.postMessage(request);
  });
  return JSON.parse(output);
}

/** Terminate every plugin Worker. For tests. */
export function resetPluginRunner(): void {
  for (const pluginId of [...workers.keys()])
    kill(pluginId, 'plugin call was cancelled');
}

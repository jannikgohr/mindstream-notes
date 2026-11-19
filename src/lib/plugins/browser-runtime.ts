/**
 * The bundled Wasm plugins, run in a Worker for builds without the backend.
 *
 * `plugin-runner.ts` owns the Worker and its deadline; this module is what
 * runs inside it. Each call gets a fresh instance, as in the app. There is no
 * memory cap like Wasmtime's, which is acceptable only because these
 * components ship with the app.
 */

import { browserHostImports, type HostCall } from './browser-host';

type HostImports = ReturnType<typeof browserHostImports>;

/** What `scripts/browser/plugin-components.mjs` makes of a `.wasm?component`. */
interface PluginComponent {
  instantiate(
    getCoreModule: (name: string) => Promise<WebAssembly.Module>,
    imports: HostImports
  ): Promise<{ invoke(exportName: string, input: string): string }>;
  getCoreModule(name: string): Promise<WebAssembly.Module>;
  componentImports: string[];
}

interface BundledManifest {
  id?: unknown;
  runtime?: unknown;
  entry?: unknown;
  limits?: { timeoutMs?: unknown };
}

export interface PluginRequest {
  /** Correlates a reply with its request. */
  id: number;
  exportName: string;
  /** The input as JSON, which the component takes as is. */
  input: string;
  call: HostCall;
}

/**
 * `started` comes before the reply, once the component is loaded, so the
 * deadline counts the guest's own time and not the Worker's start-up.
 */
export type PluginResponse =
  | { id: number; started: true }
  | { id: number; output: string }
  | { id: number; error: string };

// Relative to this file, reaching the repo-root `plugins/` dir.
const manifests = import.meta.glob<BundledManifest>(
  '../../../plugins/*/manifest.json',
  { eager: true, import: 'default' }
);
const components = import.meta.glob<PluginComponent>(
  '../../../plugins/*/*.wasm',
  { query: '?component' }
);

const bundled = Object.entries(manifests).flatMap(([path, manifest]) => {
  if (manifest.runtime !== 'wasm' || typeof manifest.id !== 'string') return [];
  const entry = path.replace(/manifest\.json$/, String(manifest.entry));
  return entry in components
    ? [{ id: manifest.id, manifest, load: components[entry] }]
    : [];
});

/** Raw manifests of the bundled plugins the browser can run. */
export function bundledWasmManifests(): unknown[] {
  return bundled.map((plugin) => plugin.manifest);
}

/**
 * A plugin's `limits.timeoutMs`, clamped as the app's `limits::WASM` policy
 * does: 1 s by default, 50 ms to 5 s on request.
 */
export function bundledTimeoutMs(pluginId: string): number {
  const requested = bundled.find((plugin) => plugin.id === pluginId)?.manifest
    .limits?.timeoutMs;
  const ms = typeof requested === 'number' ? requested : 1000;
  return Math.min(Math.max(ms, 50), 5000);
}

/** The text of a `ComponentError` or a thrown value, as the user sees it. */
function failure(error: unknown): string {
  if (error && typeof error === 'object' && 'payload' in error)
    return String(error.payload);
  return error instanceof Error ? error.message : String(error);
}

async function invoke(
  { id, exportName, input, call }: PluginRequest,
  post: (response: PluginResponse) => void
) {
  const plugin = bundled.find((candidate) => candidate.id === call.pluginId);
  if (!plugin)
    throw new Error('scripted plugins are only available in the app');
  const component = await plugin.load();
  const imports = browserHostImports(call);
  const missing = component.componentImports.filter(
    (name) => !(name in imports)
  );
  if (missing.length > 0)
    throw new Error(
      `plugin "${call.pluginId}" imports ${missing.join(', ')}, which the browser does not provide`
    );
  post({ id, started: true });
  const instance = await component.instantiate(
    component.getCoreModule,
    imports
  );
  return instance.invoke(exportName, input);
}

let queue = Promise.resolve();

/**
 * Run one export of a bundled plugin and `post` its JSON result. Requests run
 * one at a time, so a call's `started` waits until the call before it is done
 * and its deadline never covers another call's work.
 */
export function handlePluginRequest(
  request: PluginRequest,
  post: (response: PluginResponse) => void
): Promise<void> {
  queue = queue.then(async () => {
    try {
      post({ id: request.id, output: await invoke(request, post) });
    } catch (error) {
      post({ id: request.id, error: failure(error) });
    }
  });
  return queue;
}

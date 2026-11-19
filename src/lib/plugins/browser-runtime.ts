/**
 * The bundled Wasm plugins, run in the page for builds without the backend.
 *
 * Each call gets a fresh instance, as in the app. Unlike Wasmtime, the page
 * enforces no `limits.timeoutMs` or memory cap, which is acceptable only
 * because these components ship with the app.
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
}

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

/** The text of a `ComponentError` or a thrown value, as the user sees it. */
function failure(error: unknown): string {
  if (error && typeof error === 'object' && 'payload' in error)
    return String(error.payload);
  return error instanceof Error ? error.message : String(error);
}

/** Run one export of a bundled plugin with `input` and return its JSON result. */
export async function invokeBundledPlugin(
  exportName: string,
  input: unknown,
  call: HostCall
): Promise<unknown> {
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
  const instance = await component.instantiate(
    component.getCoreModule,
    imports
  );
  let output: string;
  try {
    output = instance.invoke(exportName, JSON.stringify(input));
  } catch (error) {
    throw new Error(failure(error), { cause: error });
  }
  return JSON.parse(output);
}

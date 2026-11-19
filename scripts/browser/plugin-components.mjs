import { readFile } from 'node:fs/promises';

const QUERY = '?component';
// jco's default loader for core modules. Vite would turn its `new URL` into an
// asset glob over the plugin's folder, and the caller always passes its own.
const FETCH_FALLBACK =
  /getCoreModule = \(name\) => fetchCompile\(new URL\(`\.\/\$\{name\}`, import\.meta\.url\)\);/;

/**
 * Import a plugin's Wasm component as JavaScript: `plugin.wasm?component`.
 *
 * jco transpiles the component into bindings plus core modules. The core
 * modules are inlined as base64 so the same module works in dev, the static
 * build and Vitest. The module exports `instantiate(getCoreModule, imports)`
 * from jco, the compiled core modules, and the interfaces the component imports.
 *
 * @returns {import('vite').Plugin}
 */
export function pluginComponents() {
  return {
    name: 'plugin-components',
    enforce: 'pre',
    async load(id) {
      if (!id.endsWith(`.wasm${QUERY}`)) return null;
      const path = id.slice(0, -QUERY.length);
      this.addWatchFile(path);
      const { transpileBytes } =
        await import('@bytecodealliance/jco-transpile');
      const { files, imports } = await transpileBytes(
        new Uint8Array(await readFile(path)),
        {
          name: 'plugin',
          instantiation: 'async',
          nodejsCompat: false,
          emitTypescriptDeclarations: false
        }
      );
      /** @type {Record<string, string>} */
      const core = {};
      for (const [name, bytes] of Object.entries(files)) {
        if (name.endsWith('.wasm'))
          core[name] = Buffer.from(bytes).toString('base64');
      }
      const bindings = new TextDecoder()
        .decode(files['plugin.js'])
        .replace(/^"use components";\n/, '')
        .replace(
          FETCH_FALLBACK,
          'throw new TypeError("getCoreModule is required");'
        );
      if (bindings.includes('import.meta'))
        throw new Error(
          `${path}: jco bindings changed shape; update ${import.meta.url}`
        );
      return `${bindings}
const core = ${JSON.stringify(core)};
const compiled = new Map();
export function getCoreModule(name) {
  let module = compiled.get(name);
  if (!module) {
    const bytes = Uint8Array.from(atob(core[name]), (c) => c.charCodeAt(0));
    module = WebAssembly.compile(bytes);
    compiled.set(name, module);
  }
  return module;
}
export const componentImports = ${JSON.stringify(imports)};
`;
    }
  };
}

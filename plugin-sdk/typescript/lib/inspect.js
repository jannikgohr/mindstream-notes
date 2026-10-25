// Reading what a built component imports and exports.

import { componentWit } from '@bytecodealliance/jco-transpile/wasm-tools';
import { IMPORT_PREFIX } from './wit.js';

/**
 * The imports and exports of a component's root world.
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<{ imports: string[], exports: string[] }>}
 */
export async function componentInterface(bytes) {
  const wit = await componentWit(bytes);
  const world = wit.slice(0, wit.indexOf('}') + 1);
  const imports = [
    ...world.matchAll(/^\s*import\s+([^;:]+:[^;]+?|[^;]+?);/gm)
  ].map((m) => m[1].trim());
  const exports = [...world.matchAll(/^\s*export\s+(%?[\w-]+)/gm)].map((m) =>
    m[1].replace(/^%/, '')
  );
  return { imports, exports };
}

/**
 * Throw unless the component imports only `mindstream:plugin` interfaces
 * and exports `invoke`. The app refuses anything else before it runs.
 *
 * @param {Uint8Array} bytes
 */
export async function assertPluginComponent(bytes) {
  const { imports, exports } = await componentInterface(bytes);
  const foreign = imports.filter((name) => !name.startsWith(IMPORT_PREFIX));
  if (foreign.length > 0) {
    throw new Error(
      `the component imports ${foreign.join(', ')}, which Mindstream does not provide`
    );
  }
  if (!exports.includes('invoke')) {
    throw new Error('the component does not export `invoke`');
  }
}

// TypeScript or JavaScript source to a Mindstream plugin component.
//
// Two steps: esbuild bundles the entry module and everything it imports into
// one ES module, then componentize-qjs embeds it in the QuickJS engine and
// snapshots the initialized state. WASI is stubbed out, so the component
// imports nothing but the mindstream:plugin interfaces.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPluginComponent } from './inspect.js';
import { WORLD, witDir } from './wit.js';

// The guest library is always this SDK's own, whatever the project has
// installed: the build tool and the code it embeds then cannot disagree on
// the host interfaces.
const sdkEntry = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'index.ts'
);

/**
 * Bundle `source` into one ES module, as a string.
 *
 * @param {string} source path to the entry module
 * @param {{ minify?: boolean }} [options]
 */
export async function bundle(source, options = {}) {
  const esbuild = await import('esbuild');
  const result = await esbuild.build({
    entryPoints: [source],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: 'es2023',
    mainFields: ['module', 'main'],
    conditions: ['import', 'default'],
    external: ['mindstream:*'],
    alias: { '@mindstream/plugin-sdk': sdkEntry },
    minify: options.minify ?? false,
    legalComments: 'none',
    logLevel: 'silent'
  });
  return result.outputFiles[0].text;
}

/**
 * Build a component from an entry module.
 *
 * @param {object} options
 * @param {string} options.source entry module (`.ts` or `.js`)
 * @param {string} [options.out] where to write the component
 * @param {boolean} [options.optSize] the smaller QuickJS build (default true)
 * @param {boolean} [options.minify] minify the bundled JavaScript
 * @returns {Promise<Uint8Array>} the component
 */
export async function buildComponent(options) {
  const jsSource = await bundle(options.source, { minify: options.minify });
  const { componentize } = await import('componentize-qjs');
  const { component } = await componentize({
    witPath: witDir(),
    jsSource,
    world: WORLD,
    stubWasi: true,
    sync: true,
    optSize: options.optSize ?? true
  });
  const bytes = new Uint8Array(component);
  await assertPluginComponent(bytes);
  if (options.out) {
    await mkdir(dirname(options.out), { recursive: true });
    await writeFile(options.out, bytes);
  }
  return bytes;
}

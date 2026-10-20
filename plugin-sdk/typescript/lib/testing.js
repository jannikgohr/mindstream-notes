// Run a built plugin component in Node, against an in-memory host.
//
//   import { loadPlugin } from '@mindstream/plugin-sdk/testing';
//   const plugin = await loadPlugin('dist/package/plugin.wasm', {
//     permissions: ['notes.read'],
//     notes: [{ id: 'n1', title: 'Daily', tags: ['template'] }]
//   });
//   const effect = await plugin.call('newFromTemplate', { settings: {} });
//
// The component is the exact file the app would run. jco-transpile turns it
// into JavaScript plus its core modules; each call gets a fresh instance, as
// in the app, so state never carries from one call to the next.

import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMockHost } from './mock-host.js';

/** The probe export the SDK's `definePlugin` answers with its export names. */
export const EXPORTS_PROBE = '$exports';

/** A call the plugin answered with an error, or a crash inside it. */
export class PluginCallError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'PluginCallError';
  }
}

/**
 * `input` with the context merged in the way the app merges it: the window's
 * fields are defaults the caller may override, and the backend's `settings`,
 * `folders` and `now` win over anything the caller passed.
 */
function withContext(input, options) {
  const isObject = input && typeof input === 'object' && !Array.isArray(input);
  const notesRead = (options.permissions ?? []).includes('notes.read');
  return {
    ...(isObject
      ? { activeNoteId: null, locale: options.locale ?? 'en', ...input }
      : {}),
    settings: options.settings ?? {},
    folders: notesRead ? (options.folders ?? []) : [],
    now:
      options.now === undefined
        ? new Date().toISOString()
        : new Date(options.now).toISOString()
  };
}

/**
 * Load a component for testing.
 *
 * @param {string | Uint8Array} component path to, or bytes of, a `.wasm`
 * @param {import('./testing.js').HostOptions} [options]
 */
export async function loadPlugin(component, options = {}) {
  const bytes =
    typeof component === 'string'
      ? new Uint8Array(await readFile(component))
      : component;
  const { transpileBytes } = await import('@bytecodealliance/jco-transpile');
  const { files } = await transpileBytes(bytes, {
    name: 'plugin',
    instantiation: 'async'
  });
  const dir = await mkdtemp(join(tmpdir(), 'mindstream-plugin-'));
  const modules = new Map();
  try {
    // Generated bindings are ES modules, including outside a workspace.
    await writeFile(join(dir, 'package.json'), '{"type":"module"}\n');
    for (const [name, contents] of Object.entries(files)) {
      if (name.endsWith('.wasm')) {
        modules.set(name, await WebAssembly.compile(contents));
      } else if (name.endsWith('.js')) {
        await mkdir(dirname(join(dir, name)), { recursive: true });
        await writeFile(join(dir, name), contents);
      }
    }
    const bindings = await import(pathToFileURL(join(dir, 'plugin.js')).href);
    const host = createMockHost(options);

    /** Run one export with `input` merged over the backend's context. */
    async function call(exportName, input = {}) {
      const instance = await bindings.instantiate(
        (name) => modules.get(name),
        host.imports
      );
      let output;
      try {
        output = instance.invoke(
          exportName,
          JSON.stringify(withContext(input, options))
        );
      } catch (error) {
        const detail = error?.payload ?? error?.message ?? String(error);
        throw new PluginCallError(String(detail), error);
      }
      return JSON.parse(output);
    }

    return {
      call,
      /** The export names the plugin defines. */
      exports: () => call(EXPORTS_PROBE, {}),
      /** Lines the plugin logged, oldest first. */
      logs: host.logs,
      /** The in-memory storage, path to contents. */
      storage: host.storage
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// A preflight for a plugin folder, before it is installed.
//
// The app validates every manifest itself when it loads it, and that is the
// check that counts. This one catches the common mistakes earlier, with the
// component at hand: a manifest export the plugin does not define, a missing
// asset, an import the app would refuse.

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { assertPluginComponent } from './inspect.js';
import {
  isComponentEntry,
  isSafeRelativePath,
  referencedFiles
} from './package.js';
import { loadPlugin } from './testing.js';

export const KNOWN_PERMISSIONS = [
  'notes.read',
  'notes.create',
  'textCheckers.contribute',
  'pluginArtifacts.download',
  'pluginStorage.read',
  'pluginStorage.write',
  'nativeTools.runDeclared',
  'nativeServices.run'
];

/** The app's plugin id rule: dotted, lowercase, at least two segments. */
export function isValidPluginId(id) {
  if (typeof id !== 'string' || id.length > 200) return false;
  const segments = id.split('.');
  return (
    segments.length >= 2 &&
    segments.every((s) => /^[a-z0-9][a-z0-9-]*$/.test(s))
  );
}

/** Every export name a manifest's contributions call. */
export function referencedExports(manifest) {
  const c = manifest.contributes ?? {};
  const names = new Set();
  for (const button of c.toolbar ?? []) {
    if (button.action?.type === 'script') names.add(button.action.export);
  }
  for (const kind of c.noteKinds ?? []) names.add(kind.render?.export);
  for (const exporter of c.noteExporters ?? []) names.add(exporter.export);
  for (const template of c.noteTemplates ?? []) names.add(template.render);
  names.delete(undefined);
  return [...names];
}

const MAX_COMPONENT_BYTES = 32 * 1024 * 1024;

/**
 * Check a plugin folder. Returns the problems found; empty means it passed.
 *
 * @param {string} dir a folder holding manifest.json and its entry
 * @returns {Promise<string[]>}
 */
export async function checkPackage(dir) {
  const problems = [];
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  } catch (error) {
    return [`manifest.json: ${error.message}`];
  }
  if (manifest.manifestVersion !== 2) {
    problems.push('manifestVersion must be 2 for a wasm plugin');
  }
  if (manifest.runtime !== 'wasm') {
    problems.push(
      `runtime must be "wasm", not ${JSON.stringify(manifest.runtime)}`
    );
  }
  if (!isValidPluginId(manifest.id)) {
    problems.push(
      `id ${JSON.stringify(manifest.id)} must be dotted and lowercase, like com.example.my-plugin`
    );
  }
  for (const field of ['name', 'version']) {
    if (typeof manifest[field] !== 'string' || manifest[field].trim() === '') {
      problems.push(`${field} must be a non-empty string`);
    }
  }
  for (const permission of manifest.permissions ?? []) {
    if (!KNOWN_PERMISSIONS.includes(permission)) {
      problems.push(`unknown permission "${permission}"`);
    }
  }
  for (const file of referencedFiles(manifest)) {
    if (!isSafeRelativePath(file)) {
      problems.push(`manifest refers to an unsafe path "${file}"`);
      continue;
    }
    try {
      if (!(await stat(join(dir, file))).isFile())
        throw new Error('not a file');
    } catch {
      problems.push(
        `the manifest refers to "${file}", which is not in the folder`
      );
    }
  }
  if (!isComponentEntry(manifest.entry)) {
    problems.push('entry must be a plain .wasm file name inside the folder');
    return problems;
  }
  let bytes;
  try {
    bytes = new Uint8Array(await readFile(join(dir, manifest.entry)));
  } catch {
    problems.push(
      `the entry "${manifest.entry}" is missing; run the build first`
    );
    return problems;
  }
  if (bytes.length > MAX_COMPONENT_BYTES) {
    problems.push(
      `the component is ${bytes.length} bytes, more than the app accepts (${MAX_COMPONENT_BYTES})`
    );
  }
  try {
    await assertPluginComponent(bytes);
  } catch (error) {
    problems.push(error.message);
    return problems;
  }
  const wanted = referencedExports(manifest);
  if (wanted.length > 0) {
    let defined;
    try {
      const plugin = await loadPlugin(bytes, {
        permissions: manifest.permissions
      });
      defined = await plugin.exports();
    } catch (error) {
      problems.push(
        `could not ask the component for its exports (${error.message}); was it built with definePlugin?`
      );
      return problems;
    }
    for (const name of wanted) {
      if (!defined.includes(name)) {
        problems.push(
          `the manifest calls export "${name}", which the plugin does not define (it defines: ${defined.join(', ')})`
        );
      }
    }
  }
  return problems;
}

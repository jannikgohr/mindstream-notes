// A new plugin project from the starter template.

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidPluginId } from './check.js';

const here = dirname(fileURLToPath(import.meta.url));
const template = join(here, '..', 'templates', 'starter');

async function sdkVersion() {
  const pkg = JSON.parse(
    await readFile(join(here, '..', 'package.json'), 'utf8')
  );
  return pkg.version;
}

async function* walk(dir, base = dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path, base);
    else yield path.slice(base.length + 1);
  }
}

/** A plugin id from a project directory name, for when none is given. */
function idFrom(name) {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'plugin';
  return `com.example.${slug}`;
}

/**
 * Write a new project into `target`, which must not exist or be empty.
 *
 * @param {string} target
 * @param {{ id?: string, name?: string, sdk?: string }} [options]
 * @returns {Promise<string[]>} the files written
 */
export async function createProject(target, options = {}) {
  const dir = resolve(target);
  try {
    if ((await readdir(dir)).length > 0) {
      throw new Error(`${dir} is not empty`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const folder = basename(dir);
  const id = options.id ?? idFrom(folder);
  if (!isValidPluginId(id)) {
    throw new Error(
      `"${id}" is not a valid plugin id; use a dotted, lowercase id like com.example.my-plugin`
    );
  }
  const values = {
    id,
    name: options.name ?? folder,
    packageName: folder.toLowerCase().replace(/[^a-z0-9-._~]+/g, '-'),
    sdkSpec: options.sdk ?? `^${await sdkVersion()}`
  };
  const written = [];
  for await (const rel of walk(template)) {
    const from = join(template, rel);
    // npm drops a package's .gitignore, so the template carries it renamed.
    const to = join(dir, rel === '_gitignore' ? '.gitignore' : rel);
    await mkdir(dirname(to), { recursive: true });
    const isText = !(await stat(from)).isDirectory() && !rel.endsWith('.wasm');
    let contents = await readFile(from, isText ? 'utf8' : undefined);
    if (isText) {
      contents = contents.replace(
        /\{\{(id|name|packageName|sdkSpec)\}\}/g,
        (_, key) =>
          rel.endsWith('.json')
            ? JSON.stringify(values[key]).slice(1, -1)
            : values[key]
      );
    }
    await writeFile(to, contents);
    written.push(
      rel === '_gitignore' ? '.gitignore' : rel.replaceAll('\\', '/')
    );
  }
  return written.sort();
}

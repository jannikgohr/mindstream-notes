// Assembling an installable plugin folder: the manifest, the component, and
// the files the manifest points at. Settings → Plugins → "Install or update
// from folder" takes the result as it is.

import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve
} from 'node:path';

/** Package paths use forward slashes and stay beneath the package root. */
export function isSafeRelativePath(path) {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    !path.includes('\\') &&
    !path.includes(':') &&
    !path.includes('\0') &&
    !isAbsolute(path) &&
    path
      .split('/')
      .every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

export function isComponentEntry(path) {
  return (
    isSafeRelativePath(path) &&
    !path.includes('..') &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*\.wasm$/.test(path)
  );
}

async function containedFile(root, file) {
  if (!isSafeRelativePath(file))
    throw new Error(`manifest refers to an unsafe path "${file}"`);
  const base = await realpath(root);
  const target = await realpath(join(root, file));
  const rel = relative(base, target);
  if (
    rel === '..' ||
    rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(rel)
  ) {
    throw new Error(`manifest path "${file}" escapes the plugin folder`);
  }
  if (!(await stat(target)).isFile())
    throw new Error(`manifest path "${file}" is not a file`);
  return target;
}

async function canonicalPath(path) {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return join(await canonicalPath(dirname(absolute)), basename(absolute));
  }
}

/** Every bundled file a manifest refers to, relative to the plugin root. */
export function referencedFiles(manifest) {
  const out = new Set();
  const add = (path) => {
    if (typeof path === 'string' && path !== '') out.add(path);
  };
  add(manifest.icon);
  const c = manifest.contributes ?? {};
  for (const doc of c.documentation ?? []) add(doc.file);
  for (const button of c.toolbar ?? []) add(button.icon);
  for (const kind of c.noteKinds ?? []) {
    add(kind.icon);
    add(kind.render?.webview?.entry);
  }
  for (const service of c.nativeServices ?? []) add(service.previewIframe?.css);
  return [...out];
}

/**
 * Locale variants of a documentation file: `docs/guide.md` brings
 * `docs/guide.de.md` and any other `docs/guide.<locale>.md` beside it.
 */
async function localeVariants(root, file) {
  if (!file.endsWith('.md')) return [];
  const dir = dirname(join(root, file));
  const stem = basename(file, '.md');
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  return names
    .filter(
      (n) => n.startsWith(`${stem}.`) && n.endsWith('.md') && n !== `${stem}.md`
    )
    .filter((n) =>
      /^[a-z]{2}(-[A-Za-z]{2})?$/.test(n.slice(stem.length + 1, -3))
    )
    .map((n) => relative(root, join(dir, n)).split('\\').join('/'));
}

/**
 * Write `out` as a fresh plugin folder.
 *
 * @param {object} options
 * @param {string} options.root the project directory, holding manifest.json
 * @param {string} options.component the built component
 * @param {string} options.out the folder to create (replaced if present)
 * @returns {Promise<string[]>} the files written, relative to `out`
 */
export async function packagePlugin({ root, component, out }) {
  const manifest = JSON.parse(
    await readFile(join(root, 'manifest.json'), 'utf8')
  );
  if (!isComponentEntry(manifest.entry)) {
    throw new Error('entry must be a plain .wasm file name inside the folder');
  }
  // A typo in --out must not delete the project, its component, or an ancestor.
  const destination = await canonicalPath(out);
  const insideOutput = (path) => {
    const rel = relative(destination, path);
    return (
      rel === '' ||
      (!isAbsolute(rel) &&
        rel !== '..' &&
        !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')))
    );
  };
  if (
    insideOutput(await realpath(root)) ||
    insideOutput(await realpath(component))
  ) {
    throw new Error(
      'the package output must not contain the project or built component'
    );
  }
  // Validate every input before replacing a previous package.
  const files = referencedFiles(manifest);
  for (const file of [...files]) {
    if (!isSafeRelativePath(file))
      throw new Error(`manifest refers to an unsafe path "${file}"`);
    files.push(...(await localeVariants(root, file)));
  }
  const sources = await Promise.all(
    [...new Set(files)].map(async (file) => [
      file,
      await containedFile(root, file)
    ])
  );
  if (sources.some(([, from]) => insideOutput(from))) {
    throw new Error('the package output must not contain referenced assets');
  }
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const written = ['manifest.json', manifest.entry];
  await copyFile(join(root, 'manifest.json'), join(out, 'manifest.json'));
  await copyFile(component, join(out, manifest.entry));
  for (const [file, from] of sources) {
    await mkdir(dirname(join(out, file)), { recursive: true });
    await copyFile(from, join(out, file));
    written.push(file);
  }
  return written;
}

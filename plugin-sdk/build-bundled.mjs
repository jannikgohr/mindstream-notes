// Rebuild shipped Rust plugins. TypeScript examples have a separate Node-only build.
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, dirname, relative, sep, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { componentNew } from '@bytecodealliance/jco-transpile/wasm-tools';
import { checkPackage } from './typescript/lib/check.js';

const root = join(import.meta.dirname, '..');
const workspace = join(import.meta.dirname, 'bundled');
function cargo(args, flags = []) {
  const result = spawnSync('cargo', args, {
    cwd: workspace,
    env: {
      ...process.env,
      RUSTFLAGS: '',
      CARGO_ENCODED_RUSTFLAGS: flags.join('\x1f')
    },
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`cargo exited with ${result.status}`);
}
const build = [
  'build',
  '--locked',
  '--release',
  '--target',
  'wasm32-unknown-unknown',
  '--workspace'
];
const corePath = (name) =>
  join(
    workspace,
    'target/wasm32-unknown-unknown/release',
    `mindstream_${name}_plugin.wasm`
  );
cargo(build);
// Panic locations survive stripping. Remap complete filenames, including
// dependency paths and Windows separators, to stable platform-neutral names.
const metadata = spawnSync(
  'cargo',
  ['metadata', '--locked', '--format-version=1'],
  { cwd: workspace, encoding: 'utf8' }
);
if (metadata.error) throw metadata.error;
if (metadata.status !== 0) throw new Error(metadata.stderr);
const initial = Buffer.concat(
  await Promise.all(
    ['templates', 'typst'].map((name) => readFile(corePath(name)))
  )
);
async function* rustFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !['target', '.git'].includes(entry.name))
      yield* rustFiles(join(dir, entry.name));
    else if (entry.isFile() && entry.name.endsWith('.rs'))
      yield join(dir, entry.name);
  }
}
const remaps = new Map();
for (const pkg of JSON.parse(metadata.stdout).packages) {
  const dir = dirname(pkg.manifest_path);
  for await (const file of rustFiles(dir)) {
    const local = relative(workspace, file);
    const inWorkspace = !local.startsWith('..') && !isAbsolute(local);
    const canonical = inWorkspace
      ? `/mindstream/plugins/${local.split(sep).join('/')}`
      : `/mindstream/deps/${pkg.name}-${pkg.version}/${relative(dir, file).split(sep).join('/')}`;
    for (const path of [
      file,
      local,
      file.split(sep).join('/'),
      local.split(sep).join('/')
    ]) {
      if (initial.includes(Buffer.from(path))) remaps.set(path, canonical);
    }
  }
}
cargo(
  build,
  [...remaps]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([from, to]) => `--remap-path-prefix=${from}=${to}`)
);
const artifacts = [];
for (const name of ['templates', 'typst']) {
  const dir = join(root, 'plugins', name);
  const manifest = JSON.parse(
    await readFile(join(dir, 'manifest.json'), 'utf8')
  );
  const bytes = await componentNew(await readFile(corePath(name)), []);
  await writeFile(join(dir, manifest.entry), bytes);
  const problems = await checkPackage(dir);
  if (problems.length) throw new Error(`${name}: ${problems.join('; ')}`);
  artifacts.push({
    name,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex')
  });
  console.log(`${name}: ${bytes.length} bytes, package check passed`);
}
await writeFile(
  join(workspace, 'target/components.json'),
  JSON.stringify(artifacts, null, 2) + '\n'
);

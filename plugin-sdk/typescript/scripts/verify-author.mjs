// Run with `npm run test:plugin-author` from the repository root. Exercise the
// packed SDK outside the workspace, with Rust toolchain directories removed.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

const npm = process.env.npm_execpath;
if (!npm || !/npm-cli\.js$/.test(npm)) {
  throw new Error('run this check through npm run test:plugin-author');
}
const pathKey =
  Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ??
  'PATH';
const env = { ...process.env };
env[pathKey] = (env[pathKey] ?? '')
  .split(delimiter)
  .filter(
    (dir) =>
      !['cargo', 'rustc', 'cargo.exe', 'rustc.exe'].some((name) =>
        existsSync(join(dir, name))
      )
  )
  .join(delimiter);
for (const command of ['cargo', 'rustc']) {
  if (!spawnSync(command, ['--version'], { env }).error) {
    throw new Error(`${command} is still available in the author environment`);
  }
}
function run(cwd, args) {
  const result = spawnSync(process.execPath, [npm, ...args], {
    cwd,
    env,
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`npm ${args.join(' ')} failed (${result.status})`);
}
const root = resolve(import.meta.dirname, '../../..');
const work = await mkdtemp(join(tmpdir(), 'mindstream-author-'));
try {
  run(root, ['pack', './plugin-sdk/typescript', '--pack-destination', work]);
  const tarball = join(
    work,
    (await readdir(work)).find((file) => file.endsWith('.tgz'))
  );
  const project = join(work, 'my-plugin');
  run(work, [
    'exec',
    '--yes',
    '--package',
    tarball,
    '--',
    'mindstream-plugin',
    'create',
    project,
    '--id',
    'com.example.author-check',
    '--sdk',
    tarball
  ]);
  run(project, ['install', '--no-audit', '--no-fund']);
  for (const script of ['typecheck', 'build', 'check', 'test'])
    run(project, ['run', script]);
  console.log('Packed SDK authoring check passed without Cargo or rustc.');
} finally {
  await rm(work, { recursive: true, force: true });
}

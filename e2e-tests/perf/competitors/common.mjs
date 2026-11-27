/**
 * What the competitor benches share: the pinned apps, the vault to import
 * and where results go. See README.md.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const root = fileURLToPath(new URL('../../../', import.meta.url));
export const cache = join(homedir(), '.cache', 'mindstream-perf');

// Pinned so two runs compare. Moving to a new release is a deliberate
// change: update the version, URL and checksum together.
const APPS = {
  obsidian: {
    version: '1.15.1',
    url: 'https://github.com/obsidianmd/obsidian-releases/releases/download/v1.15.1/Obsidian-1.15.1.AppImage',
    sha256: '515ff49bb263d08841069adc46002dae94562e5041fb7762b3a1dcb7be10a51a',
    bin: 'obsidian'
  },
  joplin: {
    version: '3.7.24',
    url: 'https://github.com/laurent22/joplin/releases/download/v3.7.24/Joplin-3.7.24.AppImage',
    sha256: '64d544b8c865b53d975d1cc9438300465be860dfd9b6c7d4bb6f66a9f3777584',
    bin: 'joplin'
  },
  logseq: {
    version: '2.0.2',
    url: 'https://github.com/logseq/logseq/releases/download/2.0.2/Logseq-linux-x86_64-2.0.2.AppImage',
    sha256: '1335725626f6cbfbf3b00b7743a60356d2d7dad123cf00bbf974a9beef556870',
    bin: 'logseq'
  }
};

export const log = (...args) =>
  console.error(`[${new Date().toISOString().slice(11, 19)}]`, ...args);

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'inherit']
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0
        ? resolve(output)
        : reject(new Error(`${command} ${args.join(' ')} exited with ${code}`))
    );
  });
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * The app's executable, downloaded and unpacked on first use. The AppImage
 * is extracted rather than mounted, so no FUSE is needed.
 */
export async function app(name) {
  const { version, url, sha256: expected, bin } = APPS[name];
  const dir = join(cache, 'apps', `${name}-${version}`);
  const exe = join(dir, 'squashfs-root', bin);
  if (existsSync(exe)) return { exe, version };
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const image = join(dir, `${name}.AppImage`);
  log(`downloading ${name} ${version}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  await writeFile(image, Buffer.from(await response.arrayBuffer()));
  const actual = await sha256(image);
  if (actual !== expected)
    throw new Error(
      `${name} ${version}: sha256 ${actual}, expected ${expected}`
    );
  await chmod(image, 0o755);
  await run(image, ['--appimage-extract'], dir);
  await rm(image);
  return { exe, version };
}

/**
 * Parses the shared flags and resolves the vault: --small for the 28-note
 * fixture, otherwise the Wikipedia vault with --articles notes. `options`
 * adds an app's own flags.
 */
export async function setup(options = {}) {
  const { values } = parseArgs({
    options: {
      small: { type: 'boolean', default: false },
      articles: { type: 'string', default: '20000' },
      runs: { type: 'string', default: '3' },
      settle: { type: 'string', default: '300' },
      json: { type: 'string' },
      ...options
    }
  });
  const vault = values.small
    ? join(root, 'e2e-tests/perf/fixtures/small-vault')
    : (
        await run(
          process.execPath,
          [
            join(root, 'e2e-tests/perf/wikipedia/make-vault.mjs'),
            '--articles',
            values.articles
          ],
          root
        )
      ).trim();
  return {
    values,
    vault,
    label: values.small ? 'small' : values.articles,
    query: values.small ? 'lisbon' : 'europe'
  };
}

/** Writes `results` to --json, or to .output/bench/competitors/. */
export async function save(results, values, name) {
  const file =
    values.json ??
    join(root, '.output', 'bench', 'competitors', `${name}.json`);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, JSON.stringify(results, null, 2));
  log('saved', file);
}

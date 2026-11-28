/**
 * What the competitor benches share: the pinned apps, the vault to import
 * and where results go. See README.md.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { chmod, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const root = fileURLToPath(new URL('../../../', import.meta.url));
export const cache = join(homedir(), '.cache', 'mindstream-perf');

// Pinned so two runs compare. Moving to a new release is a deliberate
// change: update the version, URLs and checksums together. On Windows the
// apps come as NSIS installers or a zip, which 7-Zip unpacks.
const GITHUB = 'https://github.com';
const APPS = {
  obsidian: {
    version: '1.15.1',
    linux: {
      url: `${GITHUB}/obsidianmd/obsidian-releases/releases/download/v1.15.1/Obsidian-1.15.1.AppImage`,
      sha256:
        '515ff49bb263d08841069adc46002dae94562e5041fb7762b3a1dcb7be10a51a',
      bin: 'squashfs-root/obsidian'
    },
    win32: {
      url: `${GITHUB}/obsidianmd/obsidian-releases/releases/download/v1.15.1/Obsidian-1.15.1.exe`,
      sha256:
        '218c7d30acc065355ce94719dd996d5e2a2347cde3811ea5dc29380583f02b58',
      bin: 'app/Obsidian.exe'
    }
  },
  joplin: {
    version: '3.7.24',
    linux: {
      url: `${GITHUB}/laurent22/joplin/releases/download/v3.7.24/Joplin-3.7.24.AppImage`,
      sha256:
        '64d544b8c865b53d975d1cc9438300465be860dfd9b6c7d4bb6f66a9f3777584',
      bin: 'squashfs-root/joplin'
    },
    win32: {
      url: `${GITHUB}/laurent22/joplin/releases/download/v3.7.24/Joplin-Setup-3.7.24.exe`,
      sha256:
        '9b528527bf24c4657c35052309437d2798c2ab38f80e32b66f0dedb8daeb3ec9',
      bin: 'app/Joplin.exe'
    }
  },
  logseq: {
    version: '2.0.2',
    linux: {
      url: `${GITHUB}/logseq/logseq/releases/download/2.0.2/Logseq-linux-x86_64-2.0.2.AppImage`,
      sha256:
        '1335725626f6cbfbf3b00b7743a60356d2d7dad123cf00bbf974a9beef556870',
      bin: 'squashfs-root/logseq'
    },
    win32: {
      url: `${GITHUB}/logseq/logseq/releases/download/2.0.2/Logseq-win-x64-2.0.2.zip`,
      sha256:
        '3332383c730bf8c0bd6bda9d5c60b669399f3ce9a1bee688dda12bfaaa5457db',
      bin: 'app/Logseq.exe'
    }
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

const SEVEN_ZIP = 'C:/Program Files/7-Zip/7z.exe';

/**
 * Unpacks a Windows download into `dir/app`. An NSIS installer holds the
 * app as $PLUGINSDIR/app-64.7z; a zip holds it directly or in one folder.
 */
async function unpackWindows(file, dir) {
  const app = join(dir, 'app');
  if (file.endsWith('.zip')) {
    const raw = join(dir, 'raw');
    await run(SEVEN_ZIP, ['x', '-y', `-o${raw}`, file], dir);
    const entries = await readdir(raw);
    await rename(entries.length === 1 ? join(raw, entries[0]) : raw, app);
    await rm(raw, { recursive: true, force: true });
    return;
  }
  const installer = join(dir, 'installer');
  await run(
    SEVEN_ZIP,
    ['x', '-y', `-o${installer}`, file, '$PLUGINSDIR/app-64.7z'],
    dir
  );
  await run(
    SEVEN_ZIP,
    ['x', '-y', `-o${app}`, join(installer, '$PLUGINSDIR', 'app-64.7z')],
    dir
  );
  await rm(installer, { recursive: true, force: true });
}

/**
 * The app's executable, downloaded and unpacked on first use. An AppImage
 * is extracted rather than mounted, so no FUSE is needed. Nothing is
 * installed: the apps run from the cache.
 */
export async function app(name) {
  const { version, [process.platform]: build } = APPS[name];
  if (!build) throw new Error(`${name}: no build for ${process.platform}`);
  const dir = join(cache, 'apps', `${name}-${version}`);
  const exe = join(dir, build.bin);
  if (existsSync(exe)) return { exe, version };
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const download = join(dir, build.url.split('/').pop());
  log(`downloading ${name} ${version}`);
  const response = await fetch(build.url);
  if (!response.ok) throw new Error(`${build.url}: ${response.status}`);
  await writeFile(download, Buffer.from(await response.arrayBuffer()));
  const actual = await sha256(download);
  if (actual !== build.sha256)
    throw new Error(
      `${name} ${version}: sha256 ${actual}, expected ${build.sha256}`
    );
  if (process.platform === 'win32') await unpackWindows(download, dir);
  else {
    await chmod(download, 0o755);
    await run(download, ['--appimage-extract'], dir);
  }
  await rm(download);
  if (!existsSync(exe)) throw new Error(`${name}: no ${build.bin} unpacked`);
  return { exe, version };
}

/**
 * Launch flags only Windows runs get, so Linux runs keep the conditions of
 * the recorded Linux results.
 */
export const onWindows = (...flags) =>
  process.platform === 'win32' ? flags : [];

/**
 * Environment that points an app's home at `home`: HOME on Linux,
 * USERPROFILE on Windows, where Node's os.homedir() reads it.
 */
export const homeEnv = (home) => ({ HOME: home, USERPROFILE: home });

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

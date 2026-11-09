import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Reuse a validated TypeScript component, independent of Cargo's OUT_DIR. */
export async function cachedComponent({
  name,
  recipe = '',
  inputs,
  root,
  cacheDir,
  out,
  build,
  enabled = true
}) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name))
    throw new Error('invalid fixture cache name');
  const hash = createHash('sha256').update(
    JSON.stringify({
      version: 1,
      name,
      recipe,
      node: process.version,
      platform: process.platform,
      arch: process.arch
    })
  );
  for (const path of [...inputs].sort()) {
    const bytes = await readFile(path);
    hash.update(
      JSON.stringify([relative(root, path).split(sep).join('/'), bytes.length])
    );
    hash.update(bytes);
  }
  const inputHash = hash.digest('hex');
  const entry = join(cacheDir, `${name}.json`);
  if (enabled) {
    let cached;
    try {
      cached = JSON.parse(await readFile(entry, 'utf8'));
    } catch {
      /* A missing or corrupt cache rebuilds normally. */
    }
    if (
      cached?.inputHash === inputHash &&
      typeof cached.component === 'string'
    ) {
      const bytes = Buffer.from(cached.component, 'base64');
      if (digest(bytes) === cached.outputHash) {
        await mkdir(dirname(out), { recursive: true });
        let existing;
        try {
          existing = await readFile(out);
        } catch {
          /* New Cargo output directory. */
        }
        if (!existing?.equals(bytes)) await writeFile(out, bytes);
        return { bytes, cacheHit: true };
      }
    }
  }
  const bytes = Buffer.from(await build(out));
  if (enabled) {
    const temporary = `${entry}.${randomUUID()}.tmp`;
    try {
      await mkdir(cacheDir, { recursive: true });
      await writeFile(
        temporary,
        JSON.stringify({
          inputHash,
          outputHash: digest(bytes),
          component: bytes.toString('base64')
        })
      );
      await rename(temporary, entry);
    } catch {
      // Cache I/O must not turn a successful component build into a failure.
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
  return { bytes, cacheHit: false };
}

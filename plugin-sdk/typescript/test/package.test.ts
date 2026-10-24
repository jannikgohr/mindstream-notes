// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { packagePlugin } from '../lib/package.js';

it('refuses output folders containing referenced assets before deleting them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-package-'));
  try {
    const docs = join(root, 'docs');
    await mkdir(docs);
    await writeFile(join(docs, 'guide.md'), 'Keep the guide');
    await writeFile(join(docs, 'guide.de.md'), 'Keep the translation');
    const component = join(root, 'plugin.wasm');
    await writeFile(component, 'component');
    await writeFile(
      join(root, 'manifest.json'),
      JSON.stringify({
        entry: 'plugin.wasm',
        contributes: { documentation: [{ file: 'docs/guide.md' }] }
      })
    );

    await expect(packagePlugin({ root, component, out: docs })).rejects.toThrow(
      /must not contain/
    );
    expect(await readFile(join(docs, 'guide.md'), 'utf8')).toBe(
      'Keep the guide'
    );
    expect(await readFile(join(docs, 'guide.de.md'), 'utf8')).toBe(
      'Keep the translation'
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

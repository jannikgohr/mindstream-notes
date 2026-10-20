// Rebuild the checked-in first-party components. Node only, no Rust needed.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildComponent } from './typescript/lib/build.js';
import { checkPackage } from './typescript/lib/check.js';

const root = join(import.meta.dirname, '..');
for (const name of ['templates', 'typst']) {
  const dir = join(root, 'plugins', name);
  const manifest = JSON.parse(
    await readFile(join(dir, 'manifest.json'), 'utf8')
  );
  const bytes = await buildComponent({
    source: join(import.meta.dirname, 'bundled', name, 'main.ts'),
    out: join(dir, manifest.entry)
  });
  const problems = await checkPackage(dir);
  if (problems.length) throw new Error(`${name}: ${problems.join('; ')}`);
  console.log(`${name}: ${bytes.length} bytes, package check passed`);
}

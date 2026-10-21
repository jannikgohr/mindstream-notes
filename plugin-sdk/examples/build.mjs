// Non-shipped TypeScript packages. Node only; each has its own installable ID.
import { join } from 'node:path';
import { buildComponent } from '../typescript/lib/build.js';
import { checkPackage } from '../typescript/lib/check.js';

for (const name of ['templates', 'typst']) {
  const dir = join(import.meta.dirname, `${name}-typescript`);
  const bytes = await buildComponent({
    source: join(dir, 'main.ts'),
    out: join(dir, 'plugin.wasm'),
    optSize: name !== 'templates'
  });
  const problems = await checkPackage(dir);
  if (problems.length) throw new Error(`${name}: ${problems.join('; ')}`);
  console.log(
    `${name} TypeScript example: ${bytes.length} bytes, package check passed`
  );
}

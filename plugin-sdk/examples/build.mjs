// Non-shipped TypeScript packages. Node only; each has its own installable ID.
// The built plugin.wasm files are not committed; tests rebuild them.
import { join } from 'node:path';
import { fixtures } from '../fixtures.mjs';
import { checkPackage } from '../typescript/lib/check.js';

for (const name of ['templates', 'typst']) {
  const dir = join(import.meta.dirname, `${name}-typescript`);
  const bytes = await fixtures[`${name}-typescript`].build(
    join(dir, 'plugin.wasm')
  );
  const problems = await checkPackage(dir);
  if (problems.length) throw new Error(`${name}: ${problems.join('; ')}`);
  console.log(
    `${name} TypeScript example: ${bytes.length} bytes, package check passed`
  );
}

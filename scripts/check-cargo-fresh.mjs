import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Cargo's JSON stream lets CI check actual reuse without parsing translated
// terminal output or relying on noisy elapsed-time thresholds.
export function checkCargoFresh(stream) {
  const messages = stream.split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const finished = messages.findLast(
    (message) => message.reason === 'build-finished'
  );
  if (!finished?.success)
    throw new Error('Cargo did not finish a successful build');
  const artifacts = messages.filter(
    (message) => message.reason === 'compiler-artifact'
  );
  if (!artifacts.length) throw new Error('Cargo reported no build artifacts');
  const rebuilt = artifacts.filter((artifact) => artifact.fresh !== true);
  if (rebuilt.length) {
    throw new Error(
      `Unchanged build recompiled: ${rebuilt.map((artifact) => artifact.target.name).join(', ')}`
    );
  }
  return { artifacts: artifacts.length, rebuilt: 0 };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  console.log(
    JSON.stringify(checkCargoFresh(readFileSync(process.argv[2], 'utf8')))
  );
}

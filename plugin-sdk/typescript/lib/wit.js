// Where the WIT package the SDK builds against lives.
//
// In this repository it is plugin-sdk/wit, next to the SDK. A packed SDK
// carries its own copy in ./wit (see the `prepack` script).

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** The directory holding the `mindstream:plugin` WIT package. */
export function witDir() {
  for (const candidate of [
    join(here, '..', 'wit'),
    join(here, '..', '..', 'wit')
  ]) {
    if (existsSync(join(candidate, 'world.wit'))) return candidate;
  }
  throw new Error('the mindstream:plugin WIT package is missing from the SDK');
}

/** The world every plugin component targets. */
export const WORLD = 'plugin';
/** The only interfaces a plugin may import. */
export const IMPORT_PREFIX = 'mindstream:plugin/';

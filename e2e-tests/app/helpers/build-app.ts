/**
 * Build the app binary the wdio suites launch, and nothing else.
 *
 * The three app-tier CI jobs each used to build their own copy of the same
 * binary. This is the seam that lets one job build it and hand it to the rest
 * as an artifact, which then run with `MINDSTREAM_E2E_SKIP_BUILD=1` — see the
 * `app-e2e-build` job in .github/workflows/test.yml.
 *
 * Deliberately the *same* `buildApp()` the suites call, not a second recipe
 * that could drift from it: a binary built here has to be indistinguishable
 * from one a local `pnpm test:e2e:app` would have produced, since the suites
 * verify what they are handed (`assertAppBinaryReady`) but cannot verify how
 * it was made.
 *
 * There is no reason to run this locally — the suites build for you.
 */

import { buildApp } from './preflight.js';

buildApp();

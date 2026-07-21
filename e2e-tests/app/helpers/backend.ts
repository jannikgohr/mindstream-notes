/**
 * T4 backend target for the app tier.
 *
 * The URL resolution and the readiness probe live in ../../shared/backend-target
 * so the Playwright backend tier resolves the same stack from the same env var;
 * this module stays as the app tier's import site.
 *
 * `assertBackendReady` runs from the wdio `onPrepare` hook (helpers/preflight.ts)
 * — before any driver is spawned — so a down stack fails once, up front, with an
 * actionable message.
 */

export { assertBackendReady, backendUrl } from '../../shared/backend-target.js';

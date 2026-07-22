/**
 * Pre-flight for the backend probe tier: refuse to start unless the stack these
 * specs exist to probe is actually answering.
 *
 * Previously each spec self-skipped on `MINDSTREAM_E2E_BACKEND`, which meant
 * forgetting the flag produced a fully-green run that had asserted nothing.
 * Failing here instead makes "stack isn't up" indistinguishable from any other
 * broken precondition: loud, immediate, and with the fix in the message.
 */

import { assertBackendReady } from '../shared/backend-target.js';

export default async function globalSetup(): Promise<void> {
  await assertBackendReady();
}

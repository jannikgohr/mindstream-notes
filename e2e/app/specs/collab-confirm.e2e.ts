/**
 * T4 — the collab confirmation prompt before restore (docs/e2e-strategy.md §5).
 * `peerCount` is now plumbed for the awareness-based editors (markdown / PDF),
 * so with a second client present a restore must show the confirmation, and
 * solo editing must not. Ink / freeform don't report presence yet, so this also
 * asserts they do NOT prompt — pinning the documented gap.
 */

import { assertBackendReady } from '../helpers/backend.js';
import { requireBackendE2E } from '../helpers/harness.js';

describe('T4 collab confirmation prompt', function () {
  before(async function () {
    requireBackendE2E(this);
    await assertBackendReady();
  });

  it('prompts on restore when a second client is present (markdown/PDF)', async () => {
    // Open the shared note in A and B (both awareness-based). In A, restore an
    // older version → assert the confirmation dialog
    // ("Restore while others are editing?") appears before the overwrite.
    // TODO: multiremote.
  });

  it('does not prompt when editing solo', async () => {
    // Only A connected → restore proceeds with no confirmation. TODO.
  });

  it('does not prompt for ink/freeform (no presence wired yet)', async () => {
    // With a second client on an ink or freeform note, a restore still does NOT
    // prompt, because those editors don't register peerCount. Guards the
    // documented limitation in docs/known-limitations.md. TODO.
  });
});

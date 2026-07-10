/**
 * T4 — sync, two devices, sequential (docs/e2e-strategy.md §4, last block).
 * Device A edits/restores → push → Device B pulls → assert the **content**
 * matches AND that B has **no `reverted` timeline entry** for A's restore.
 *
 * That negative assertion is the regression guard for the documented
 * "history is per-device, not synced" limitation
 * (docs/known-limitations.md) — the timeline is local; only content converges.
 */

import { assertBackendReady } from '../helpers/backend.js';
import { requireBackendE2E } from '../helpers/harness.js';

describe('T4 per-device history (sync negative assertion)', function () {
  before(async function () {
    requireBackendE2E(this);
    await assertBackendReady();
    // TODO: two devices (two profile dirs) on the same account; seed a shared
    // note. Sequential, not concurrent — A pushes, then B pulls.
  });

  it('B converges on content but has no reverted entry for A’s restore', async () => {
    // On A: edit, restore an older version, let it push.
    // On B: pull, then:
    //   - assert the note content equals A's restored content;
    //   - assert B's History has NO 'reverted' entry referencing A's restore.
    // TODO: multiremote + sync trigger.
  });
});

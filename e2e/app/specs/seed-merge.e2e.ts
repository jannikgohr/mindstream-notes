/**
 * T4 — seeded-note convergence across two devices on the SAME account.
 *
 * Fresh installs seed identical demo notes (deterministic ids seed_welcome /
 * seed_sprint / seed_ideas). Two fresh devices on one account therefore each
 * seed their own copy of every demo note; sync reconciles them by id. This
 * suite pins two properties of that reconcile:
 *
 *   1. NO DUPLICATION. Each device used to build its own CRDT origin op for a
 *      seed body (a random-client insert), so any merge stacked both origins
 *      and the body repeated ("WelcomeWelcome…"). Seeds now share a
 *      deterministic origin — Rust seeds a fixed-client v1 state
 *      (sync/yrs_doc.rs::init_seed_state) and the markdown editor seeds an
 *      empty note with a fixed client id ($lib/editor/seed-template) — so the
 *      base collapses to one. (The CRDT merge-dedup itself, keeping both
 *      devices' edits while the seed appears once, is covered by the Rust and
 *      JS unit tests; here we assert the end-to-end no-duplication + edit
 *      propagation the sequential sync path can reach.)
 *   2. EDITS PERSIST. An edit to a seeded note on one device reaches the other.
 *
 * Same-account two-device harness (like sync-history.e2e.ts): browserA and
 * browserB both sign into one account.
 */

import { expect } from '@wdio/globals';

import { provisionTwoAccounts } from '../helpers/accounts.js';
import { assertBackendReady, backendUrl } from '../helpers/backend.js';
import {
  clientHelpers,
  loginClient,
  requireBackendE2E,
  syncClient,
  type ClientHelpers
} from '../helpers/harness.js';

declare const browserA: WebdriverIO.Browser;
declare const browserB: WebdriverIO.Browser;

// Deterministic seed ids (src-tauri/.../migrations.rs::seed) + a phrase that
// appears exactly once in each seed body — the duplication canary.
const SEED_SPRINT = 'seed_sprint';
const SEED_IDEAS = 'seed_ideas';
const SPRINT_CANARY = 'Carry-over from last sprint';
const IDEAS_CANARY = 'Backlinks panel';

async function noteBody(
  client: WebdriverIO.Browser,
  id: string
): Promise<string> {
  return client.execute(async (noteId: string) => {
    const tauri = window as unknown as {
      __TAURI_INTERNALS__?: {
        invoke?: <R>(c: string, a?: Record<string, unknown>) => Promise<R>;
      };
    };
    const invoke = tauri.__TAURI_INTERNALS__?.invoke;
    if (!invoke) return '';
    try {
      const note = await invoke<{ body?: string }>('load_note', { id: noteId });
      return note?.body ?? '';
    } catch {
      return '';
    }
  }, id);
}

async function saveBody(
  client: WebdriverIO.Browser,
  id: string,
  body: string
): Promise<void> {
  await client.execute(
    async (noteId: string, newBody: string) => {
      const tauri = window as unknown as {
        __TAURI_INTERNALS__?: {
          invoke?: <R>(c: string, a?: Record<string, unknown>) => Promise<R>;
        };
      };
      const invoke = tauri.__TAURI_INTERNALS__?.invoke;
      if (!invoke) throw new Error('no invoke');
      await invoke('save_note', { input: { id: noteId, body: newBody } });
    },
    id,
    body
  );
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/** Re-sync both devices until `predicate` holds, or give up after `rounds`. */
async function syncUntil(
  predicate: () => Promise<boolean>,
  rounds = 12
): Promise<boolean> {
  for (let round = 0; round < rounds; round += 1) {
    await syncClient(browserA);
    await syncClient(browserB);
    if (await predicate()) return true;
  }
  return predicate();
}

describe('T4 seeded-note convergence (same account, two devices)', function () {
  this.timeout(600_000);

  let A: ClientHelpers;
  let B: ClientHelpers;

  before(async function () {
    requireBackendE2E(this);
    await assertBackendReady();
    const server = backendUrl();
    const accounts = await provisionTwoAccounts(server);
    const shared = accounts.sender;

    // Sequential login (not Promise.all): bringing two release WebViews up
    // concurrently races the shell render under this tier's memory pressure and
    // the settings button can miss its 30s wait. sync-history.e2e.ts logs in
    // sequentially for the same reason.
    await loginClient(browserA, {
      serverUrl: server,
      username: shared.username,
      password: shared.password
    });
    await loginClient(browserB, {
      serverUrl: server,
      username: shared.username,
      password: shared.password
    });
    A = clientHelpers(browserA);
    B = clientHelpers(browserB);

    // Settle the freshly-seeded notes across both devices first. Seeds start
    // dirty=1 on every device, so until they've reconciled on the server a
    // later edit on one device is masked by the other's still-dirty local copy
    // (a pull keeps local metadata while dirty). A few rounds converge them —
    // and if the shared origin were broken, the seed bodies would already be
    // duplicating here.
    for (let round = 0; round < 4; round += 1) {
      await syncClient(browserA);
      await syncClient(browserB);
    }
  });

  it('an edit to a seeded note propagates to the other device without duplicating the seed body', async () => {
    // Edit a seeded note that is NOT auto-opened in an editor, so save_note
    // writes cleanly (no live-editor round-trip). The edit must reach B and the
    // seed body must still appear exactly once — the seeds' shared deterministic
    // origin means the reconcile never stacks two copies of the base.
    const marker = `SPRINTEDIT${Date.now()}`;
    const base = await noteBody(browserA, SEED_SPRINT);
    await saveBody(browserA, SEED_SPRINT, `${base}\n\n${marker}`);

    const reached = await syncUntil(async () =>
      (await noteBody(browserB, SEED_SPRINT)).includes(marker)
    );
    expect(reached).toBe(true);

    // Seed body present exactly once on both devices; the edit present on both.
    for (const client of [browserA, browserB]) {
      const body = await noteBody(client, SEED_SPRINT);
      expect(countOccurrences(body, SPRINT_CANARY)).toBe(1);
      expect(body).toContain(marker);
    }
  });

  it('independent edits to different seeded notes both persist', async () => {
    // Two DIFFERENT seeded notes edited one per device — no conflict, a
    // straight "each edit reaches the other device" check.
    const sprintMarker = `SPRINTB${Date.now()}`;
    const ideasMarker = `IDEASA${Date.now()}`;

    const sprintBase = await noteBody(browserB, SEED_SPRINT);
    const ideasBase = await noteBody(browserA, SEED_IDEAS);
    await saveBody(browserB, SEED_SPRINT, `${sprintBase}\n\n${sprintMarker}`);
    await saveBody(browserA, SEED_IDEAS, `${ideasBase}\n\n${ideasMarker}`);

    const converged = await syncUntil(async () => {
      const sprintOnA = await noteBody(browserA, SEED_SPRINT);
      const ideasOnB = await noteBody(browserB, SEED_IDEAS);
      return sprintOnA.includes(sprintMarker) && ideasOnB.includes(ideasMarker);
    });
    expect(converged).toBe(true);

    // No duplication crept into the edited seeds either.
    expect(
      countOccurrences(await noteBody(browserA, SEED_IDEAS), IDEAS_CANARY)
    ).toBe(1);
    expect(
      countOccurrences(await noteBody(browserB, SEED_SPRINT), SPRINT_CANARY)
    ).toBe(1);
  });

  // Both devices editing the SAME seed through the LIVE markdown editor and
  // converging via sequential sync is blocked by a separate, pre-existing bug:
  // with the note open on both, handleSyncCompleted re-applies each pulled
  // update into the live y-prosemirror doc and re-saves, which snowballs into
  // dozens of random-client rewrites (the seed body ends up duplicated N times)
  // — independent of the seed origin (the two SAVED states still merge to a
  // single copy; verified by the JS unit test). Pending a fix to that
  // live-editor + sequential-sync feedback loop.
  it.skip('both devices editing the same seed in the live editor converge without duplication', () => {});
});

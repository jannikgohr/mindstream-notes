/**
 * T4 — the collaboration matrix (docs/e2e-strategy.md §4, "two clients, shared
 * note") and flow 2.5. Two app instances (two profile dirs) signed into the
 * same test account, both open on the same note in a shared collection.
 *
 * Needs the backend stack (MINDSTREAM_E2E_BACKEND=1) AND a two-client wdio
 * setup. A single tauri-driver session can't host two apps, so the real wiring
 * is wdio **multiremote** (two capabilities → `browserA` / `browserB`) or two
 * driver processes; that lives in a dedicated multiremote config. This spec is
 * the faithful scenario skeleton — gated to skip until that harness lands.
 */

import { assertBackendReady, backendUrl } from '../helpers/backend.js';
import { requireBackendE2E } from '../helpers/harness.js';

describe('T4 collaboration matrix', function () {
  before(async function () {
    requireBackendE2E(this);
    await assertBackendReady();
    // TODO: sign both clients into the same test account at backendUrl(),
    // seed a shared collection + note, and open it in A and B. Prefer seeding a
    // pre-authenticated session blob into each profile dir over driving the
    // Account UI each run (e2e-strategy.md §3).
    void backendUrl;
  });

  it('edit in A propagates to B', async () => {
    // type in browserA's editor → assert browserB's editor converges.
    // TODO: multiremote.
  });

  it('restore in A converges B on the restored content', async () => {
    // restore an older version in A → B's live content matches.
    // TODO: multiremote.
  });

  it('concurrent edit survives a restore as an orphan (pins the limitation)', async () => {
    // A restores while B holds an unsynced edit → assert the DOCUMENTED merge
    // outcome (B's addition survives as an orphan; markdown merges at
    // boundaries). This guards against a *change* in the non-transactional
    // restore behaviour — see docs/known-limitations.md. TODO: multiremote.
  });

  it('undo of the restore in A converges B back', async () => {
    // TODO: multiremote.
  });

  it('offline edits on both sides converge on reconnect', async () => {
    // toggle A offline, edit both, reconnect → assert convergence. TODO.
  });
});

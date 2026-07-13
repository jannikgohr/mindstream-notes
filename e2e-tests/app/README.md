# Real-app e2e (T3) + collaboration (T4)

This suite drives the **packaged Tauri binary** over WebDriver (`tauri-driver`)
— the T3/T4 tiers. It's separate from the Playwright browser-fallback suite in
[`../browser/`](../browser/) and **never runs in the default `pnpm test:e2e` or
in CI**.

- **How to run it** → [../README.md](../README.md)
- **Toolchain, env flags, test seams, harness gotchas** → [docs/e2e/harness.md](../../docs/e2e/harness.md)
- **Current coverage & what's still stubbed** → [docs/e2e/status.md](../../docs/e2e/status.md)

Without `MINDSTREAM_E2E_APP=1`, every spec skips. The T4 specs also require
`MINDSTREAM_E2E_BACKEND=1` + a running [backend stack](../../docs/e2e/backend-stack.md);
the dialog-driven backup specs require the native-dialog hook once that Rust
seam exists.

## What's here

| File                                | Tier | Covers                                                                 |
| ----------------------------------- | ---- | ---------------------------------------------------------------------- |
| `specs/editor-roundtrip.e2e.ts`     | T3   | flow 1.1 through real `save_note` + SQLite + restart                   |
| `specs/history.e2e.ts`              | T3   | capture / restore / Undo / editor-undo isolation / restart persistence |
| `specs/trash-retention.e2e.ts`      | T3   | flows 1.5 + 3.3 (retention sweep on boot)                              |
| `specs/settings-persist.e2e.ts`     | T3   | flows 3.1 / 3.2                                                        |
| `specs/backup.e2e.ts`               | T3   | flows 1.2–1.4 (pending a native-dialog hook)                           |
| `specs/collab.e2e.ts`               | T4   | markdown live-edit propagation (pending a deterministic relay hook)    |
| `specs/collab-confirm.e2e.ts`       | T4   | solo no-prompt; peer prompt + ink/freeform (partly pending)            |
| `specs/sync-history.e2e.ts`         | T4   | per-device-history negative assertion; 4.10 edit-wins-over-delete      |
| `specs/sharing.e2e.ts`              | T4   | sharing flows 4.1–4.4 + 4.7/4.7b                                       |
| `specs/sharing-multi-device.e2e.ts` | T4   | owner-second-device 4.8–4.9 re-home cases                              |

`helpers/harness.ts` owns capability gating, the `MINDSTREAM_PROFILE_DIR`
isolation/restart seam, and the accessible-name selectors (the same names the
Playwright T2 specs use — the identical SvelteKit UI renders inside the WebView).
`helpers/backend.ts` is the T4 backend-readiness gate. `helpers/accounts.ts`
provisions the two distinct users the sharing flows need
([backend-stack.md](../../docs/e2e/backend-stack.md#account-provisioning)).

## Two-client (T4) harness

- **`wdio.multiremote.conf.ts`** spawns **two** tauri-driver processes (ports
  4444/4445 and 4446/4447), each launching the app against its own
  `MINDSTREAM_PROFILE_DIR`, and drives them as `browserA` / `browserB`. Run with
  `pnpm test:e2e:app:multi` (backend up + the T4 env flags).
- **`wdio.multiremote.a2.conf.ts`** adds a third instance for the
  owner-second-device sharing cases (`sharing-multi-device.e2e.ts`). Run with
  `pnpm test:e2e:app:multi:a2`.
- **Two accounts** are provisioned per run via `provisionTwoAccounts` (real
  Etebase signups, so the sender resolves the recipient's pubkey). Fresh by
  default for isolation; `MINDSTREAM_E2E_REUSE_ACCOUNTS=1` reuses the cached
  `.t4-accounts.json` for local reruns.

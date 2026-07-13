# Running the end-to-end tests

Three suites live here. Only the **browser** suite runs by default and in CI;
the rest are opt-in behind an env flag so they skip cleanly when their
prerequisites (a packaged app build, a backend stack) aren't present.

| Suite                  | Command                   | Needs                             |
| ---------------------- | ------------------------- | --------------------------------- |
| `browser/` (T2)        | `pnpm test:e2e`           | Node only — runs in CI            |
| `backend/` (health)    | `pnpm test:e2e:backend`   | the test backend stack up         |
| `app/` single (T3)     | `pnpm test:e2e:app`       | the `tauri-driver` toolchain      |
| `app/` two-client (T4) | `pnpm test:e2e:app:multi` | the toolchain **+** backend stack |

First time only: `pnpm install`.

## Browser suite (T2) — the default

Playwright driving the SvelteKit SPA in browser-fallback mode (an in-memory
mock store backs every IPC call). No native app, no backend.

```sh
pnpm test:e2e          # headless
pnpm test:e2e:ui       # interactive Playwright runner
```

## Backend health (T4 prerequisite)

Bring up the disposable stack, then run the probe suite. Everything is gated on
`MINDSTREAM_E2E_BACKEND`, so without the flag the specs skip.

```sh
pnpm backend:test:up                                    # stack on :18080
MINDSTREAM_E2E_BACKEND=1 pnpm test:e2e:backend
pnpm backend:test:down                                  # tear down when done
```

See [docs/e2e/backend-stack.md](../docs/e2e/backend-stack.md).

## Real-app suite (T3, single client)

Drives the **packaged Tauri binary** over WebDriver. Needs the one-time
toolchain in [docs/e2e/harness.md](../docs/e2e/harness.md#toolchain). Every spec
skips unless `MINDSTREAM_E2E_APP=1` is set.

```sh
MINDSTREAM_E2E_APP=1 pnpm test:e2e:app
```

The binary is built with `--features e2e-data-dir` first; set
`MINDSTREAM_E2E_SKIP_BUILD=1` to reuse an existing build while iterating.

## Real-app collaboration (T4, two clients)

Two app instances plus the backend stack. Bring the stack up first, then run
with both flags and the backend URL:

```sh
pnpm backend:test:up
MINDSTREAM_E2E_APP=1 MINDSTREAM_E2E_BACKEND=1 \
  MINDSTREAM_E2E_BACKEND_URL=http://localhost:18080 pnpm test:e2e:app:multi

# The owner-second-device variant (three app instances):
… pnpm test:e2e:app:multi:a2
```

See [app/README.md](app/README.md) for the two-client harness specifics and the
full env-flag reference in [docs/e2e/harness.md](../docs/e2e/harness.md).

## Going deeper

- **Why these tiers exist / what each proves** — [docs/e2e/strategy.md](../docs/e2e/strategy.md)
- **The flows worth covering (catalogue)** — [docs/e2e/flows.md](../docs/e2e/flows.md)
- **Current coverage & open gaps** — [docs/e2e/status.md](../docs/e2e/status.md)
- **By-design behaviours these tests pin down** — [docs/known-limitations.md](../docs/known-limitations.md)

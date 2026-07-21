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

## Prerequisites

- **Browser suite (T2):** `pnpm install` — nothing else.
- **Real-app suites (T3/T4):** also the app-build toolchain (Rust + your OS's
  Tauri system deps — [docs/BUILDING.md](../docs/BUILDING.md)) **and** the
  `tauri-driver` toolchain
  ([docs/e2e/harness.md](../docs/e2e/harness.md#toolchain)). T3/T4 build the
  packaged binary, so the full app toolchain is required, not just Node.
- **T4 only:** a running Docker backend stack
  ([backend/README.md](../backend/README.md)).

## Browser suite (T2) — the default

Playwright driving the SvelteKit SPA in browser-fallback mode (an in-memory
mock store backs every IPC call). No native app, no backend.

```sh
pnpm test:e2e          # headless
pnpm test:e2e:ui       # interactive Playwright runner
```

## Backend health (T4 prerequisite)

Bring up the disposable stack, then run the probe suite. The stack is a
precondition: if it isn't answering, the run fails up front rather than skipping.

```sh
pnpm backend:test:up                                    # stack on :18080
pnpm test:e2e:backend
pnpm backend:test:down                                  # tear down when done
```

The rate-limit specs stay opt-in behind `MINDSTREAM_E2E_EDGE_LIMITS=1` — they
drain the auth bucket for every suite sharing the stack.

See [docs/e2e/backend-stack.md](../docs/e2e/backend-stack.md).

## Real-app suite (T3, single client)

Drives the **packaged Tauri binary** over WebDriver. Needs the one-time
toolchain in [docs/e2e/harness.md](../docs/e2e/harness.md#toolchain).

```sh
pnpm test:e2e:app
```

The binary is built with `--features e2e-data-dir` first; set
`MINDSTREAM_E2E_SKIP_BUILD=1` to reuse an existing build while iterating.

## Real-app collaboration (T4, two clients)

Two app instances plus the backend stack. Bring the stack up first — the specs
default to it at `http://localhost:18080` and fail fast if it isn't answering:

```sh
pnpm backend:test:up
pnpm test:e2e:app:multi

# The owner-second-device variant (three app instances):
pnpm test:e2e:app:multi:a2
```

Set `MINDSTREAM_E2E_BACKEND_URL` only to point at a different stack. If T4 specs
start timing out or behaving oddly, reset the stack (`pnpm backend:test:reset`)
— accumulated data slows sync enough to mimic real bugs.

See [app/README.md](app/README.md) for the two-client harness specifics and the
full env-flag reference in [docs/e2e/harness.md](../docs/e2e/harness.md).

## Going deeper

- **Why these tiers exist / what each proves** — [docs/e2e/strategy.md](../docs/e2e/strategy.md)
- **The flows worth covering (catalogue)** — [docs/e2e/flows.md](../docs/e2e/flows.md)
- **Current coverage & open gaps** — [docs/e2e/status.md](../docs/e2e/status.md)
- **By-design behaviours these tests pin down** — [docs/known-limitations.md](../docs/known-limitations.md)

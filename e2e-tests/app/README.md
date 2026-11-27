# Real-app e2e (T3) + collaboration (T4)

This suite drives the **packaged Tauri binary** over WebDriver (`tauri-driver`).
It is separate from the Playwright browser-fallback suite in
[`../browser/`](../browser/) and from the default `pnpm test:e2e`.

- **How to run it** → [../README.md](../README.md)
- **Toolchain, env flags, seams, gotchas** → [docs/internal/e2e/harness.md](../../docs/internal/e2e/harness.md)
- **Which spec covers which flow** → [docs/internal/e2e/flows.md](../../docs/internal/e2e/flows.md)
- **The test backend and accounts** → [docs/internal/e2e/backend-stack.md](../../docs/internal/e2e/backend-stack.md)

## Layout

- `specs/single/`, `specs/multi/`, `specs/multi-a2/`: one, two and three app
  instances. A new `*.e2e.ts` file is picked up by its directory.
- `wdio.conf.ts` runs `single/`; `wdio.multiremote.conf.ts` runs `multi/` as
  `browserA` / `browserB`; `wdio.multiremote.a2.conf.ts` adds a third instance
  for `multi-a2/`.
- `helpers/harness.ts`: the isolation and restart seam and the accessible-name
  selectors, the same names the Playwright specs use.
- `helpers/preflight.ts`: the requirement checks and the app build.
- `helpers/backend.ts`, `helpers/accounts.ts`, `helpers/server-admin.ts`: the
  backend gate, account signup and the server's admin command.

# Mindstream Notes backend

One server does everything the app needs from a backend: accounts, encrypted
storage, sharing, and the live rooms that notes of every kind are co-edited in.
It runs on Postgres and sits behind **one URL**, which is the only thing a user
types into the app.

| Folder               | What it is                                                            |
| -------------------- | --------------------------------------------------------------------- |
| [server/](server/)   | The server. Start with its [README](server/README.md)                 |
| [billing/](billing/) | A stand-in for the billing program a managed service needs. Not built |
| [scripts/](scripts/) | The driver for the disposable test stack the end-to-end suites run on |

- To run your own server, follow the
  [self-hosting quick start](../docs/self-hosting.md).
- The end-to-end suites run against a throwaway server started with
  `pnpm backend:test:up`. See [docs/internal/e2e/backend-stack.md](../docs/internal/e2e/backend-stack.md).
- The design, and why it replaced the earlier stack of Etebase, two relays and
  nginx, is in [docs/internal/server-design.md](../docs/internal/server-design.md).

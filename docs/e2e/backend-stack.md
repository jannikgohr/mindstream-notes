# The test backend (T4)

The T4 collaboration and sharing specs need a real **mindstream-server**: the
`backend/` Docker Compose stack — one nginx front door path-routing to
**Etebase** (encrypted storage + auth on Postgres), **yjs-relay** (markdown +
PDF Yjs collab), and **excalidraw-room** (freeform live sync). The client talks
to a single URL and derives the collab WebSocket paths itself. Full stack docs:
[backend/README.md](../../backend/README.md).

## Bring up the disposable test stack

Use the disposable stack — an isolated volume, `AUTO_SIGNUP=true`, on a
test-only port (`18080`) so it never collides with a dev backend:

```sh
pnpm backend:test:up      # up on http://localhost:18080
pnpm backend:test:down    # stop
pnpm backend:test:reset   # wipe the volume for a clean run
```

Then point the T4 specs at it:

```sh
MINDSTREAM_E2E_BACKEND=1 MINDSTREAM_E2E_BACKEND_URL=http://localhost:18080 …
```

(The full-featured `docker compose up` on port `8080` from
[backend/README.md](../../backend/README.md) is for manual use; the tests use
the disposable `:test:*` scripts.)

## Health gating

`e2e-tests/backend/backend-health.spec.ts` probes all four services through the
single nginx edge (nginx `/healthz`, yjs-relay `:1234`, the excalidraw-room
socket.io handshake, Etebase). Run it as a readiness check before a T4 run:

```sh
MINDSTREAM_E2E_BACKEND=1 pnpm test:e2e:backend
```

It's the only T4-adjacent piece runnable without the packaged app.

## Account provisioning

Most T4 collab flows reuse **one account on two devices**. The **sharing**
flows ([flows.md](flows.md) §4) are stronger: they need **two distinct users**
— a sender and a recipient whose public key the sender resolves via
`fetch_user_profile` — so the shared-collection namespacing trick isn't enough.

`e2e-tests/app/helpers/accounts.ts` (`provisionTwoAccounts`) signs up two fresh
users via the `etebase` JS SDK on each run (Etebase blocks signup unless the
stack's `AUTO_SIGNUP=true`, which `pnpm backend:test:up` sets). Fresh accounts
are the default so a run never inherits stale vault/invite/notification state.
Set `MINDSTREAM_E2E_REUSE_ACCOUNTS=1` to reuse the gitignored `.t4-accounts.json`
cache while iterating locally.

Isolation is per-run: a disposable Postgres volume (or `pnpm backend:test:reset`)
keeps state from leaking between runs.

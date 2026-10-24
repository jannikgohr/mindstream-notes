# The test backend (T4)

The T4 collaboration and sharing specs need a real sync server: the one in
[backend/server](../../backend/server/README.md), on Postgres. It answers on a
single URL, for storage and accounts over HTTP and for the live rooms notes
are co-edited in over WebSocket. The app is given that URL and nothing else.

## Bring up the disposable test stack

Use the disposable stack. It has its own volumes, open signup, and a
test-only port (`18080`) so it never collides with a real server:

```sh
pnpm backend:test:up      # up on http://localhost:18080
pnpm backend:test:down    # stop
pnpm backend:test:reset   # wipe the volumes for a clean run
pnpm backend:test:logs server   # print the server's log
```

The first `up` builds the server image, which compiles the server and takes a
few minutes. Later ones reuse it unless the server's source changed.

The T4 specs default to this stack (`http://localhost:18080`), so there is
nothing to set. `MINDSTREAM_E2E_BACKEND_URL` overrides the target if you need
to point at a different server.

The stack is [compose.yml](../../backend/server/compose.yml) with
[compose.test.yml](../../backend/server/compose.test.yml) on top and the
settings in [.env.test](../../backend/server/.env.test). The sign-in limit a
real server applies per address is off there, because every suite arrives from
one address.

## Health gating

`e2e-tests/backend/backend-health.spec.ts` probes the server the way the app
reaches it: liveness, the route that says what it is, the Etebase protocol,
and that a room or a change feed refuses a socket that has no ticket or
session. Run it as a readiness check before a T4 run:

```sh
pnpm test:e2e:backend
```

It's the only T4-adjacent piece runnable without the packaged app. The server
has its own, much larger test suite, which needs no stack at all: see
[server-development.md](../server-development.md).

## Account provisioning

Most T4 collab flows reuse **one account on two devices**. The **sharing**
flows ([flows.md](flows.md) §4) are stronger: they need **two distinct users**
— a sender and a recipient whose public key the sender resolves via
`fetch_user_profile` — so the shared-collection namespacing trick isn't enough.

`e2e-tests/app/helpers/accounts.ts` (`provisionTwoAccounts`) signs up two fresh
users via the `etebase` JS SDK on each run, which the test stack's open signup
allows. Fresh accounts are the default so a run never inherits stale
vault/invite/notification state. Set `MINDSTREAM_E2E_REUSE_ACCOUNTS=1` to reuse
the gitignored `.t4-accounts.json` cache while iterating locally.

Isolation is per-run: disposable volumes (or `pnpm backend:test:reset`) keep
state from leaking between runs.

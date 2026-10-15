# Mindstream Notes backend

One server does everything the app needs from a backend: accounts, encrypted
storage, sharing, and the live rooms that notes of every kind are co-edited
in. It runs on Postgres and sits behind **one URL**, which is the only thing a
user types into the app.

| Folder               | What it is                                                            |
| -------------------- | --------------------------------------------------------------------- |
| [server/](server/)   | The server. Start with its [README](server/README.md)                 |
| [billing/](billing/) | A stand-in for the billing program a managed service needs. Not built |
| [scripts/](scripts/) | The driver for the disposable test stack the end-to-end suites run on |

The design, and why it replaced the earlier stack of Etebase, two relays and
nginx, is in [docs/server-design.md](../docs/server-design.md).

## Run it

```sh
cd backend/server
cp .env.example .env    # then set POSTGRES_PASSWORD in it
docker compose up -d --build
```

The server answers on port 3735 over plain HTTP. For anything but local use,
put a reverse proxy with TLS in front and pass it `/api/`, `/join/` and
`/healthz`, with WebSocket upgrades allowed. Everything else about running one
is in the [server README](server/README.md): who may sign up, invite links,
account security, limits, backups of the secret key.

## The test stack

The end-to-end suites that need a server run against a throwaway one on its
own port, with open signup and volumes that `reset` wipes:

```sh
pnpm backend:test:up        # http://localhost:18080
pnpm test:e2e:backend       # is it up and answering?
pnpm backend:test:logs server
pnpm backend:test:reset     # wipe it and start clean
pnpm backend:test:down
```

It builds the server image on first use, which compiles the server and takes
a few minutes. See [docs/e2e/backend-stack.md](../docs/e2e/backend-stack.md).

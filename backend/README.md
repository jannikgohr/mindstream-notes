# Mindstream Notes — backend

Self-hosted stack for the Mindstream Notes client. Everything lives
behind **one URL**: encrypted note storage + auth (etebase, backed by
postgres) plus two live-collaboration transports (`yjs-relay`,
`excalidraw-room`), path-routed by an `nginx` front door.

You set up that one URL; the client derives everything else from it.

## Requirements

- Docker + Docker Compose
- For production: a domain and a TLS reverse proxy in front
  (e.g. Dokploy/Traefik, Caddy) — see [docs/advanced.md](docs/advanced.md)

## Run it (local)

```sh
cp .env.example .env
# set POSTGRES_PASSWORD — the localhost defaults work for everything else
docker compose up -d --build
```

The stack comes up at **http://localhost:8080**. Get the admin password
etebase generated on first boot:

```sh
docker compose logs etebase | grep -i password
```

## Connect the client

In the app: **Settings → Account**

- Server type → **Self-hosted**
- Server URL → **http://localhost:8080** (or your `https://` domain)

That single URL covers all three services — the client appends the
collab WebSocket paths itself.

## Disposable test stack (e2e T4)

The e2e sharing/collaboration specs (docs/e2e-strategy.md §2.1, T4) need an
**isolated** backend they can provision throwaway accounts against.
`docker-compose.test.yml` overlays this one to provide it: distinct
`mindstream-test-*` container names, its own project/volumes, a separate
host port (**18080**), pinned throwaway creds (`.env.test`), and — the key
bit — **`AUTO_SIGNUP=true`**, since Etebase blocks signup by default and the
two-account provisioning needs the signup endpoint open.

```sh
pnpm backend:test:up       # build + start FULL stack on http://localhost:18080
pnpm backend:test:up:min   # sharing-only: etebase + postgres, NO image builds
pnpm backend:test:reset    # wipe volumes + restart (clean slate)
pnpm backend:test:down     # stop + remove
```

`up:min` is for the **sharing** suite, which only talks to etebase. It layers
`docker-compose.test-min.yml` to publish etebase directly on 18080 and starts
just `etebase` + its `postgres` dependency — both **pulled** images, so nothing
builds. Use it when the Docker bridge can't reach the internet: image _pulls_
work (the daemon uses the host stack) but in-container `apk add` during a build
fails with `DNS: transient error`. The full `up` additionally builds
nginx/yjs-relay/excalidraw-room, which live collaboration (`collab.e2e.ts`)
needs but sharing does not.

> **Tailscale breaks in-container builds.** MagicDNS points the resolver at
> `100.100.100.100` (unreachable from a container's netns) and an exit node
> blackholes the docker subnet's egress. `up:min` is unaffected (no container
> internet needed). For the full stack, build once with Tailscale down
> (`tailscale down` or `tailscale set --exit-node=`) — images cache, then bring
> it back up. Same class of failure appears behind restrictive firewalld/NAT.

The wrapper auto-prefixes `sudo` on a rootful Linux daemon; set
`MINDSTREAM_DOCKER_NO_SUDO=1` for rootless/Docker-Desktop setups (macOS and
Windows never use sudo). It runs alongside a dev stack on 8080 without
clashing. **Never deploy either overlay** — `AUTO_SIGNUP` opens registration
to anyone who can reach the server.

## Go to production

Edit `.env`:

```sh
PUBLIC_HOST=notes.example.com
PUBLIC_ORIGIN=https://notes.example.com
POSTGRES_PASSWORD=<strong-random>
```

Deploy `docker-compose.yml` and put a TLS reverse proxy in front,
routing your domain to the `nginx` service on **port 80**. With
Dokploy/Traefik that's just attaching the domain in the UI — TLS and
WebSockets are handled for you.

## More

Reverse-proxy details, the Django CSRF gotcha, full env reference,
day-2 operations, version upgrades, and architecture — all in
**[docs/advanced.md](docs/advanced.md)**.

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

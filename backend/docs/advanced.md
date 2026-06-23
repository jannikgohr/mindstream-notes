# Mindstream Notes — backend (advanced)

Everything past the happy path in [../README.md](../README.md): the
full service map, config reference, reverse-proxy + TLS setup, the
Django CSRF gotcha, day-2 operations, upgrades, and architecture.

## Services

One nginx fronts note storage and both live-collab transports, so the
client only ever needs a single URL.

| Service           | Image / source                                     | Path                   | What it carries                                   |
| ----------------- | -------------------------------------------------- | ---------------------- | ------------------------------------------------- |
| `nginx`           | `nginx/Dockerfile` (alpine)                        | edge — container `:80` | HTTP front; terminates the inbound connection.    |
| `excalidraw-room` | upstream `excalidraw/excalidraw-room` (pinned ref) | `/socket.io/`          | Freeform-note live sync, official protocol, E2EE. |
| `yjs-relay`       | `yjs-relay/Dockerfile` (uWebSockets.js)            | `/yjs`                 | Markdown & PDF Yjs collab, encrypted broadcast.   |
| `etebase`         | `victorrds/etebase` (Django + uvicorn)             | `/` (everything else)  | Encrypted note storage, auth, sync.               |
| `postgres`        | `postgres:16-alpine`                               | internal only          | Backing store for etebase.                        |

Etebase is the source of truth for your notes; the two WebSocket
services only carry transient live-collab traffic and see ciphertext
only — the AES-GCM key lives client-side in the Etebase NotePayload.

## Environment reference

`.env.example` is the source of truth. `POSTGRES_PASSWORD` is
**required**; set `PUBLIC_HOST` + `PUBLIC_ORIGIN` for production; the
rest have sensible defaults.

| Var                  | Default                 | Notes                                                                                                                                                                                     |
| -------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_HOST`        | `localhost`             | The hostname the client talks to (no scheme, no port). Drives etebase `ALLOWED_HOSTS` + `CSRF_TRUSTED_ORIGINS`. **See "Domain & CSRF" below.** Set to your real host in prod.             |
| `PUBLIC_ORIGIN`      | `http://localhost:8080` | Full origin (scheme + host [+ port]) the client loads from; used for the excalidraw-room CORS allow-list. In prod this is `https://<PUBLIC_HOST>`.                                        |
| `POSTGRES_DB`        | `etebase`               | Database name shared between postgres and etebase.                                                                                                                                        |
| `POSTGRES_USER`      | `etebase`               | Postgres role etebase logs in as.                                                                                                                                                         |
| `POSTGRES_PASSWORD`  | - **(required)**        | Compose refuses to start without it. Internal to the docker network; doesn't need to be human-memorable.                                                                                  |
| `ETEBASE_SUPER_USER` | `admin`                 | Django superuser created on first boot. Used at `/admin` and to bootstrap signups.                                                                                                        |
| `ETEBASE_SUPER_PASS` | _(auto-gen)_            | Leave blank to let the image print a random one to the logs on first boot. Pin it only if you have to.                                                                                    |
| `NGINX_PORT`         | `8080`                  | **Local dev only.** Host port `docker-compose.override.yml` publishes nginx on. Ignored in production (deploy tooling skips the override). Keep in sync with the port in `PUBLIC_ORIGIN`. |

## Reverse proxy & TLS

The stack is plain HTTP on purpose - run a TLS-terminating reverse
proxy in front. The nginx edge publishes **no host port** in
production; point your proxy at the `nginx` service on container
port `80`. Make sure the proxy forwards the `Upgrade` and `Connection`
headers so WebSockets reach the right upstream (Dokploy/Traefik and
Caddy do this by default).

**Dokploy / Traefik:** deploy `docker-compose.yml`, then attach a
domain to the `nginx` service on port `80` in the UI — Traefik
terminates TLS, forwards `X-Forwarded-Proto: https`, and proxies
WebSockets automatically. Set `PUBLIC_HOST`/`PUBLIC_ORIGIN` to that
domain.

**Caddy** (if you publish a host port yourself, e.g. via the local
override):

```
collab.example.com {
  reverse_proxy localhost:8080
}
```

## Domain & CSRF

Etebase is a Django app and Django 4.2+ enforces `CSRF_TRUSTED_ORIGINS`
on every state-changing POST (including the `/admin` login). The
victorrds image **derives both `ALLOWED_HOSTS` and
`CSRF_TRUSTED_ORIGINS` from the single `PUBLIC_HOST` env var**, so as
long as you set that to the right thing, both lists end up populated.
Get it wrong and Django returns either a 400 `DisallowedHost`
(ALLOWED_HOSTS mismatch) or a 403 "CSRF verification failed — Origin
checking failed" (trusted-origin mismatch).

**Set `PUBLIC_HOST` to the exact hostname your client addresses the
stack with.** For the common single-host case that's just one value;
it also accepts comma-separated hosts or a wildcard (this only affects
etebase's host/CSRF lists — `PUBLIC_ORIGIN` stays the one origin the
client loads from):

```
# Local dev
PUBLIC_HOST=localhost,127.0.0.1

# Single public hostname
PUBLIC_HOST=notes.example.com

# Multiple hostnames (clients hit one, admins hit another)
PUBLIC_HOST=notes.example.com,admin.notes.example.com

# Wildcard — note the leading `*.`; bare `.example.com` is rejected
# by the underlying Starlette TrustedHost middleware
PUBLIC_HOST=*.example.com
```

**Behind a TLS terminator** (Dokploy/Traefik, Caddy, Cloudflare, …),
Django needs to know the original request was HTTPS so it builds the
trusted origin as `https://notes.example.com`, not `http://`. The edge
nginx **honors the `X-Forwarded-Proto` your proxy sends** and only
falls back to its own scheme when the header is absent (see the
`$forwarded_proto` map in `nginx/nginx.conf`). So all you need is a
proxy that sets the header:

```
# Dokploy/Traefik and Caddy do this by default — no config needed.
# Plain nginx in front needs:
proxy_set_header X-Forwarded-Proto $scheme;
```

**Symptom → fix cheat sheet:**

| What you see                                             | Cause                                                                    | Fix                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------ |
| `400 DisallowedHost: Invalid HTTP_HOST header`           | Your hostname isn't in `PUBLIC_HOST`.                                    | Add it, restart etebase.                   |
| `403 CSRF verification failed. Origin checking failed.`  | Same root cause — `CSRF_TRUSTED_ORIGINS` is built from the same env var. | Add the hostname to `PUBLIC_HOST`.         |
| Works on `http://`, breaks on `https://` with 403 CSRF   | Outer proxy isn't forwarding `X-Forwarded-Proto: https`.                 | Set the header in your TLS terminator.     |
| `Domain wildcard patterns must be like '*.example.com'.` | You used bare `.example.com` or `*example.com`.                          | Use `*.example.com` (asterisk-dot-domain). |

Restart etebase after changing the env var: `docker compose up -d etebase`.

## Operations

**Logs**

```sh
docker compose logs -f nginx
docker compose logs -f excalidraw-room
docker compose logs -f yjs-relay
docker compose logs -f etebase
docker compose logs -f postgres
```

**Restart one service**

```sh
docker compose restart yjs-relay
```

**Smoke tests** (local dev, stack up on `:8080`)

```sh
# Socket.IO handshake — should start with `0{"sid":...`
curl 'http://localhost:8080/socket.io/?EIO=4&transport=polling'

# yjs-relay WebSocket — should print a 101 upgrade and stay open
wscat -c 'ws://localhost:8080/yjs?room=smoke-test'

# Etebase liveness — should respond with a Django page (200 or a
# DisallowedHost 400 if PUBLIC_HOST doesn't include localhost)
curl -i http://localhost:8080/
```

**Reset the super-user password**

```sh
docker compose exec etebase ./manage.py changepassword "$ETEBASE_SUPER_USER"
```

## Upgrades

**Bumping the excalidraw-room version**

Upstream doesn't tag releases; we pin to a specific commit in
`excalidraw-room/Dockerfile`:

```dockerfile
ARG EXCALIDRAW_ROOM_REF=03ff435860b508d7cd9e005cfc90f7977ae2a593
```

Pick a fresh commit from
<https://github.com/excalidraw/excalidraw-room/commits/master>, update
the line, and rebuild:

```sh
docker compose build --no-cache excalidraw-room
docker compose up -d excalidraw-room
```

**Bumping etebase**

Etebase pins the image tag in `docker-compose.yml`
(`victorrds/etebase:<version>`). Check
<https://hub.docker.com/r/victorrds/etebase/tags> for the latest
release, update the tag, and:

```sh
docker compose pull etebase
docker compose up -d etebase
```

The etebase image runs Django migrations on every boot, so schema
changes are picked up automatically.

## Pulling just `backend/` from the repo

Use Git sparse-checkout to clone only this directory — the desktop app
client tree is several hundred MB you don't need on a server.

```sh
git clone --filter=blob:none --no-checkout https://github.com/jannikgohr/mindstream-notes.git
cd mindstream-notes
git sparse-checkout init --cone
git sparse-checkout set backend
git checkout main
cd backend
cp .env.example .env
docker compose up -d --build
```

To later widen or narrow the checkout:

```sh
git sparse-checkout set backend other/dir   # add more paths
git sparse-checkout disable                  # back to a full checkout
```

`--filter=blob:none` skips downloading blobs you don't check out, so
the initial clone is small even though `git log` still works against
the full history.

## Architecture notes

- **End-to-end encryption.**
  - Etebase encrypts every note client-side under the user's password-
    derived key; the server stores only ciphertext.
  - Live collab AES-GCM-encrypts every frame under a per-note key the
    client fetches from etebase. The two collab services are dumb
    broadcast hubs and never see plaintext.
  - Freeform: AES-GCM-128, room key HKDF-derived client-side from the
    per-note `crypto_key`.
  - Markdown / PDF: AES-GCM-256 over a custom framing
    (`[1B type][12B IV][ciphertext]`).
- **Stateless collab.** Restarting the stack only kicks live peers;
  they reconnect, exchange state with whoever's still in the room, and
  continue. Persistence lives in etebase + postgres.
- **Single shared port.** nginx path-routes so the client setting holds
  one URL even though there are three protocols. If you really want to
  expose them on separate ports, edit `docker-compose.yml` to add
  `ports:` blocks to the inner services and drop `nginx`.
- **Backups.** Two named docker volumes hold all state:
  - `postgres_data` — the etebase database. Back up with
    `docker compose exec postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"`.
  - `etebase_data` — `/data` (config + media uploads). Snapshot the
    volume directly.

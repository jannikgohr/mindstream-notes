# Mindstream Notes — backend

Self-hosted live-collaboration stack for the Mindstream Notes client. Two
WebSocket services sit behind a single nginx so the client only ever
needs one URL:

| Service           | Image / source                                     | Path                  | What it carries                                   |
| ----------------- | -------------------------------------------------- | --------------------- | ------------------------------------------------- |
| `nginx`           | `nginx/Dockerfile` (alpine)                        | edge — `:NGINX_PORT`  | HTTP front; terminates the inbound connection.    |
| `excalidraw-room` | upstream `excalidraw/excalidraw-room` (pinned ref) | `/socket.io/`         | Freeform-note live sync, official protocol, E2EE. |
| `yjs-relay`       | `yjs-relay/Dockerfile` (uWebSockets.js)            | `/` (everything else) | Markdown & PDF Yjs collab, encrypted broadcast.   |

This stack only handles **live collaboration**. Notes themselves are
stored in [Etebase](https://www.etebase.com/) — bring your own server
(managed or self-hosted) and point the client at it from the in-app
settings.

## Quick start

```sh
cp .env.example .env
# edit .env if you want to change the host port or restrict CORS
docker compose up -d --build
```

The stack listens on `${NGINX_PORT}` (default `8080`) over plain HTTP.
Point your client at it from the in-app settings:

```
Settings → Account → Collab server URL
  ws://localhost:8080         # local
  wss://collab.example.com    # behind your TLS proxy
```

`socket.io-client` appends `/socket.io/` itself, and the yjs-relay
ignores the path, so the same root URL serves both transports.

## Environment

`.env.example` is the source of truth. Everything is optional; defaults
work for local testing.

| Var                      | Default | Notes                                                                                                      |
| ------------------------ | ------- | ---------------------------------------------------------------------------------------------------------- |
| `NGINX_PORT`             | `8080`  | Host port published by the `nginx` service. Compose maps `NGINX_PORT:80`.                                  |
| `EXCALIDRAW_CORS_ORIGIN` | `*`     | Forwarded to excalidraw-room. Set to your exact client origin if nothing in front of nginx restricts CORS. |

## TLS

The stack is plain HTTP on purpose — run your own TLS terminator
(Caddy, Cloudflare, an outer nginx, …) in front and forward to
`NGINX_PORT`. Make sure your proxy forwards the `Upgrade` and
`Connection` headers so WebSockets reach the right upstream.

Caddy example:

```
collab.example.com {
  reverse_proxy localhost:8080
}
```

## Operations

**Logs**

```sh
docker compose logs -f nginx
docker compose logs -f excalidraw-room
docker compose logs -f yjs-relay
```

**Restart one service**

```sh
docker compose restart yjs-relay
```

**Smoke tests** (with the stack up on the default port)

```sh
# Socket.IO handshake — should start with `0{"sid":...`
curl 'http://localhost:8080/socket.io/?EIO=4&transport=polling'

# yjs-relay WebSocket — should print a 101 upgrade and stay open
wscat -c 'ws://localhost:8080/?room=smoke-test'
```

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

- **End-to-end encryption.** Both services see only ciphertext.
  - Freeform: AES-GCM-128, room key HKDF-derived client-side from the
    per-note `crypto_key` that lives inside the Etebase NotePayload.
    excalidraw-room is a plain broadcast hub; key never leaves the
    client.
  - Markdown / PDF: AES-GCM-256 over a custom framing
    (`[1B type][12B IV][ciphertext]`) the yjs-relay forwards verbatim.
    Same per-note key, full 32 bytes.
- **Stateless.** Neither service persists anything. Restarting the
  stack only kicks live peers; they reconnect, exchange state with
  whoever's still in the room, and continue.
- **Single shared port.** nginx multiplexes so the client setting holds
  one URL even though there are two protocols. If you really want to
  expose them on separate ports, edit `docker-compose.yml` to add
  `ports:` blocks to the inner services and drop `nginx`.

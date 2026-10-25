# Self-hosting quick start

Mindstream Notes is a local-first app. This guide deploys its **sync server**
(accounts, encrypted storage, sharing, and live rooms), **not** a browser-based
copy of the app. The supplied Docker Compose stack runs the server and
PostgreSQL together.

You need Git, Docker Engine, and the Docker Compose plugin (`docker compose`).
Commands below assume a Linux host and a shell.

Every setting is listed in [Server configuration](server-configuration.md), and
day-to-day tasks are in [Server administration](server-administration.md).

## 1. Install the server

Clone the complete repository; the Docker build uses files outside
`backend/server`:

```sh
git clone https://github.com/jannikgohr/mindstream-notes.git
cd mindstream-notes/backend/server
cp .env.example .env
```

Generate a strong database password:

```sh
openssl rand -hex 32
```

Edit `.env` and paste the generated password into `POSTGRES_PASSWORD`. For a
private server, leave the signup policy closed:

```dotenv
POSTGRES_PASSWORD=replace-with-generated-password
MINDSTREAM_SIGNUP=closed
MINDSTREAM_PORT=3735
MINDSTREAM_BIND=127.0.0.1
```

These lines show the values to edit; **keep the other settings** from
`.env.example`. Choose an access method below before sharing the server with
other devices.

Start the stack:

```sh
docker compose up -d --build
docker compose ps
curl -f http://127.0.0.1:3735/healthz
```

The last command should succeed. You can also inspect the server information:

```sh
curl http://127.0.0.1:3735/api/v1/mindstream/info/
```

The server log (`docker compose logs server`) starts with a warning that
`X-Forwarded-For` is believed from the configured networks. Under Docker it
always does. It reminds you to narrow `MINDSTREAM_TRUSTED_PROXIES` once you know
where your proxy connects from; see
[Trusted proxies](server-configuration.md#trusted-proxies).

## 2. Choose how clients connect

**Choose one** of the following. If you change `.env`, apply the change with
`docker compose up -d` from `backend/server`.

### Option A: IP address over HTTP (trusted networks only)

Use this for initial testing or for a trusted LAN without a reverse proxy.
Plain HTTP is **not recommended over the public internet**.

In `.env`:

```dotenv
MINDSTREAM_BIND=0.0.0.0
MINDSTREAM_PORT=3735
MINDSTREAM_TRUSTED_PROXIES=127.0.0.1/32
```

The last setting avoids trusting `X-Forwarded-For` headers from direct clients.
Restrict TCP port 3735 to the devices or private network that should connect;
do not forward it from your router to the internet. Docker routes published
ports past `ufw`, so a `ufw` rule on the server does not restrict this port.
Filter in front of the server instead (your router or a network firewall), or
bind to your server's specific LAN IP instead of `0.0.0.0`.

Apply the setting:

```sh
docker compose up -d
```

From another device on that network, open:

```text
http://192.168.1.50:3735/api/v1/mindstream/info/
```

Replace `192.168.1.50` with the server's actual LAN IP. In the app, use
`http://192.168.1.50:3735` as the server URL, including `http://`.

### Option B: Domain over HTTPS (an existing reverse proxy)

Use this if you already run a reverse proxy (for example, Caddy, nginx, Traefik,
or an integrated proxy manager) that handles HTTPS certificates.

Point your domain (for example, `notes.example.com`) at the reverse proxy.
Configure it to proxy requests to the Mindstream server over HTTP/1.1:

- `/api/`: API requests and live WebSocket connections (support WebSocket
  upgrades).
- `/join/`: invitation links.
- `/healthz`: used by the app's **Check URL** button.

Preserve the original `Host` header and forward `X-Forwarded-For`. Allow request
bodies up to 75 MiB, the server's own limit; nginx accepts only 1 MiB unless you
raise `client_max_body_size`. Do **not** expose `/admin/` through the public
proxy. [Server configuration](server-configuration.md#reverse-proxy) has a
complete nginx example.

**Proxy on the same host:** Keep `MINDSTREAM_BIND=127.0.0.1` and forward to
`http://127.0.0.1:3735`.

**Proxy on another host:** Set `MINDSTREAM_BIND=0.0.0.0` (or bind to an
appropriate reachable private interface), run `docker compose up -d`, and
forward to `http://<mindstream-host-ip>:3735`. **Firewall port 3735 so that only
your reverse proxy can connect**, in front of the server: a `ufw` rule on it
does not apply to ports Docker publishes. Configure `MINDSTREAM_TRUSTED_PROXIES` for the
proxy sources that the backend actually sees; Docker's published-port
networking can make that source appear as its bridge gateway. Do not trust
broad, untrusted networks merely to make forwarding work.

Test:

```sh
curl -f https://notes.example.com/healthz
curl https://notes.example.com/api/v1/mindstream/info/
```

In the app, use `https://notes.example.com` as the server URL (not `/api/`). If
sign-in reports `wrong_host`, check the forwarded `Host` header; alternatively
set `MINDSTREAM_PUBLIC_HOSTS=notes.example.com` in `.env` and recreate the
server container.

### Option C: Tailscale Serve (private HTTPS, no public ports)

Use this when you want HTTPS between devices on your Tailscale network, without
a public domain or traditional reverse proxy. Install and sign in to
[Tailscale](https://tailscale.com/download) on the server and client devices.
Make sure your tailnet has MagicDNS and HTTPS certificates enabled.

Keep the backend published only on loopback:

```dotenv
MINDSTREAM_BIND=127.0.0.1
MINDSTREAM_PORT=3735
```

Run Tailscale Serve **on the same host as Docker**. On Linux, changing the Serve
configuration needs root, unless you made your user the Tailscale operator once
with `sudo tailscale set --operator=$USER`:

```sh
sudo tailscale serve --bg --https=443 3735
tailscale serve status
```

Tailscale prints an HTTPS address like
`https://your-server.your-tailnet.ts.net`. Use that exact URL in the Mindstream
app on another device connected to your tailnet. With `--bg`, Serve keeps
running in the background and resumes after a reboot. To stop sharing:

```sh
sudo tailscale serve --https=443 off
```

Tailscale **Serve** is accessible to your tailnet, not the public internet;
**Funnel** is a different, public feature. Serve forwards the whole service, so
keep `MINDSTREAM_ADMIN_TOKEN` unset unless you separately protect
administrative routes.

See the
[Tailscale Serve documentation](https://tailscale.com/docs/features/tailscale-serve)
for setup and access-control details.

## 3. Create an account and connect the app

With `MINDSTREAM_SIGNUP=closed`, create a one-time signup code:

```sh
docker compose exec server mindstream-server signup-code create --note "First account"
```

Copy the printed code immediately; it is shown only once and expires after
seven days by default.

Install the
[Mindstream Notes app](https://github.com/jannikgohr/mindstream-notes/releases).
During setup or under **Settings → Account & Sync**, select **Self-hosted**,
enter the base URL for your chosen option, and use **Check URL**. Choose
**Create an account**, enter a username, an email address, a password twice and
the signup code, and confirm with **Create account**. Creating the keys takes a
few seconds. The app then shows your recovery key once; store it safely before
you continue. Then create a note and test **Sync now**. Your other devices sign
in with the same URL, username and password.

To let more people in, or to make signup by invite link possible, see
[Signing up](server-administration.md#signing-up).

## 4. Operations and backups

Useful commands from `backend/server`:

```sh
docker compose ps
docker compose logs --tail=100 server
docker compose exec server mindstream-server user list
```

**Back up both** the `postgres` volume and the `blobs` volume. Docker names them
after the folder, so `docker volume ls` lists them as `server_postgres` and
`server_blobs`. PostgreSQL
contains account records and encrypted data; the blob volume contains larger
attachments and, by default, the authenticator secret key. One backup without
the other is not sufficient. Also protect a copy of `.env`. See
[Backups](server-administration.md#backups) for details.

To upgrade, first make and verify a backup, then:

```sh
cd ~/mindstream-notes
git pull --ff-only
cd backend/server
docker compose up -d --build
```

The example `~/mindstream-notes` assumes you cloned into your home directory.
Review the [upgrade notes](server-administration.md#upgrading) before upgrading.
**Do not run `docker compose down -v`** unless you intentionally want to delete
persistent data.

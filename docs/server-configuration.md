# Sync server configuration

Every setting of the sync server in [backend/server](../backend/server), and how
it behaves behind a proxy. To set a server up for the first time, follow the
[self-hosting quick start](self-hosting.md). Accounts, signup codes, limits and
upgrades are in [Server administration](server-administration.md).

## Where settings go

The server listens on port 3735 over plain HTTP/1.1. Compose publishes it on
this machine's loopback address only, so a TLS-terminating reverse proxy on the
same machine is the way in from elsewhere. `MINDSTREAM_BIND` in `.env` changes
the address it is published on; read [Trusted proxies](#trusted-proxies) before
you do.

[.env.example](../backend/server/.env.example) holds the settings most servers
want to look at, with the choice of who may sign up at the top. The table below
lists every setting the server reads. Each one is also a command-line flag named
after it, so `MINDSTREAM_SIGNUP` is `--signup`.

Under Docker, a variable in `.env` only reaches the server if
[compose.yml](../backend/server/compose.yml) passes it on, and the **Compose**
column says which ones it does. _Not yet_ marks a setting the compose file does
not pass on: setting it in `.env` has no effect. Run the server binary directly
and every variable works.

| Variable                                              | Default           | Compose                  | Meaning                                                                                                                                |
| ----------------------------------------------------- | ----------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `MINDSTREAM_DATABASE_URL`                             | required          | from `POSTGRES_PASSWORD` | Postgres connection string                                                                                                             |
| `MINDSTREAM_DATABASE_CONNECTIONS`                     | 16                | _not yet_                | Connections kept open to Postgres                                                                                                      |
| `MINDSTREAM_LISTEN`                                   | 0.0.0.0:3735      | fixed by the image       | Address to listen on                                                                                                                   |
| `MINDSTREAM_BLOB_DIR`                                 | data/blobs        | fixed by the image       | Where large chunks are stored                                                                                                          |
| `MINDSTREAM_SIGNUP`                                   | closed            | yes                      | Who may sign up: `closed`, `invite` or `open`. See [signing up][signup]                                                                |
| `MINDSTREAM_PUBLIC_HOSTS`                             | empty             | yes                      | Hostnames clients use, when the proxy rewrites the Host header                                                                         |
| `MINDSTREAM_TRUSTED_PROXIES`                          | loopback only     | yes                      | Networks whose `X-Forwarded-For` is believed                                                                                           |
| `MINDSTREAM_AUTH_RATE_PER_MINUTE`                     | 10                | yes                      | Sign-in attempts per address per minute. 0 turns the limit off                                                                         |
| `MINDSTREAM_AUTH_RATE_BURST`                          | 20                | _not yet_                | Attempts an address may make at once before the rate applies                                                                           |
| `MINDSTREAM_LOOKUP_RATE_PER_MINUTE`                   | 30                | yes                      | Lookups of another account by name per account per minute. 0 turns the limit off                                                       |
| `MINDSTREAM_LOOKUP_RATE_BURST`                        | 30                | _not yet_                | Lookups an account may make at once before the rate applies                                                                            |
| `MINDSTREAM_UNKNOWN_NAMES_PER_DAY`                    | 20                | yes                      | Names an account may look up that turn out to be nobody's, per day. 0 turns the limit off                                              |
| `MINDSTREAM_MAX_CONNECTIONS_PER_ADDRESS`              | 128               | yes                      | Connections, and separately sockets, one address may hold open. 0 turns the cap off                                                    |
| `MINDSTREAM_MAX_CONNECTIONS`                          | 10000             | yes                      | The same for the whole server. 0 leaves only the limit on open files                                                                   |
| `MINDSTREAM_ADMIN_TOKEN`                              | unset             | yes                      | Turns on the [interface for setting account limits][admin-api]                                                                         |
| `MINDSTREAM_SECRET_KEY`                               | unset             | yes                      | Key that seals authenticator secrets. See [account security][security]                                                                 |
| `MINDSTREAM_SECRET_KEY_FILE`                          | see below         | _not yet_                | Where that key is created when none is given                                                                                           |
| `MINDSTREAM_TOTP_ISSUER`                              | Mindstream Notes  | _not yet_                | Name an authenticator app shows for accounts here                                                                                      |
| `MINDSTREAM_APP_URL`                                  | the releases page | yes                      | Where the invite page sends people without the app                                                                                     |
| `MINDSTREAM_MAX_PAGE_BYTES`                           | 33554432          | _not yet_                | Most content one response carries. See [response size](#response-size)                                                                 |
| `MINDSTREAM_KEEP_REVISIONS`                           | 10                | yes                      | Earlier revisions kept per item besides the current one                                                                                |
| `MINDSTREAM_SESSION_IDLE_DAYS`                        | 90                | yes                      | Days a device's session may go unused before it ends. 0 never ends one for that                                                        |
| `MINDSTREAM_MAX_BODY_BYTES`                           | 78643200          | _not yet_                | Largest request body accepted                                                                                                          |
| `MINDSTREAM_MAX_BODY_BYTES_IN_FLIGHT`                 | 1073741824        | yes                      | Bytes of request bodies held in memory at once. See [request size](#request-size)                                                      |
| `MINDSTREAM_MAX_BODY_BYTES_IN_FLIGHT_PER_ADDRESS`     | 268435456         | yes                      | The same for one address. Keep it above `MINDSTREAM_MAX_BODY_BYTES`                                                                    |
| `MINDSTREAM_MAX_RESPONSE_BYTES_IN_FLIGHT`             | 536870912         | yes                      | Bytes of responses held in memory at once. See [response size](#response-size)                                                         |
| `MINDSTREAM_MAX_RESPONSE_BYTES_IN_FLIGHT_PER_ADDRESS` | 134217728         | yes                      | The same for one address                                                                                                               |
| `MINDSTREAM_INLINE_CHUNK_BYTES`                       | 20480             | _not yet_                | Chunks up to this size stay in the database                                                                                            |
| `MINDSTREAM_TEST_RESET`                               | false             | yes                      | Development only. Release builds leave out the route it turns on. See [server development](internal/server-development.md#conformance) |

[signup]: server-administration.md#signing-up
[admin-api]: server-administration.md#from-another-program
[security]: server-administration.md#account-security

A few variables are read by Compose, or by the logger, rather than by the server's
own settings:

| Variable               | Default                                  | Meaning                                                                                   |
| ---------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`    | required                                 | The database password. Compose builds `MINDSTREAM_DATABASE_URL` from it                   |
| `MINDSTREAM_PORT`      | 3735                                     | The port on the host the server is published on                                           |
| `MINDSTREAM_BIND`      | 127.0.0.1                                | The host address that port is published on. See [trusted proxies](#trusted-proxies)       |
| `MINDSTREAM_CPU_LIMIT` | 0.0                                      | CPU cap in cores. 0.0 leaves it uncapped. Docker refuses a cap above the host's CPU count |
| `RUST_LOG`             | `mindstream_server=info,tower_http=warn` | Log levels. Compose does not pass it on                                                   |

The memory limit is 4 GiB, set as `memory` in `compose.yml`. Edit it there to
change it, together with the limits under [response size](#response-size).

`GET /api/v1/mindstream/info/` returns the server's version, protocol level and
signup policy as JSON. `GET /healthz` answers when the server is up; the app's
**Check URL** button calls it.

## Host names

A sign-in names the host it was made for, and the server refuses one made for
another host. If signing in fails with `wrong_host` behind a proxy, set
`MINDSTREAM_PUBLIC_HOSTS`.

## Trusted proxies

The sign-in limit counts per client address. Behind a proxy that address comes
from `X-Forwarded-For`, which the server believes only from trusted networks:
loopback alone unless `MINDSTREAM_TRUSTED_PROXIES` names more, and exactly what
it names when it does. An explicitly empty list trusts nothing at all. Whoever
connects from a trusted network picks the address they are counted under, so
never trust networks with strangers on them.

The server refuses to listen past loopback without the variable set at all.
Name the networks of the proxies you run, loopback included if one of them is
local, or `127.0.0.1/32` for none. Under Docker the compose file sets the
private ranges for you, since the port published on any address but loopback
hands connections to the server from the Docker network's gateway, which is a
private address. Narrow it together with `MINDSTREAM_BIND`, and read the warning
the server logs at startup. It logs that warning whenever it listens past
loopback with trusted networks set, which under compose is always.

Docker publishes ports past `ufw`; see
[the quick start](self-hosting.md#option-a-ip-address-over-http-trusted-networks-only).

## Connection limits

The connection caps count the same way. An address may hold
`MINDSTREAM_MAX_CONNECTIONS_PER_ADDRESS` connections open and as many live
sockets, where a socket is an open note or the change feed of a device. An IPv6
address is counted with its whole /64. A trusted proxy is not held to the
connection cap, since every client behind it arrives from its address, but the
sockets it forwards are counted per client. If clients reach the server through
something that hides their addresses and sends no `X-Forwarded-For`, such as a
NAT, they share one allowance: raise the cap or set it to 0.

`MINDSTREAM_MAX_CONNECTIONS` counts every connection, a trusted proxy's
included. Each one is an open file, and a server that may open no more cannot
take a connection from anyone, so the server raises its limit on open files as
far as the system allows and keeps the total under it. If it says at startup
that the limit leaves too little room, raise the limit (`ulimit -n`, or
`LimitNOFILE` under systemd). A connection on which nothing has moved either way
for two minutes is closed. The server pings every open socket every 30 seconds,
so a live socket never counts as quiet, and neither does it for a proxy with
nginx's default 60-second read timeout.

### Timeouts

The server cuts off a client that is too slow: a request head has 30 seconds,
a body has to arrive at about 1 KiB a second and an answer has to be taken at
about 16 KiB a second, and neither may take more than about half an hour. It
does not serve HTTP/2, so a proxy in front speaks HTTP/1.1 to it, whatever it
speaks to clients.

## Response size

One response carries at most `MINDSTREAM_MAX_PAGE_BYTES` of content, metadata
and keys. The app pages through anything larger by itself. An item too large for
any page goes out alone, but it still has to fit the in-flight limits below,
or the answer is `503`.

A response stays in memory until the client has taken it, and encoding one takes
about as much again. `MINDSTREAM_MAX_RESPONSE_BYTES_IN_FLIGHT` is what the server
holds at once, and `MINDSTREAM_MAX_RESPONSE_BYTES_IN_FLIGHT_PER_ADDRESS` what one
address may hold of that. An answer that would go past either is 503, and the app
tries again later. Answers of 64 KiB or less are not counted, so the health check
and small syncs go on working when the room is full. Neither setting is held
below `MINDSTREAM_MAX_PAGE_BYTES` plus 1 MiB, because a full page has to fit, and
it goes out a little larger than it weighs. Add twice this and twice the setting for
request bodies, and keep the sum under the memory the server has: with the
defaults that is 3 GiB of the 4 GiB in `compose.yml`.

## Request size

A request body is held in memory until the request is done, and decoding it
takes about as much again, so these limits are worth keeping well under the
memory the server has. `MINDSTREAM_MAX_BODY_BYTES` is the largest one body may
be. `MINDSTREAM_MAX_BODY_BYTES_IN_FLIGHT` is what the server holds at once, and
`MINDSTREAM_MAX_BODY_BYTES_IN_FLIGHT_PER_ADDRESS` what one address may hold of
that. A body that would go past either is cut off and answered 503, and the app
tries again later. Everyone behind a proxy that is not in
`MINDSTREAM_TRUSTED_PROXIES` counts as one address. What signs in or signs up
takes 64 KiB at most, whatever these say.

## Reverse proxy

The server speaks plain HTTP/1.1 on loopback; TLS, HTTP/2 and public headers are
the reverse proxy's job. Pass the original `Host` through (or set
`MINDSTREAM_PUBLIC_HOSTS`), forward `X-Forwarded-For`, and route `/api/`,
`/join/` and `/healthz`. Live editing and the change feed use WebSockets under `/api/`,
so the proxy has to pass upgrades there. Keep `/admin/` off the public internet.

A proxy that caps request bodies has to allow `MINDSTREAM_MAX_BODY_BYTES`
(75 MiB by default), or large attachments fail to upload. nginx's own cap is
1 MiB. A minimal nginx front looks like this:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    server_name notes.example.com;
    ssl_certificate     /etc/ssl/notes.example.com/fullchain.pem;
    ssl_certificate_key /etc/ssl/notes.example.com/privkey.pem;
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;

    # MINDSTREAM_MAX_BODY_BYTES
    client_max_body_size 75m;

    location /api/ {
        proxy_pass http://127.0.0.1:3735;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
    }
    location /join/ {
        proxy_pass http://127.0.0.1:3735;
        proxy_set_header Host $host;
    }
    location = /healthz {
        proxy_pass http://127.0.0.1:3735;
        proxy_set_header Host $host;
    }
}
server {
    listen 80;
    server_name notes.example.com;
    return 301 https://$host$request_uri;
}
```

## What is on disk

Chunks larger than `MINDSTREAM_INLINE_CHUNK_BYTES` are files under
`MINDSTREAM_BLOB_DIR`, one file per chunk. A write is answered only after its
files and the directories it touched have been synced, so what the server
acknowledged survives a power cut.

`MINDSTREAM_SECRET_KEY_FILE` defaults to `secret.key` in the blob directory.
Under compose both live in the `blobs` volume, mounted at `/data`. What to back
up is in [Backups](server-administration.md#backups).

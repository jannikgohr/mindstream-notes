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
is the full list.

Under Docker, a variable in `.env` only reaches the server if
[compose.yml](../backend/server/compose.yml) passes it on, and the **Compose**
column says which ones it does. _Not yet_ marks a setting the server reads but
the compose file does not pass on yet: setting it in `.env` has no effect for
now. Passing them on is planned. Run the server binary directly and every
variable works.

| Variable                                 | Default           | Compose                  | Meaning                                                                             |
| ---------------------------------------- | ----------------- | ------------------------ | ----------------------------------------------------------------------------------- |
| `MINDSTREAM_DATABASE_URL`                | required          | from `POSTGRES_PASSWORD` | Postgres connection string                                                          |
| `MINDSTREAM_DATABASE_CONNECTIONS`        | 16                | _not yet_                | Connections kept open to Postgres                                                   |
| `MINDSTREAM_LISTEN`                      | 0.0.0.0:3735      | fixed by the image       | Address to listen on                                                                |
| `MINDSTREAM_BLOB_DIR`                    | data/blobs        | fixed by the image       | Where large chunks are stored                                                       |
| `MINDSTREAM_SIGNUP`                      | closed            | yes                      | Who may sign up: `closed`, `invite` or `open`. See [signing up][signup]             |
| `MINDSTREAM_PUBLIC_HOSTS`                | empty             | yes                      | Hostnames clients use, when the proxy rewrites the Host header                      |
| `MINDSTREAM_TRUSTED_PROXIES`             | loopback only     | yes                      | Networks whose `X-Forwarded-For` is believed                                        |
| `MINDSTREAM_AUTH_RATE_PER_MINUTE`        | 10                | yes                      | Sign-in attempts per address per minute. 0 turns the limit off                      |
| `MINDSTREAM_AUTH_RATE_BURST`             | 20                | _not yet_                | Attempts an address may make at once before the rate applies                        |
| `MINDSTREAM_MAX_CONNECTIONS_PER_ADDRESS` | 128               | yes                      | Connections, and separately sockets, one address may hold open. 0 turns the cap off |
| `MINDSTREAM_MAX_CONNECTIONS`             | 10000             | yes                      | The same for the whole server. 0 leaves only the limit on open files                |
| `MINDSTREAM_ADMIN_TOKEN`                 | unset             | yes                      | Turns on the [interface for setting account limits][admin-api]                      |
| `MINDSTREAM_SECRET_KEY`                  | unset             | yes                      | Key that seals authenticator secrets. See [account security][security]              |
| `MINDSTREAM_SECRET_KEY_FILE`             | see below         | _not yet_                | Where that key is created when none is given                                        |
| `MINDSTREAM_TOTP_ISSUER`                 | Mindstream Notes  | _not yet_                | Name an authenticator app shows for accounts here                                   |
| `MINDSTREAM_APP_URL`                     | the releases page | yes                      | Where the invite page sends people without the app                                  |
| `MINDSTREAM_MAX_PAGE_BYTES`              | 33554432          | _not yet_                | Most content one response carries. See [response size](#response-size)              |
| `MINDSTREAM_KEEP_REVISIONS`              | 10                | yes                      | Earlier revisions kept per item besides the current one                             |
| `MINDSTREAM_SESSION_IDLE_DAYS`           | 90                | yes                      | Days a device's session may go unused before it ends. 0 never ends one for that     |
| `MINDSTREAM_MAX_BODY_BYTES`              | 78643200          | _not yet_                | Largest request body accepted                                                       |
| `MINDSTREAM_INLINE_CHUNK_BYTES`          | 20480             | _not yet_                | Chunks up to this size stay in the database                                         |

[signup]: server-administration.md#signing-up
[admin-api]: server-administration.md#from-another-program
[security]: server-administration.md#account-security

`GET /api/v1/mindstream/info/` returns the server's version, protocol level and
signup policy as JSON. `GET /healthz` answers when the server is up; the app's
**Check URL** button calls it.

## Host names

A login names the host it was made for, and the server refuses one made for
another host. If logins fail with `wrong_host` behind a proxy, set
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

Docker routes published ports past `ufw`, so a `ufw` rule on the host does not
restrict who reaches the server. Use `MINDSTREAM_BIND` or a firewall in front
of the host.

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

A request has to arrive in good time, or its connection is closed. Its head gets
30 seconds, counted from when the connection opens or the previous answer on it
went out, so a connection kept open between requests is closed after 30 quiet
seconds too. Its body gets 30 seconds to get going and has to have come at
1 KiB a second on average since. HTTP/2 is not served: a proxy in front speaks
HTTP/1.1 to the server, whatever it speaks to clients.

## Response size

A response is built in memory, so the content one response carries is held to
`MINDSTREAM_MAX_PAGE_BYTES`. A list ends its page early when the next item would
not fit. Anything else sends the items that fit with their content and the rest
as the uids of their chunks, which the client then asks for again. The client
library does that by itself.

## Reverse proxy

The server speaks plain HTTP/1.1 on loopback; TLS, HTTP/2 and public headers are
the reverse proxy's job. Pass the original `Host` through (or set
`MINDSTREAM_PUBLIC_HOSTS`), forward `X-Forwarded-For`, and route `/api/`,
`/join/` and `/healthz`. Rooms and the change feed are WebSockets under `/api/`,
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
`MINDSTREAM_BLOB_DIR`, one file per upload. An upload is answered only after its
file and the directories the write touched have been synced, so what the server
acknowledged survives a power cut. Back the blob directory up together with the
database: each is useless without the other.

`MINDSTREAM_SECRET_KEY_FILE` defaults to `secret.key` in the blob directory.
Under compose both live in the `blobs` volume, mounted at `/data`.

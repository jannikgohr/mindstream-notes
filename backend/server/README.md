# Mindstream server

The sync server for Mindstream Notes: accounts, encrypted storage and sharing
in one process on Postgres. It speaks the protocol of the Etebase client
library the app ships, so everything stored here is ciphertext. The design and
the reasons behind it are in
[docs/server-design.md](../../docs/server-design.md).

Licensed AGPL-3.0, unlike the app. See [LICENSE](LICENSE).

## Run it

```sh
cd backend/server
cp .env.example .env    # then set POSTGRES_PASSWORD in it
docker compose up -d --build
```

The server listens on port 3735 over plain HTTP. Put a TLS-terminating reverse
proxy in front for anything but local use.

[.env.example](.env.example) holds the settings most servers want to look at,
with the choice of who may sign up at the top. The table below is the full
list. Under compose a variable only reaches the server if
[compose.yml](compose.yml) passes it on.

| Variable                                 | Default           | Meaning                                                                             |
| ---------------------------------------- | ----------------- | ----------------------------------------------------------------------------------- |
| `MINDSTREAM_DATABASE_URL`                | required          | Postgres connection string                                                          |
| `MINDSTREAM_LISTEN`                      | 0.0.0.0:3735      | Address to listen on                                                                |
| `MINDSTREAM_BLOB_DIR`                    | data/blobs        | Where large chunks are stored                                                       |
| `MINDSTREAM_SIGNUP`                      | closed            | Who may sign up: `closed`, `invite` or `open`. See below                            |
| `MINDSTREAM_PUBLIC_HOSTS`                | empty             | Hostnames clients use, when the proxy rewrites the Host header                      |
| `MINDSTREAM_TRUSTED_PROXIES`             | see below         | Networks whose `X-Forwarded-For` is believed                                        |
| `MINDSTREAM_AUTH_RATE_PER_MINUTE`        | 10                | Sign-in attempts per address per minute. 0 turns the limit off                      |
| `MINDSTREAM_AUTH_RATE_BURST`             | 20                | Attempts an address may make at once before the rate applies                        |
| `MINDSTREAM_MAX_CONNECTIONS_PER_ADDRESS` | 128               | Connections, and separately sockets, one address may hold open. 0 turns the cap off |
| `MINDSTREAM_MAX_CONNECTIONS`             | 10000             | The same for the whole server. 0 turns the cap off                                  |
| `MINDSTREAM_ADMIN_TOKEN`                 | unset             | Turns on the interface for setting account limits                                   |
| `MINDSTREAM_SECRET_KEY`                  | unset             | Key that seals authenticator secrets. See below                                     |
| `MINDSTREAM_SECRET_KEY_FILE`             | see below         | Where that key is created when none is given                                        |
| `MINDSTREAM_TOTP_ISSUER`                 | Mindstream Notes  | Name an authenticator app shows for accounts here                                   |
| `MINDSTREAM_APP_URL`                     | the releases page | Where the invite page sends people without the app                                  |
| `MINDSTREAM_MAX_PAGE_BYTES`              | 33554432          | Most content one response carries. See below                                        |
| `MINDSTREAM_KEEP_REVISIONS`              | 10                | Earlier revisions kept per item besides the current one                             |
| `MINDSTREAM_MAX_BODY_BYTES`              | 78643200          | Largest request body accepted                                                       |
| `MINDSTREAM_INLINE_CHUNK_BYTES`          | 20480             | Chunks up to this size stay in the database                                         |
| `MINDSTREAM_TEST_RESET`                  | false             | Serves a route that wipes accounts. For the client's tests only                     |

A login names the host it was made for, and the server refuses one made for
another host. If logins fail with `wrong_host` behind a proxy, set
`MINDSTREAM_PUBLIC_HOSTS`.

The sign-in limit counts per client address. Behind a proxy that address
comes from `X-Forwarded-For`, which the server believes only from trusted
networks: by default loopback and the private ranges. If the server is
reachable directly from private addresses you do not control, narrow
`MINDSTREAM_TRUSTED_PROXIES`, or a caller there can pick the address it is
counted under.

The connection caps count the same way. An address may hold
`MINDSTREAM_MAX_CONNECTIONS_PER_ADDRESS` connections open and as many live
sockets, where a socket is an open note or the change feed of a device. An
IPv6 address is counted with its whole /64. A trusted proxy is not held to
the connection cap, since every client behind it arrives from its address,
but the sockets it forwards are counted per client. If clients reach the
server through something that hides their addresses and sends no
`X-Forwarded-For`, such as a NAT, they share one allowance: raise the cap or
set it to 0.

A response is built in memory, so the content one response carries is held
to `MINDSTREAM_MAX_PAGE_BYTES`. A list ends its page early when the next item
would not fit. Anything else sends the items that fit with their content and
the rest as the uids of their chunks, which the client then asks for again.
The client library does that by itself.

`GET /api/v1/mindstream/info/` returns the server's version, protocol level
and signup policy as JSON.

### What is on disk

Chunks larger than `MINDSTREAM_INLINE_CHUNK_BYTES` are files under
`MINDSTREAM_BLOB_DIR`, one file per upload. An upload is answered only after
its file and the directories the write touched have been synced, so what the
server acknowledged survives a power cut. Back the blob directory up together
with the database: each is useless without the other.

## Administer

The same binary manages accounts. It needs the database variable and nothing
else:

```sh
docker compose exec server mindstream-server user list
docker compose exec server mindstream-server user disable <username>
docker compose exec server mindstream-server user enable <username>
docker compose exec server mindstream-server user delete <username>
```

Disabling an account ends its sessions and keeps its data. Deleting one
removes every collection it owns, for the other members too. The server never
holds a password or a key, so it cannot reset a password.

## Signing up

`MINDSTREAM_SIGNUP` says who may create an account.

| Value    | Who can sign up                                                         |
| -------- | ----------------------------------------------------------------------- |
| `closed` | Someone you gave a signup code                                          |
| `invite` | That, and someone holding an invite link that was made to allow signups |
| `open`   | Anyone who can reach the server                                         |

You cannot create an account for someone, because an account's keys are made
on that person's own device. A signup code is how you let one person in:

```sh
docker compose exec server mindstream-server signup-code create --note "for Ann"
docker compose exec server mindstream-server signup-code list
docker compose exec server mindstream-server signup-code revoke <id>
```

The code is printed once. It is good for one signup within a week, or within
`--days` of your choosing.

With `invite`, any admin of a shared space can make a link that also lets its
holder sign up. Choose it when the people on your server should be able to
bring in others without asking you.

## Invite links

A member shares a space by link as well as by username. A link is an address
on this server, `/join/<id>#<secret>`. Browsers keep the part after the `#` to
themselves, so the server never sees the secret and cannot open what the link
carries.

Opened in a browser, a link shows a page that tells the person to paste it
into the app. Route `/join/` through your reverse proxy along with `/api/`, or
that page will be missing.

## Account security

An account can require a code from an authenticator app when signing in. The
codes are standard TOTP, so Google Authenticator, Bitwarden, Aegis and the
rest all work. Setting it up returns ten single-use backup codes.

The authenticator secrets are the one thing the server stores that it can
read back, because checking a code takes the secret itself. They are sealed
under a key that is kept outside the database. Give it as
`MINDSTREAM_SECRET_KEY`, 32 bytes as URL-safe base64, or let the server create
one on first start in `MINDSTREAM_SECRET_KEY_FILE`, which defaults to
`secret.key` in the blob directory.

Back that key up. Without it every authenticator set up so far stops working
and each of those accounts needs the reset below. Keep its backup apart from
the database's if you can. Someone holding both can make valid codes, though
they still need a password to use one.

Someone who has lost the authenticator and the backup codes, and has no device
still signed in, needs you:

```sh
docker compose exec server mindstream-server user reset-2fa <username>
```

Signing in then takes the password alone. Be sure the person asking owns the
account before you run it.

An account can also have a recovery key, which sets a new password when the
old one is forgotten. The server never sees it. It stores a public key and a
second copy of the account's keys that only the recovery key opens, and a
reset with it still asks for the code when the account has an authenticator.
Without a recovery key or a signed-in device, a forgotten password means the
data on the server cannot be read by anyone.

Each device that signs in gets its own session, which the user can list and
end. A new password or a new authenticator signs every other device out.

## Limits

An account has no limits until it is given some:

```sh
docker compose exec server mindstream-server user limit <username> \
  --plan basic --storage-mib 1024 --max-spaces 10 --max-members 5 --max-item-mib 50
docker compose exec server mindstream-server user usage <username>
docker compose exec server mindstream-server user unlimit <username>
```

A collection counts against its owner, whoever writes into it. Once a limit is
reached the server refuses what would add to it with status 402 and a code
that says which limit: `storage_full`, `item_too_large`, `space_limit`,
`member_limit`, or `plan_lapsed` for an account set to `--read-only`.
Deletions are always accepted, and nothing is ever removed to bring an account
back under a limit.

The server can only limit what it can count. It cannot tell a note from an
attachment, so there is no limit on the number of notes.

Storage that is no longer needed is given back. An item keeps its current
revision and the `MINDSTREAM_KEEP_REVISIONS` before it. Older revisions go
when a new one arrives, and a deleted item keeps only the record that it was
deleted. Content goes with the last revision that used it, from the database
or the blob directory, and stops counting against the owner at that moment.
The exception for deletions covers deletions only: a write that calls itself
one and carries content is held to the limits like any other.

### From another program

A billing system sets the same limits over HTTP. Set `MINDSTREAM_ADMIN_TOKEN`
and send it as a bearer token; without the variable the routes do not exist.

```sh
curl -X PUT http://localhost:3735/admin/v1/account/<username>/entitlements/ \
  -H "Authorization: Bearer $MINDSTREAM_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"plan":"basic","storageLimitBytes":1073741824,"maxSpaces":10,
       "maxMembersPerSpace":5,"maxItemBytes":52428800,"readOnly":false}'
curl http://localhost:3735/admin/v1/account/<username>/ \
  -H "Authorization: Bearer $MINDSTREAM_ADMIN_TOKEN"
curl -X DELETE http://localhost:3735/admin/v1/account/<username>/entitlements/ \
  -H "Authorization: Bearer $MINDSTREAM_ADMIN_TOKEN"
```

A field left out of the body is a limit not applied. This interface can set
limits and read usage, and nothing else: it cannot reach anything an account
stores. Keep it off the public internet all the same, by not routing
`/admin/` through the reverse proxy.

A signed-in client reads its own usage from `GET /api/v1/mindstream/usage/`.

## Develop

Tests need a Postgres. This starts one on a loopback port that the tests
default to:

```sh
docker compose -f backend/server/compose.dev.yml up -d
cd backend/server
cargo test
```

`MINDSTREAM_TEST_DATABASE_URL` points the tests at another database. They
create accounts with fresh names and leave their data behind.

The tests drive the server with the same client library the app uses:

- `tests/access.rs` tries to break each access rule: a read-only member
  writing, a removed member reading, an outsider guessing uids.
- `tests/sync.rs` covers what a syncing client relies on beyond the wire
  format, such as cursors and storage accounting.

The client library knows nothing of rooms, the change feed, second factors or
recovery, so those tests speak the wire format by hand:

- `tests/rooms.rs` and `tests/feed.rs` open real sockets.
- `tests/security.rs` signs its own requests with keys it makes up, and plays
  the authenticator app.

## Conformance

The client library has its own integration suite. It runs against a server
started with the reset route on:

```sh
MINDSTREAM_DATABASE_URL=postgres://mindstream:mindstream@127.0.0.1:15432/mindstream \
MINDSTREAM_LISTEN=127.0.0.1:13735 MINDSTREAM_SIGNUP=open MINDSTREAM_TEST_RESET=true \
MINDSTREAM_AUTH_RATE_PER_MINUTE=0 \
  cargo run &
node scripts/conformance.mjs 127.0.0.1:13735
```

The suite signs in far more often than the sign-in limit allows, which is why
the limit is off above. The script runs the `service` tests of the client in
[vendor/etebase-rs](../../vendor/etebase-rs), the copy the app ships. One of them, `signup_with_key`, is marked ignored upstream
because it cannot pass against any server.

## Benchmark

```sh
pnpm bench:backend --url http://localhost:3735 --label new \
  --compare .output/bench/backend/etebase.json
```

See [e2e-tests/README.md](../../e2e-tests/README.md#backend-benchmark).

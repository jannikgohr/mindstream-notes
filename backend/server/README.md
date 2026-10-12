# Mindstream server

The sync server for Mindstream Notes: accounts, encrypted storage and sharing
in one process on Postgres. It speaks the protocol of the Etebase client
library the app ships, so everything stored here is ciphertext. The design and
the reasons behind it are in
[docs/server-design.md](../../docs/server-design.md).

It does not yet replace the stack in [../docker-compose.yml](../docker-compose.yml).
Live collaboration still runs on the relays there.

Licensed AGPL-3.0, unlike the app. See [LICENSE](LICENSE).

## Run it

```sh
cd backend/server
POSTGRES_PASSWORD=<strong-random> docker compose up -d --build
```

The server listens on port 3735 over plain HTTP. Put a TLS-terminating reverse
proxy in front for anything but local use.

| Variable                          | Default          | Meaning                                                         |
| --------------------------------- | ---------------- | --------------------------------------------------------------- |
| `MINDSTREAM_DATABASE_URL`         | required         | Postgres connection string                                      |
| `MINDSTREAM_LISTEN`               | 0.0.0.0:3735     | Address to listen on                                            |
| `MINDSTREAM_BLOB_DIR`             | data/blobs       | Where large chunks are stored                                   |
| `MINDSTREAM_SIGNUP`               | closed           | `open` lets anyone who can reach the server sign up             |
| `MINDSTREAM_PUBLIC_HOSTS`         | empty            | Hostnames clients use, when the proxy rewrites the Host header  |
| `MINDSTREAM_TRUSTED_PROXIES`      | see below        | Networks whose `X-Forwarded-For` is believed                    |
| `MINDSTREAM_AUTH_RATE_PER_MINUTE` | 10               | Sign-in attempts per address per minute. 0 turns the limit off  |
| `MINDSTREAM_AUTH_RATE_BURST`      | 20               | Attempts an address may make at once before the rate applies    |
| `MINDSTREAM_ADMIN_TOKEN`          | unset            | Turns on the interface for setting account limits               |
| `MINDSTREAM_SECRET_KEY`           | unset            | Key that seals authenticator secrets. See below                 |
| `MINDSTREAM_SECRET_KEY_FILE`      | see below        | Where that key is created when none is given                    |
| `MINDSTREAM_TOTP_ISSUER`          | Mindstream Notes | Name an authenticator app shows for accounts here               |
| `MINDSTREAM_MAX_BODY_BYTES`       | 78643200         | Largest request body accepted                                   |
| `MINDSTREAM_INLINE_CHUNK_BYTES`   | 20480            | Chunks up to this size stay in the database                     |
| `MINDSTREAM_TEST_RESET`           | false            | Serves a route that wipes accounts. For the client's tests only |

A login names the host it was made for, and the server refuses one made for
another host. If logins fail with `wrong_host` behind a proxy, set
`MINDSTREAM_PUBLIC_HOSTS`.

The sign-in limit counts per client address. Behind a proxy that address
comes from `X-Forwarded-For`, which the server believes only from trusted
networks: by default loopback and the private ranges. If the server is
reachable directly from private addresses you do not control, narrow
`MINDSTREAM_TRUSTED_PROXIES`, or a caller there can pick the address it is
counted under.

`GET /api/v1/mindstream/info/` returns the server's version, protocol level
and signup policy as JSON.

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
the limit is off above. The script checks out the client at the revision the
app pins and runs its `service` tests. One of them, `signup_with_key`, is marked ignored upstream
because it cannot pass against any server.

## Benchmark

```sh
pnpm bench:backend --url http://localhost:3735 --label new \
  --compare .output/bench/backend/etebase.json
```

See [e2e-tests/README.md](../../e2e-tests/README.md#backend-benchmark).

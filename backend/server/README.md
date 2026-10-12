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

| Variable                          | Default      | Meaning                                                         |
| --------------------------------- | ------------ | --------------------------------------------------------------- |
| `MINDSTREAM_DATABASE_URL`         | required     | Postgres connection string                                      |
| `MINDSTREAM_LISTEN`               | 0.0.0.0:3735 | Address to listen on                                            |
| `MINDSTREAM_BLOB_DIR`             | data/blobs   | Where large chunks are stored                                   |
| `MINDSTREAM_SIGNUP`               | closed       | `open` lets anyone who can reach the server sign up             |
| `MINDSTREAM_PUBLIC_HOSTS`         | empty        | Hostnames clients use, when the proxy rewrites the Host header  |
| `MINDSTREAM_TRUSTED_PROXIES`      | see below    | Networks whose `X-Forwarded-For` is believed                    |
| `MINDSTREAM_AUTH_RATE_PER_MINUTE` | 10           | Sign-in attempts per address per minute. 0 turns the limit off  |
| `MINDSTREAM_AUTH_RATE_BURST`      | 20           | Attempts an address may make at once before the rate applies    |
| `MINDSTREAM_MAX_BODY_BYTES`       | 78643200     | Largest request body accepted                                   |
| `MINDSTREAM_INLINE_CHUNK_BYTES`   | 20480        | Chunks up to this size stay in the database                     |
| `MINDSTREAM_TEST_RESET`           | false        | Serves a route that wipes accounts. For the client's tests only |

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
holds a password or a key, so there is nothing to reset.

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

## Conformance

The client library has its own integration suite. It runs against a server
started with the reset route on:

```sh
MINDSTREAM_DATABASE_URL=postgres://mindstream:mindstream@127.0.0.1:15432/mindstream \
MINDSTREAM_LISTEN=127.0.0.1:13735 MINDSTREAM_SIGNUP=open MINDSTREAM_TEST_RESET=true \
  cargo run &
node scripts/conformance.mjs 127.0.0.1:13735
```

The script checks out the client at the revision the app pins and runs its
`service` tests. One of them, `signup_with_key`, is marked ignored upstream
because it cannot pass against any server.

## Benchmark

```sh
pnpm bench:backend --url http://localhost:3735 --label new \
  --compare .output/bench/backend/etebase.json
```

See [e2e-tests/README.md](../../e2e-tests/README.md#backend-benchmark).

# Developing the sync server

Tests, coverage, the client conformance run and the benchmark for the server in
[backend/server](../../backend/server). Why it is built the way it is is in
[server-design.md](server-design.md). The disposable server the app's end-to-end
suites run against is a different thing, covered in
[e2e/backend-stack.md](e2e/backend-stack.md).

## Tests

Tests need a Postgres. This starts one on a loopback port that the tests default
to:

```sh
docker compose -f backend/server/compose.dev.yml up -d
cd backend/server
cargo test
```

`MINDSTREAM_TEST_DATABASE_URL` points the tests at another database. They create
accounts with fresh names and leave their data behind.

The tests drive the server with the same client library the app uses:

- [`tests/access.rs`](../../backend/server/tests/access.rs) tries to break each
  access rule: a read-only member writing, a removed member reading, an outsider
  guessing uids.
- [`tests/sync.rs`](../../backend/server/tests/sync.rs) covers what a syncing
  client relies on beyond the wire format, such as cursors and storage
  accounting.

The client library knows nothing of rooms, the change feed, second factors or
recovery, so those tests speak the wire format by hand:

- [`tests/rooms.rs`](../../backend/server/tests/rooms.rs) and
  [`tests/feed.rs`](../../backend/server/tests/feed.rs) open real sockets.
- [`tests/security.rs`](../../backend/server/tests/security.rs) signs its own
  requests with keys it makes up, and plays the authenticator app.

## Coverage

CI runs the tests under `cargo-llvm-cov` and fails when line coverage drops
below the floor in
[`scripts/coverage.mjs`](../../backend/server/scripts/coverage.mjs). The
integration tests count too, because they run the server inside the test
process. With the same Postgres up, from the repository root:

```sh
rustup component add llvm-tools-preview   # once
cargo install cargo-llvm-cov --locked     # once
pnpm test:coverage:server
```

## Conformance

The client library has its own integration suite. It runs against a server
started with the reset route on, from `backend/server`:

```sh
MINDSTREAM_DATABASE_URL=postgres://mindstream:mindstream@127.0.0.1:15432/mindstream \
MINDSTREAM_LISTEN=127.0.0.1:13735 MINDSTREAM_SIGNUP=open MINDSTREAM_TEST_RESET=true \
MINDSTREAM_AUTH_RATE_PER_MINUTE=0 \
  cargo run &
node scripts/conformance.mjs 127.0.0.1:13735
```

The suite signs in far more often than the sign-in limit allows, which is why
the limit is off above. The script runs the `service` tests of the client in
[vendor/etebase-rs](../../vendor/etebase-rs), the copy the app ships. One of them,
`signup_with_key`, is marked ignored upstream because it cannot pass against any
server.

## Benchmark

```sh
pnpm bench:backend --url http://localhost:3735 --label new \
  --compare .output/bench/backend/etebase.json
```

See [e2e-tests/README.md](../../e2e-tests/README.md#backend-benchmark).

## Releases

The server has no releases of its own yet. When it gets them, they go out as
tags of its container image, and not as a release of this repository marked
latest. The app's updater reads `releases/latest/download/latest.json` from this
repository, and a server release in that place has no such file, so every
installed app would fail its update check.

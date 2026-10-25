# Mindstream server

The sync server for Mindstream Notes: accounts, encrypted storage, sharing and
live editing in one process on Postgres. The app encrypts everything before it
leaves the device, so everything stored here is ciphertext.

Licensed AGPL-3.0-only, unlike the app. See [LICENSE](LICENSE).

## Run it

```sh
cd backend/server
cp .env.example .env    # then set POSTGRES_PASSWORD in it
docker compose up -d --build
```

The server answers on port 3735 of this machine's loopback address, over plain
HTTP. To reach it from other devices, follow the
[self-hosting quick start](../../docs/self-hosting.md).

## Documentation

- [Self-hosting quick start](../../docs/self-hosting.md): install, connect the
  app, back up, upgrade
- [Configuration](../../docs/server-configuration.md): every setting, trusted
  proxies, connection limits, reverse proxies, what is on disk
- [Administration](../../docs/server-administration.md): accounts, signup codes,
  invite links, two-factor resets, storage limits, backups, upgrade notes
- [Development](../../docs/internal/server-development.md): tests, coverage, conformance,
  benchmark, releases
- [Design](../../docs/internal/server-design.md): what the server is and why

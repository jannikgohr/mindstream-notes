# Documentation

Guides for using Mindstream Notes, running its sync server and writing plugins.
Start with the [README](../README.md) for what the app is and where to get it.

## Using the app

- [Sync and sharing](sync-and-sharing.md): connecting a vault to a server,
  your recovery key, two-factor sign-in, shared folders and live editing
- [Importing notes](import.md): what each import format maps to, and how links
  survive
- [Backup and restore](backup-and-restore.md): what a backup holds, and the
  difference between restoring and merging
- [Custom themes](custom-themes.md): making your own theme preset, and the
  rules it has to meet
- [Plugins](plugins.md): installing and approving plugins, updates and
  signatures, and the plugins that come with the app
- [Known limitations](known-limitations.md): intentional trade-offs and what is
  not built yet. Read it before filing a bug about sync or history

## Self-hosting

- [Self-hosting quick start](self-hosting.md): run the sync server with Docker
  Compose and connect the app to it
- [Server configuration](server-configuration.md): every setting, trusted
  proxies, connection limits, reverse proxies, what is on disk
- [Server administration](server-administration.md): accounts, signup codes,
  invite links, two-factor resets, storage limits, backups, upgrade notes

## Writing plugins

- [Writing plugins](plugin-development.md): the manifest, contributions,
  permissions, the host API, runtime limits and signing
- [Batching host calls](plugin-batch-api.md): the experimental interface for
  sending several host calls at once
- [Rust starter](../plugin-sdk/rust/README.md): the authoring path the shipped
  plugins use
- [TypeScript SDK](../plugin-sdk/typescript/README.md): build a plugin with
  Node.js alone
- [Examples](../plugin-sdk/examples/README.md): installable plugins that do not
  ship with the app

## Building and contributing

- [Building](BUILDING.md): per-OS prerequisites, dev and release builds,
  Android
- [Contributing](../CONTRIBUTING.md): branches, commit messages, git hooks,
  tests and coverage
- [Internal documentation](internal/README.md): architecture, design notes,
  plans, test docs and audits for people working on the code

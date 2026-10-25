# Documentation

Guides for using Mindstream Notes, running its sync server and writing plugins.
Start with the [README](../README.md) for what the app is and where to get it.

## Using the app

- [Importing notes](import.md): what each import format maps to, and how links
  survive
- [Backup and restore](backup-and-restore.md): what a backup holds, and the
  difference between restoring and merging
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

- [Plugins](plugins.md): where plugins live and how they are trusted, the
  manifest, permissions, contributions, and signing
- [Batching host calls](plugin-batch-api.md): the experimental interface for
  sending several host calls at once
- [Rust starter](../plugin-sdk/rust/README.md): the authoring path the shipped
  plugins use
- [TypeScript SDK](../plugin-sdk/typescript/README.md): build a plugin with
  Node.js alone
- [Examples](../plugin-sdk/examples/README.md): installable plugins that do not
  ship with the app
- [Shipped plugin sources](../plugin-sdk/bundled/README.md): the Rust source of
  the Templates and Typst plugins

## Building and contributing

- [Building](BUILDING.md): per-OS prerequisites, dev and release builds,
  Android
- [Contributing](../CONTRIBUTING.md): branches, commit messages, git hooks,
  tests and coverage
- [Internal documentation](internal/README.md): architecture, design notes,
  plans, test docs and audits for people working on the code

# Documentation

Everything about Mindstream Notes that is too long or too specific for the
[README](../README.md).

## Self-hosting

- [Self-hosting quick start](self-hosting.md): run the sync server with Docker
  Compose and connect the app to it
- [Server configuration](server-configuration.md): every setting, trusted
  proxies, connection limits, reverse proxies, what is on disk
- [Server administration](server-administration.md): accounts, signup codes,
  invite links, two-factor resets, storage limits, backups, upgrade notes

## Using the app

- [Importing notes](import.md): what each import format maps to, and how links
  survive
- [Backup and restore](backup-restore-portability.md): what a vault archive
  holds and what a restore asks
- [Known limitations](known-limitations.md): intentional trade-offs and what is
  not built yet. Read it before filing a bug about sync or history

## Writing plugins

- [Plugins](plugins.md): where plugins live and how they are trusted, the
  manifest, permissions, contributions, and signing
- [Rust starter](../plugin-sdk/rust/README.md): the authoring path the shipped
  plugins use
- [TypeScript SDK](../plugin-sdk/typescript/README.md): build a plugin with
  Node.js alone
- [Examples](../plugin-sdk/examples/README.md): installable plugins that do not
  ship with the app
- [Shipped plugin sources](../plugin-sdk/bundled/README.md): the Rust source of
  the Templates and Typst plugins
- [Plugin host API design](plugin-host-api-design.md): the experimental batch
  interface for host calls

## Building and contributing

- [Building](BUILDING.md): per-OS prerequisites, dev and release builds,
  Android
- [Contributing](../CONTRIBUTING.md): branches, commit messages, git hooks,
  tests and coverage
- [Theming](theming.md): the colour, elevation and radius tokens and how to use
  them
- [Bits UI](bits-ui.md): maintaining dialogs and their tests
- [Developing the sync server](server-development.md): its tests, coverage,
  conformance run and benchmark
- [Memory footprint](memory.md): how to measure the app's memory and what moved
  it
- [Upstream fixes](upstream-fixes.md): local workarounds for dependency bugs
  still to report upstream

## Design

- [Architecture](architecture.md): how the frontend, IPC, Rust backend, sync
  and sharing fit together
- [Sync server design](server-design.md): what the server is and why it
  replaced the earlier stack
- [Storage ownership and recovery](storage-ownership-and-recovery.md): settings
  documents, locks, startup and deletion
- [First-run setup](onboarding.md): what setup does and where it stores its
  state
- [Shared ink and PDF documents](ink-pdf-unification-plan.md): how handwriting
  and PDFs share one document model
- [Vault runtime spike](vault-runtime-spike.md) and
  [vault browser storage audit](vault-browser-storage-audit.md): the evidence
  behind the multi-vault runtime

## Testing

- [Running the end-to-end tests](../e2e-tests/README.md): commands for every
  suite
- [Strategy](e2e/strategy.md): the test tiers and how to pick one
- [Flows](e2e/flows.md): the catalogue of flows worth covering
- [Status](e2e/status.md): what the real-app suite asserts today
- [Backlog](e2e/backlog.md): tests still to be written
- [Real-app harness](e2e/harness.md): the toolchain and env flags for the
  packaged-app suites
- [Test backend](e2e/backend-stack.md): the disposable server the collaboration
  suites run against
- [Ubuntu VM QA](e2e/ubuntu-vm-qa.md): manual checks on a Linux VM
- [Android plugin validation](android-plugin-validation.md): checks for the
  plugin host on a physical Android device, with the dated records of the
  [validation run](benchmarks/android-plugin-validation-2026-10-24.md), its
  [latency breakdown](benchmarks/android-plugin-profile-2026-10-24.md) and the
  [export save fix](benchmarks/android-export-fix-2026-10-25.md)

## Security and audits

- [Security review](security-review.md): open findings
- [September 2026 audit](audit-2026-09.md), with the fix records for
  [data](audit-data-fixes.md), [editors](audit-editor-fixes.md),
  [quality gates](audit-quality-fixes.md) and
  [security](audit-security-fixes.md)

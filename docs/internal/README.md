# Internal documentation

Notes for people working on Mindstream Notes: how the code fits together, the
design behind it, plans, test procedures, validation records and audits. They
describe the code and its history, not how to use the app. The user guides are
in the [documentation index](../README.md).

## Working on the code

- [Architecture](architecture.md): how the frontend, IPC, Rust backend, sync
  and sharing fit together
- [Theming](theming.md): the colour, elevation and radius tokens and how to use
  them
- [Bits UI](bits-ui.md): maintaining dialogs and their tests
- [Developing the sync server](server-development.md): its tests, coverage,
  conformance run and benchmark
- [Memory footprint](memory.md): how to measure the app's memory and what moved
  it
- [Upstream fixes](upstream-fixes.md): local workarounds for dependency bugs
  still to report upstream
- [Plugin host internals](plugin-host.md): package storage, migration, the
  runtime, the core plugins and maintaining the TypeScript SDK
- [Core plugin sources](../../plugin-sdk/bundled/README.md): building and
  testing the Rust source of the Templates and Typst plugins
- [Known limitations: implementation notes](limitations.md): the code behind
  each user-facing limitation, and the ones only developers meet
- [Importer performance](import-performance.md): how the importer scales and
  how to run the Wikipedia test vault
- [Writing documentation](writing-docs.md): the shared vocabulary and style
  rules for the user docs

## Design

- [Sync server design](server-design.md): what the server is and why it
  replaced the earlier stack
- [Storage ownership and recovery](storage-ownership-and-recovery.md): settings
  documents, locks, startup, deletion and the remaining platform checks
- [Backup portability](backup-restore-portability.md): the archive format,
  restore staging and recovery, and how they were verified
- [First-run setup](onboarding.md): what setup does and where it stores its
  state
- [Plugin host API design](plugin-host-api-design.md): which capabilities
  belong in the host, proposals for new ones, and why batching is shaped the
  way it is
- [Shared ink and PDF documents](ink-pdf-unification-plan.md): how handwriting
  and PDFs share one document model
- [Vault runtime spike](vault-runtime-spike.md) and
  [vault browser storage audit](vault-browser-storage-audit.md): the evidence
  behind the multi-vault runtime

## Testing

- [Running the end-to-end tests](../../e2e-tests/README.md): commands for every
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

# Internal documentation

Notes for people working on Mindstream Notes: how the code fits together, the
design behind it, test procedures, validation records and security notes. They
describe the code, not how to use the app. The user guides are
in the [documentation index](../README.md).

## Working on the code

- [Architecture](architecture.md): how the frontend, IPC, Rust backend, sync
  and sharing fit together
- [Markdown note editor](markdown-editor.md): the two copies of a Markdown
  note, and everything outside the editor that depends on them
- [Theming](theming.md): the colour, elevation and radius tokens and how to use
  them
- [Bits UI](bits-ui.md): maintaining dialogs and their tests
- [Developing the sync server](server-development.md): its tests, coverage,
  conformance run and benchmark
- [Build performance](build-performance.md): how development and CI builds stay
  fast, and the traps behind those settings
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

- [Browser support](browser-support.md): the worker SQLite proof, shared Rust
  storage, verification commands, and remaining porting work
- [Sync server design](server-design.md): the server's data layout, sync,
  live rooms, sharing and accounts, and the decisions behind them
- [Storage ownership and recovery](storage-ownership-and-recovery.md): settings
  documents, locks, startup, deletion and the remaining platform checks
- [Backup portability](backup-restore-portability.md): the archive format,
  restore staging and recovery
- [First-run setup](onboarding.md): what setup does and where it stores its
  state
- [Plugin host API design](plugin-host-api-design.md): which capabilities
  belong in the host, proposals for new capabilities, the decided but unbuilt
  note events, jobs and ink APIs, and why batching is shaped the way it is
- [Handwritten notes and PDFs](ink-and-pdf.md): the shared page model,
  PDF backgrounds, search text and what was left out
- [Vault runtime spike](vault-runtime-spike.md): the browser isolation evidence
  and the macOS 14 decision behind the multi-vault runtime

## Testing

- [Running the end-to-end tests](../../e2e-tests/README.md): commands for every
  suite
- [Strategy](e2e/strategy.md): the test tiers and how to pick one
- [Flows](e2e/flows.md): the flows worth covering, which spec covers each and
  what is still open
- [Real-app harness](e2e/harness.md): the toolchain and env flags for the
  packaged-app suites
- [Test backend](e2e/backend-stack.md): the disposable server the collaboration
  suites run against
- [Ubuntu VM QA](e2e/ubuntu-vm-qa.md): manual checks on a Linux VM
- [Android plugin validation](android-plugin-validation.md): how to check the
  plugin host on a physical Android device, with the dated records of the
  [validation run](benchmarks/android-plugin-validation-2026-10-24.md) and its
  [latency breakdown](benchmarks/android-plugin-profile-2026-10-24.md)

## Security

- [Security review](security-review.md): the trust boundaries and the risks we
  accepted instead of fixing

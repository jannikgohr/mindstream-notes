# Contributing

Thanks for working on Mindstream Notes! This page covers the conventions the
tooling enforces. It's worth a skim before your first commit, since the git
hooks will bounce anything that doesn't follow them.

For everything else:

- **Environment setup** (per-OS prerequisites, builds): [docs/BUILDING.md](docs/BUILDING.md)
- **How the app fits together:** [docs/architecture.md](docs/architecture.md)
- **Running the tests:** [e2e-tests/README.md](e2e-tests/README.md)

## Getting started

```sh
pnpm install        # also installs the husky git hooks
pnpm dev            # browser UI (mock store, no Rust)
pnpm tauri-dev      # the real desktop app
```

## Branches

Branch off `main` and give it a `<type>/<short-description>` name that matches
the change, like `feat/note-pinning`, `fix/trash-restore`, `refactor/sync-scopes`,
or `docs/architecture`. Open pull requests against `main`, and CI needs to be
green before it can merge.

## Commits

We use [Conventional Commits](https://www.conventionalcommits.org), with one
twist that catches most people the first time: the scope is required. The
`commit-msg` hook runs commitlint (its config is
[here](.config/commitlint/commitlint.config.cjs)) and expects:

```
type(scope): subject
```

- **type** is one of `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`,
  `ci`, `chore`, `style`, or `revert`, all lower-case.
- **scope** is required and lower-case. It names the area you touched, such as
  `sync`, `e2e`, `architecture`, or `config`. A bare `docs:` gets rejected;
  `docs(architecture):` is what it wants.
- **subject** is written in the imperative, with no full stop at the end, and the
  whole header stays under 100 characters.

```sh
# good
git commit -m "fix(sync): retry scoped push after a folder re-home"
git commit -m "docs(e2e): split the strategy doc"

# rejected
git commit -m "docs: add overview"        # missing scope
git commit -m "Fix(Sync): Retry."         # capitalised, trailing period
```

The commit body has no line-length limit, so wrap it however reads best.

## What the hooks do

`pnpm install` sets up husky, so these run on their own. If one fails it blocks
the commit or push; fix the underlying issue rather than skipping the hook.

| Hook           | What it runs                                                                          |
| -------------- | ------------------------------------------------------------------------------------- |
| **pre-commit** | `lint-staged` (prettier `--check` on staged web/docs files), then `format:rust:check` |
| **commit-msg** | `commitlint` (the rules above)                                                        |
| **pre-push**   | `pnpm verify` (`check`, `test`, `build`) and `pnpm verify:rust` (`cargo test`)        |

One thing to know about the pre-commit step: prettier runs in check mode, not
write mode, so it complains about unformatted files instead of fixing them for
you. It's easiest to format first and then stage:

```sh
pnpm format         # prettier (web + docs) plus rustfmt (Rust)
# or just one side:
pnpm format:web
pnpm format:rust
```

## Tests and coverage

You don't have to remember to run the tests before pushing. The pre-push hook
already runs the full `pnpm verify` (`check`, `test`, `build`) and
`pnpm verify:rust` (`cargo test`), so a failing test or a broken build stops the
push for you. While you're working it's usually quicker to run just the piece
you care about:

```sh
pnpm check          # svelte-check (types + Svelte diagnostics)
pnpm test           # vitest (frontend unit)
cd src-tauri && cargo test   # Rust unit
```

The logic layer is held at 80% line coverage on both sides, frontend through the
v8 provider and Rust through `cargo-llvm-cov`. Integration surfaces (IPC, network
sync, native dialogs, editor and canvas code) are left out of that number and
covered by the e2e suites instead. The pre-push hook doesn't measure coverage,
but CI does, and you can check it yourself:

```sh
pnpm test:coverage        # frontend, enforces 80%
pnpm test:coverage:rust   # Rust, enforces 80%
```

## CI

Every push to `main` and every pull request runs
[`.github/workflows/test.yml`](.github/workflows/test.yml): the `js` and `rust`
unit tests (on Linux, Windows, and macOS), `coverage`, `e2e` (the Playwright
browser-fallback suite), and `format` (prettier in check mode). The real-app e2e
tiers (T3 and T4) aren't wired into CI yet; see
[docs/e2e/status.md](docs/e2e/status.md).

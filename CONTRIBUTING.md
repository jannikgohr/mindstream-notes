# Contributing

Thanks for working on Mindstream Notes. This page covers the conventions the
tooling enforces — read it before your first commit, because the git hooks will
reject work that doesn't follow them.

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

Branch off `main` and name it `<type>/<short-description>` matching the kind of
change — e.g. `feat/note-pinning`, `fix/trash-restore`, `refactor/sync-scopes`,
`docs/architecture`. Open pull requests against `main`; CI must be green to merge.

## Commits

Commits follow [Conventional Commits](https://www.conventionalcommits.org), and
**a scope is required** — this is the rule people trip on first. The `commit-msg`
hook runs commitlint ([`.config/commitlint/commitlint.config.cjs`](.config/commitlint/commitlint.config.cjs)):

```
type(scope): subject
```

- **type** — one of `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`,
  `ci`, `chore`, `style`, `revert`. Lower-case.
- **scope** — **mandatory**, lower-case. The area touched, e.g. `sync`, `e2e`,
  `architecture`, `config`. `docs:` is rejected; `docs(architecture):` passes.
- **subject** — imperative, no trailing period, header ≤ 100 chars.

```sh
# good
git commit -m "fix(sync): retry scoped push after a folder re-home"
git commit -m "docs(e2e): split the strategy doc"

# rejected
git commit -m "docs: add overview"        # scope-empty
git commit -m "Fix(Sync): Retry."         # type/scope-case, trailing period
```

The body has no line-length limit, so paragraphs can wrap naturally.

## What the hooks run

`pnpm install` wires up husky. If a hook fails, the commit or push is blocked —
fix the cause rather than bypassing it.

| Hook           | Runs                                                                                  |
| -------------- | ------------------------------------------------------------------------------------- |
| **pre-commit** | `lint-staged` → `prettier --check` on staged web/docs files, then `format:rust:check` |
| **commit-msg** | `commitlint` (the rules above)                                                        |
| **pre-push**   | `pnpm verify` (`check` + `test` + `build`) and `pnpm verify:rust` (`cargo test`)      |

The pre-commit prettier step is **`--check`, not `--write`** — it fails on
unformatted files instead of fixing them. So format first, then stage:

```sh
pnpm format         # prettier (web + docs) + rustfmt (Rust)
# or just one side:
pnpm format:web
pnpm format:rust
```

## Before you push

`pnpm verify` runs on pre-push, but running it yourself is faster to iterate on:

```sh
pnpm check          # svelte-check (types + Svelte diagnostics)
pnpm test           # vitest (frontend unit)
cd src-tauri && cargo test   # Rust unit
```

**Coverage gate:** the logic layer is held at **80% line coverage** on both
sides — frontend via the v8 provider, Rust via `cargo-llvm-cov`. Integration
surfaces (IPC, network sync, native dialogs, editor/canvas) are excluded and
covered by e2e instead. Check locally with:

```sh
pnpm test:coverage        # frontend, enforces 80%
pnpm test:coverage:rust   # Rust, enforces 80%
```

## CI

Every push to `main` and every PR runs [`.github/workflows/test.yml`](.github/workflows/test.yml):
`js` + `rust` unit tests (Linux/Windows/macOS), `coverage`, `e2e` (Playwright
browser-fallback), and `format` (`prettier --check`). The real-app e2e tiers
(T3/T4) are not in CI yet — see [docs/e2e/status.md](docs/e2e/status.md).

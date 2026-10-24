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

The pre-push hook runs `pnpm check` and `pnpm test`, so a type error or a
failing frontend unit test stops the push for you. The build, `cargo test` and
the server's tests are left to CI; [`.husky/pre-push`](.husky/pre-push) says
why. While you're working it's usually quicker to run just the piece you care
about:

```sh
pnpm check          # svelte-check (types + Svelte diagnostics)
pnpm test           # vitest (frontend unit)
cd src-tauri && cargo test   # Rust unit
cd backend/server && cargo test   # sync server, needs Postgres (see its README)
```

On Linux, Rust coverage also tests the native tray menu. Install `xvfb` and
`xauth`, plus `dbus` for `dbus-run-session`. The coverage script starts a virtual
display and session bus when no display is available.

The app's logic layer is held at 80% line coverage on both sides, frontend
through the v8 provider and Rust through `cargo-llvm-cov`. Integration surfaces
(IPC, network sync, native dialogs, editor and canvas code) are left out of that
number and covered by the e2e suites instead. The sync server is measured
differently: its integration tests run the server inside the test process, so
they count, and its floor sits a little under the measured number and goes up as
tests land. The pre-push hook doesn't measure coverage, but CI does, and you can
check it yourself:

```sh
pnpm test:coverage          # frontend, enforces 80%
pnpm test:coverage:rust     # desktop Rust, enforces 80%
pnpm test:coverage:server   # sync server, enforces the floor in its script
```

One Rust test asks a question the rest of the suite can't: whether the wire
format the LanguageTool plugin's manifest describes is still the one the
service speaks. It needs a real server, so it is `#[ignore]`d and runs only
when you ask for it by name. It is never required:

```sh
MINDSTREAM_LT_ENDPOINT=http://localhost:8010 cargo test --test languagetool_contract -- --ignored --nocapture
```

Point it at whatever instance you already run. Everything else about the
checker is tested against an in-process stub — the app's own behaviour is what
those tests are about, and only a stub can assert what it received.

## Licences

Parts of this repository are under different licences. The
[README](README.md#license) lists them, and [REUSE.toml](REUSE.toml) says it
file by file. A contribution is made under the licence of the part it
changes:

- MIT OR Apache-2.0 for the app and everything not named below
- AGPL-3.0-only for `backend/server/`
- BSD-3-Clause for `vendor/etebase-rs/`
- MIT for `packages/svelte-kanban/`

A new file takes the licence of the folder it is in and needs no header. A
file that comes from somewhere else, or a folder under another licence, needs
an entry in `REUSE.toml`, and the text in `LICENSES/` if the licence is new
here. CI runs `reuse lint`, which fails when a file has no answer.

Whether a contribution to `backend/server/` from outside needs an agreement
first is not decided yet. See
[the design](docs/server-design.md#licensing-and-layout).

## CI

Every push to `main` and every pull request runs
[`.github/workflows/test.yml`](.github/workflows/test.yml): the `js` and `rust`
unit tests (on Linux, Windows, and macOS), `coverage`, `server` (the sync
server's tests under coverage, when the server changes), `e2e` (the Playwright
browser-fallback suite), and `format` (prettier in check mode). The `app-e2e`
Linux matrix runs the single-client and both multiremote Tauri suites under
Xvfb, with a disposable collaboration backend for T4. Coverage thresholds fail
CI even when Codecov uploads are unavailable. See
[docs/e2e/status.md](docs/e2e/status.md).

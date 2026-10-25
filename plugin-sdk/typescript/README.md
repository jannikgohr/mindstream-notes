# TypeScript plugin SDK

Build a Mindstream Notes plugin with Node.js 22.11 or later. Rust and WIT edits
are unnecessary. The SDK bundles TypeScript with esbuild and embeds it in a
QuickJS WebAssembly component. The same `plugin.wasm` runs on every supported
host. Arbitrary Node APIs, browser APIs and native npm addons are unavailable.

## Start a project

The SDK is not published yet. From the repository root, pack it:

```sh
pnpm install --frozen-lockfile
npm pack ./plugin-sdk/typescript --pack-destination /tmp
```

In your authoring directory, use the absolute path to that tarball:

```sh
npm exec --yes --package /tmp/mindstream-plugin-sdk-0.1.0.tgz -- mindstream-plugin create my-plugin --id com.example.my-plugin --sdk /tmp/mindstream-plugin-sdk-0.1.0.tgz
cd my-plugin
npm install
npm run typecheck
npm run build
npm run check
npm test
```

Use another temporary directory on Windows. No registry release is required.
The tarball contains the SDK's WIT package and starter assets. Install
`dist/package` from Settings → Plugins → **Install or update from folder**,
then approve its permissions for your vault. Only that folder belongs in a
plugin package; `node_modules` and source files are authoring inputs.

## Write an export

```ts
import {
  clock,
  definePlugin,
  notes,
  type Context,
  type Effect
} from '@mindstream/plugin-sdk';

export const invoke = definePlugin({
  countNotes(ctx: Context): Effect {
    return {
      effect: 'toast',
      message: `${notes.all().length} notes on ${clock.today('dddd', 0, ctx.locale)}`
    };
  }
});
```

Declare `notes.read` in `manifest.json`, and reference `countNotes` from a
script action. Exports receive a JSON object and return a JSON value
synchronously. Promises are refused. Return declarative effects to request
host actions. The app validates them before applying them.

Every invocation has a fresh guest instance. Persist state with `storage`,
which requires `pluginStorage.read` and/or `pluginStorage.write`. Import
`HostError` to catch refused host calls; `error.kind` is `denied`, `invalid`,
`unavailable`, or `failed`. Timeouts and cancellation stop the invocation.

Use `clock` for local dates and formatting, `uuid` or `randomBytes` for host
randomness, and `console` for bounded app logging. Guest `Date` uses UTC.
`clock.add` treats days and weeks as elapsed durations, so a DST transition
can shift the local wall time. Month and year shifts clamp to the target
month's last day.

`nativeTools.available` and `nativeTools.run` require
`nativeTools.runDeclared`. A tool must also be declared in the manifest.
Mobile hosts report tools unavailable. Keep portable features usable when a
tool cannot run.

Note exporters receive `ExportInput`, including the requested `format`.
Return `ExportResult` with a `file` containing a MIME type and either `text`
or `dataBase64`. For paged PNG or SVG exports, first return `pagesPdf` with
an `application/pdf` payload. The app counts its pages, then calls the same
export once per page with a one-based `page` number. Return that page's image
as `file`. The app supports up to 1,000 pages and bundles multiple images
in a ZIP file. See the Typst example for both paths.

## Test the built component

```js
import assert from 'node:assert/strict';
import { loadPlugin } from '@mindstream/plugin-sdk/testing';

const plugin = await loadPlugin('dist/plugin.wasm', {
  permissions: ['notes.read'],
  notes: [{ id: 'one', title: 'One' }],
  now: '2026-07-25T10:00:00Z',
  timeZone: 'UTC'
});
assert.deepEqual(await plugin.exports(), ['countNotes']);
assert.equal((await plugin.call('countNotes')).effect, 'toast');
```

The harness transpiles the built component and uses an in-memory host. It
preserves storage across calls and creates a fresh instance for each one.
Pass `settings`, `folders`, `tools`, `locale` and `storage` to model the
vault. Omitted permissions grant nothing. This checks plugin behavior;
Wasmtime's resource controls and OS process handling are tested in the Rust
runtime suite.

## SDK maintenance

Run `pnpm --filter @mindstream/plugin-sdk generate:types` after changing WIT.
The generator uses jco's guest bindings and adapts options and 64-bit integers
to QuickJS conventions. Tests compare the complete declarations against WIT,
including record fields and signatures. Plugin authors use the packed declarations
without generating or editing them.

## CLI

- `create <dir> --id <id> --name <name> --sdk <spec>` writes an empty project.
- `build --source src/main.ts --out dist/plugin.wasm` bundles and builds the
  component. `--minify` minifies its JavaScript; `--fast` selects the larger
  QuickJS engine build.
- `package --component dist/plugin.wasm --out dist/package` copies the
  manifest, component and referenced assets, including localized docs.
- `check dist/package` checks the schema version, permissions, referenced
  files, component imports and SDK export names. The app performs full
  validation again during installation.

See [the plugin contract](../../docs/plugins.md) for contributions, signing
and effects, and [the WIT package](../wit/world.wit) for the ABI.

## General host batches

The SDK exports `batch.execute(commands)`, `batch.text(value)`,
`batch.previous(index)` and `HostBatchError`. Commands are typed WIT operations
covering all current host capabilities. Ordered backward references can feed
text results to later commands across interfaces; `keep: false` skips returning
an intermediate to the guest. The first error stops later commands.
`HostBatchError` exposes the zero-based `index`, `phase`, `completed` handler
count, earlier kept `replies`, and original `kind`/`detail`. Validation failure
executes nothing; execution failure can leave partial effects in the stopping
operation; result-limit failure follows a successful handler whose result was
rejected. There is no rollback or automatic retry. Deadline/cancellation traps
remain fatal and cannot return progress. See the contract's recovery section
before retrying side effects or rebuilding a plan's backward references.

Use explicit plans of at most 128 commands, 1,024 text inputs, 1 MiB literal
request bytes and 8 MiB accounted cumulative results. A guest decision based
on a returned value requires another plan. Batching does not grant permissions
or skip existing path, storage, native-process or log/random limits. It also
does not guarantee lower CPU cost for in-process imports. The test host mirrors
the transport; actual budgets/cancellation still need runtime tests.

The app also enforces a 9 MiB argument-copy budget per host call while Wasmtime
lifts guest strings and lists, before the batch validator runs. The accounting
includes container overhead. Exhaustion ends the invocation as a trap, without
a `HostBatchError` or progress record. A request that fits lifting but exceeds
the 1 MiB batch literal limit still returns a normal validation failure. The
transfer budget resets per host call and is separate from guest memory and
host-to-guest results. See [runtime limits](../../docs/plugins.md#runtime-limits-and-lifecycle)
for scalar limits, including 8 MiB native-tool stdin and 4 MiB storage files.

New components importing this interface need a matching host. The expanded
experimental failure record requires rebuilding older batch guests; scalar
APIs remain. See [the contract and example](../../docs/plugin-batch-api.md).

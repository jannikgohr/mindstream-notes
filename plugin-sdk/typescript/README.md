# TypeScript plugin SDK

Build a Mindstream Notes plugin with Node.js 22.11 or later. Rust and WIT edits
are unnecessary. The SDK bundles TypeScript with esbuild and embeds it in a
QuickJS WebAssembly component. The same `plugin.wasm` runs on every supported
host. Arbitrary Node APIs, browser APIs and native npm addons are unavailable.

## Start a project

The SDK is private during the migration. From the repository root, pack it:

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

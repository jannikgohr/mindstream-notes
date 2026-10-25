# {{name}}

A Mindstream Notes plugin, written in TypeScript and built into a
WebAssembly component.

```sh
npm install
npm run build      # dist/package: the folder to install
npm run check      # catch manifest and export mistakes before installing
npm test           # build, then run test/ against the built component
```

Install `dist/package` with Settings → Plugins → **Install or update from
folder**, then approve it for the vault.

- `src/main.ts` is the plugin. Each key passed to `definePlugin` is an export
  the manifest can call.
- `manifest.json` declares what the plugin contributes and which permissions
  it needs. A host call without its permission throws a `HostError` of kind
  `denied`.
- `test/` runs the built component in Node against an in-memory host, so the
  tests exercise the same file the app runs.

The SDK documentation is in the Mindstream repository,
`docs/plugin-development.md`.

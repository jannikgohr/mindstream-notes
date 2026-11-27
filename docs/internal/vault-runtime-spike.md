# Vault runtime spike

The spike behind the multi-vault runtime, which is now built. It is kept for
the macOS 14 decision and to rerun the browser isolation probe. What is still
unchecked is tracked in the
[platform checks](storage-ownership-and-recovery.md#concurrent-vault-platform-checks).

## Reproduce the browser checks

From the repository root:

```shell
node src-tauri/scripts/vault-runtime-spike.mjs shared
node src-tauri/scripts/vault-runtime-spike.mjs isolated --skip-build
node src-tauri/scripts/vault-runtime-spike.mjs isolated --skip-build --keep-open
```

The runner builds the `vault_runtime_spike` example. It has a separate app
identifier and embedded probe page. It does not call the production app's boot
code or open vault databases, accounts, dictionaries, plugins, tray, or shortcuts.
Every run creates a fresh `.output/vault-runtime-spike/<mode>-<random>` folder.
It removes inherited WebView2 folder/argument overrides only from child
environments. Cleanup terminates only its recorded worker processes.

Each worker reports startup marker values, storage events, native window events,
and lifecycle events to `<vault>-events.jsonl`. Windows also reports browser
process IDs directly through WebView2 COM. `environment.json` and `summary.json`
record the run. Automatic checks terminate and restart A while B remains open.
This tests process termination, not power-loss durability.

With `--keep-open`, use A's "Open popout" and "Write marker" controls. Verify
that A's main window receives the popout write, B receives none, and B remains
interactive after A quits. "Quit worker" closes all windows of that worker.
Quit both workers to finish the runner. This probe does not implement ownership
locks, focus routing, a coordinator, or graceful editor flushing.

The Windows example reuses Tauri's Common Controls v6 manifest through
`build.rs`. Without it, the example exits before `main` with
`STATUS_ENTRYPOINT_NOT_FOUND`. Popout creation uses an async command because
Tauri documents a Windows deadlock for synchronous window creation.

## Windows result

On Windows (WebView2 154), two worker processes sharing one WebView2 folder
share a browser process and see each other's storage, while separate folders
keep vaults fully isolated, across restarts and popouts. That is why each vault
gets its own WebView2 folder, shared by its main window and popouts; the spike
did not test Linux or macOS, IPC, focus, update or shutdown.

## macOS compatibility decision

The owner approved macOS 14+ on 2026-10-10. The production config now sets
`minimumSystemVersion` to `14.0`. Persistent store identifiers require macOS 14+,
according to the [Tauri WebView API](https://docs.rs/tauri/2.11.1/tauri/webview/struct.WebviewWindowBuilder.html#method.data_store_identifier).
`data_directory` is unavailable for WKWebView. Incognito stores discard persisted
browser state and cannot replace persistent vault stores.

The spike never ran on macOS. Breaking changes there were accepted because
there were no real macOS users, so Dock, menu and Reopen behaviour remain a
release check on a packaged, signed `.app`, which the direct executable probe
cannot stand in for.

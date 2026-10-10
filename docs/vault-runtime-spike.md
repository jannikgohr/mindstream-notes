# Vault runtime spike

Status on 2026-10-10: Windows browser isolation and native popout checks pass.
The macOS lifecycle, Linux WebKit, and `tauri dev` host checks are pending.
This is a partial spike, not approval of process-per-vault.

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

## Windows results

Environment: Windows build 26300, WebView2 154.0.4258.62, Node 20.19.6,
Tauri 2.11.1, Rust 1.97.1. The probe uses the production renderer limit flag.

| Check                                   | Observed result                                                                           |
| --------------------------------------- | ----------------------------------------------------------------------------------------- |
| Two processes, shared WebView folder    | A and B report the same browser PID. B reads A's marker; A receives B's storage event.    |
| Two processes, separate WebView folders | Browser PIDs differ. Both initial markers are empty; no cross-vault storage event occurs. |
| Terminate and restart A with B alive    | Shared mode reads B's marker; isolated mode reads A's own persisted marker.               |
| Open A's popout through the native UI   | Popout reads A's marker and reports A's browser PID.                                      |
| Write through A's popout                | A's main window receives the update. B receives none.                                     |
| Quit A with its popout open             | Both A windows exit; B remains open and accepts another write.                            |

Recorded automatic runs: `shared-PUZMRs` and `isolated-9BZdpS`. Native UI run:
`isolated-eu3XxM`. Raw results remain under `.output/vault-runtime-spike`.
An earlier probe iteration reproduced the synchronous-command popout deadlock;
the final async version passed. WebView2 logged a Chrome window-class cleanup
warning on graceful exit; worker exits and isolation still completed correctly.

These results support separate WebView2 folders per vault and environment,
shared by that vault's main window and popouts. They do not prove Linux/macOS
behavior or IPC/focus/update/shutdown correctness. Renderer counts and memory
still need measurement with the real editor workload.

## macOS compatibility decision

The production config has no explicit minimum macOS version; the pinned Tauri
config defaults to 10.13. `data_directory` is unavailable for WKWebView.
Persistent store identifiers are available on macOS 14+ and iOS 17+, according
to the [Tauri WebView API](https://docs.rs/tauri/2.11.1/tauri/webview/struct.WebviewWindowBuilder.html#method.data_store_identifier).

Before choosing this design, decide whether concurrent vaults must support
macOS 13 and older. Supporting them requires another storage strategy or an
explicit feature restriction. Incognito stores discard persisted browser state
and are not a drop-in substitute. Do not silently fall back to shared storage.

Access to a macOS desktop is also needed for the packaged app gate. The current
session exposes Windows desktop automation; device-host access is disabled.
The example's direct executable launches cannot prove signed `.app` behavior.

## Remaining gate checks

- Package a disposable coordinator/worker prototype on macOS. Check Dock icons,
  activation policy, app menus, Cmd + Q, Dock Reopen, hide/show, focus, and worker
  crashes. Verify signing and shutdown/update behavior.
- Run separate-directory and popout checks on Linux WebKitGTK. Do not treat a
  shared-store run that happens to launch as evidence of supported concurrency.
- Probe `tauri dev` with the long-lived process as its supervised child. Exit
  and replace workers; prove that Vite and sibling workers survive.
- Verify Windows foreground grants and Wayland activation tokens with real
  launch requests. A button focusing its own process does not cover that path.
- Measure renderer ownership/counts and memory with real vaults and popouts.
- Implement and test the [browser-storage migration](vault-browser-storage-audit.md)
  before new workers use isolated stores.

Keep the architecture gate in the [implementation plan](root-vault-implementation-plan.md)
closed until these results and the macOS support decision are recorded.

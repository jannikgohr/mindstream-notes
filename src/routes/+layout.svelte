<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { ModeWatcher, mode } from 'mode-watcher';
  import { getSettingValue, isModified } from '$lib/settings/store.svelte';
  import { applyAccentColor, clearAccentColor } from '$lib/settings/accent';
  import {
    invokeOrFallback,
    drawingSetTheme,
    setNativeHotkeyDisplays
  } from '$lib/api';
  import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
  import UpdaterProgressDialog from '$lib/updater/ProgressDialog.svelte';
  import ShortcutHelpDialog from '$lib/components/ShortcutHelpDialog.svelte';
  import {
    displayBinding,
    getBinding,
    HOTKEY_COMMANDS,
    initHotkeys,
    isGlobalShortcutCommand,
    syncGlobalShortcuts,
    tauriAccelerator,
    teardownGlobalShortcuts
  } from '$lib/hotkeys';

  let { children } = $props();

  // Suppress the webview's default right-click menu in production builds.
  // We have our own context menus (file tree); the webview's default just
  // shows debug entries like "Inspect Element" / "Reload" that aren't part
  // of the product UX. Stays enabled in dev so DevTools remain reachable.
  onMount(() => {
    if (!import.meta.env.PROD) return;
    const block = (e: Event) => {
      // Custom menus call preventDefault() + stopPropagation() before this
      // listener runs, so they're already absent from the event stream.
      // Anything that bubbles up here is an unhandled right-click — kill it.
      e.preventDefault();
    };
    window.addEventListener('contextmenu', block);
    return () => window.removeEventListener('contextmenu', block);
  });

  // Install the global hotkey dispatcher once. Idempotent — the manager
  // guards against double-init internally, so this stays safe if the
  // root layout ever remounts (HMR, route swap). Returned teardown only
  // matters in tests; we drop it intentionally here.
  onMount(() => {
    initHotkeys();
    return () => {
      void teardownGlobalShortcuts();
    };
  });

  import { ui } from '$lib/state.svelte.js';

  // Periodic sync runs in a Rust tokio task — see
  // src-tauri/src/sync/scheduler.rs. This effect just forwards the
  // settings UI choice into that task via `set_sync_schedule`.
  // Schema options are live | 1m | 5m | 15m | manual; we map them
  // to a tick-cadence in seconds. `manual` flips the scheduler to
  // disabled.
  //
  // The Rust scheduler was previously a JS `setTimeout` self-
  // rescheduler here, which paused if the event loop got blocked
  // (long Crepe operation, complex tldraw paint) and was subject
  // to background-throttling on mobile webviews. Owning the tick
  // in Rust makes the cadence reliable.
  const INTERVAL_SECS: Record<string, number> = {
    live: 30,
    '1m': 60,
    '5m': 300,
    '15m': 900
  };

  // Re-apply the accent colour whenever the user changes it (or on
  // first mount, since $effect runs once for the initial values). The
  // helper only overrides --primary / --primary-foreground / --ring
  // when the setting differs from its schema default — leaving the
  // existing dark/light theme tokens intact for users who haven't
  // picked a custom accent.
  $effect(() => {
    const value = getSettingValue('appearance.accent') as string | undefined;
    if (isModified('appearance.accent') && value) {
      applyAccentColor(value);
    } else {
      clearAccentColor();
    }
  });

  // Mirror the resolved dark/light state + accent into the native
  // egui drawing toolbar (B2). The Rust side rebuilds `egui::Visuals`
  // on every push; idempotent re-pushes are cheap. We do this in the
  // root layout (not DrawingNoteEditor) so the toolbar's palette is
  // already up-to-date the moment the ink note opens — by the time
  // `drawing_show` lands on the render thread, a fresh
  // `Msg::SetTheme` has already been processed. `mode` from
  // mode-watcher resolves `system` against the prefers-color-scheme
  // media query and emits 'dark' | 'light' | undefined (undefined
  // = not yet resolved, treat as dark since that's our default).
  // `accentHex` falls back to null when the user hasn't picked a
  // custom accent so Rust uses the mode-appropriate shadcn default
  // (matching the CSS `--primary` token).
  $effect(() => {
    const resolved = $mode ?? 'dark';
    const dark = resolved === 'dark';
    const accent = getSettingValue('appearance.accent') as string | undefined;
    const accentHex = isModified('appearance.accent') && accent ? accent : null;
    void drawingSetTheme(dark, accentHex);
  });

  $effect(() => {
    const globalShortcutsEnabled =
      getSettingValue('hotkeys.globalShortcuts') === true;
    const displays = HOTKEY_COMMANDS.map((cmd) => {
      const binding = getBinding(cmd.id);
      return {
        commandId: cmd.id,
        display: displayBinding(binding) || null,
        accelerator: tauriAccelerator(binding)
      };
    });
    void setNativeHotkeyDisplays(displays);
    void syncGlobalShortcuts(
      globalShortcutsEnabled
        ? HOTKEY_COMMANDS.filter(isGlobalShortcutCommand).map((cmd) => {
            const binding = getBinding(cmd.id);
            return {
              commandId: cmd.id,
              accelerator: tauriAccelerator(binding)
            };
          })
        : []
    );
  });

  $effect(() => {
    const interval =
      (getSettingValue('account.syncInterval') as string | undefined) ?? 'live';
    // `manual` => scheduler disabled. `account.syncEnabled` false
    // also disables the loop. Either way we still send the
    // current interval so flipping enabled back on later picks up
    // the right cadence immediately.
    const enabled =
      getSettingValue('account.syncEnabled') === true && interval !== 'manual';
    const seconds = INTERVAL_SECS[interval] ?? 60;
    void invokeOrFallback<void>(
      'set_sync_schedule',
      { enabled, intervalSecs: seconds },
      // No-op fallback when running outside Tauri (browser dev
      // mode) — there's no Rust scheduler to talk to.
      async () => undefined
    );
  });
</script>

<ModeWatcher defaultMode="system" />

<div
  class="flex h-full w-full flex-col overflow-hidden bg-background text-foreground"
  style:--left-sidebar-width="{ui.leftSidebarWidth}px"
  style:--left-sidebar-enabled={Number(ui.leftSidebarOpen)}
>
  {@render children()}
</div>

<!-- Singleton confirm-dialog instance: lives at the root so any
     caller anywhere in the tree can `await confirm(...)` without
     stashing its own component. -->
<ConfirmDialog />

<!-- Singleton updater progress dialog. Driven by the helpers in
     $lib/updater/progress.svelte.ts — mounting it here means anything
     that drives that state gets the dialog for free, no per-call wiring. -->
<UpdaterProgressDialog />

<!-- Shortcut cheat-sheet overlay. Triggered by `global.showShortcutHelp`
     (Shift+? by default) and `openShortcutHelp()` from anywhere. -->
<ShortcutHelpDialog />

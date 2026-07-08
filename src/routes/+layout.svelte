<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { ModeWatcher, mode } from 'mode-watcher';
  import { getSettingValue, isModified } from '$lib/settings/store.svelte';
  import { prefersReducedMotion } from '$lib/reduce-motion.svelte';
  import { applyAccentColor, clearAccentColor } from '$lib/settings/accent';
  import {
    applyEditorTypography,
    applyUiFontSize
  } from '$lib/settings/appearance';
  import { invokeOrFallback } from '$lib/api/core';
  import { setNativeHotkeyDisplays } from '$lib/api/hotkeys';
  import { setTrashRetention, sweepTrashRetention } from '$lib/api/data';
  import LazyRootSingletons from '$lib/components/LazyRootSingletons.svelte';
  import {
    HOTKEY_COMMANDS,
    isGlobalShortcutCommand
  } from '$lib/hotkeys/catalogue';
  import { getBinding } from '$lib/hotkeys/store.svelte';
  import { initHotkeys } from '$lib/hotkeys/manager.svelte';
  import {
    displayBinding,
    globalShortcutAccelerator,
    tauriAccelerator
  } from '$lib/hotkeys/format';
  import {
    syncGlobalShortcuts,
    teardownGlobalShortcuts
  } from '$lib/hotkeys/global.svelte';
  import { initNativeMenuCommands } from '$lib/native-menu.svelte';
  import { loadProfiles } from '$lib/stores/profiles.svelte';
  import { installSyncStatusBridge } from '$lib/notifications/sync-status';

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
    void loadProfiles();
    initHotkeys();
    initNativeMenuCommands();
    // Surface a notification when Rust reports the sync server is
    // unreachable (and clear it on the next successful sync).
    const teardownSyncStatus = installSyncStatusBridge();
    const blockTouchZoom = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
    };
    window.addEventListener('wheel', blockTouchZoom, { passive: false });
    return () => {
      window.removeEventListener('wheel', blockTouchZoom);
      teardownSyncStatus();
      void teardownGlobalShortcuts();
    };
  });

  // Periodic sync runs in a Rust tokio task — see
  // src-tauri/src/sync/scheduler.rs. This effect just forwards the
  // settings UI choice into that task via `set_sync_schedule`.
  // Schema options are live | 1m | 5m | 15m | manual; we map them
  // to a tick-cadence in seconds. `manual` flips the scheduler to
  // disabled.
  //
  // The Rust scheduler was previously a JS `setTimeout` self-
  // rescheduler here, which paused if the event loop got blocked
  // (long Crepe operation, complex drawing-canvas paint) and was subject
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

  // Appearance → UI font size. Writes --ui-font-size (the rem base for the
  // whole chrome). Unlike accent, applying at the default is safe, so this
  // runs unconditionally and stays the single source of truth for the slider.
  $effect(() => {
    applyUiFontSize(getSettingValue('appearance.uiFontSize'));
  });

  // Appearance → editor body text size + line height. Written to CSS vars
  // that app.css applies to the ProseMirror content. Line height is left
  // unset (→ CSS `normal`, Crepe's native spacing) until the user actually
  // picks a value, so the default look is unchanged; font size is safe to
  // apply always because its default (16px) equals the inherited baseline.
  $effect(() => {
    const lineHeight = isModified('appearance.lineHeight')
      ? getSettingValue('appearance.lineHeight')
      : null;
    applyEditorTypography(
      getSettingValue('appearance.editorFontSize'),
      lineHeight
    );
  });

  // Mirror the resolved reduce-motion preference onto
  // `html.reduce-motion` so any animation in the app can opt out with a
  // simple `.reduce-motion &` CSS selector — same shape as the dark-mode
  // plumbing in app.html. `prefersReducedMotion()` folds the OS-level
  // `prefers-reduced-motion` media query into the tri-state app setting,
  // so this class is the only motion gate CSS needs to look at.
  $effect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.classList.toggle(
      'reduce-motion',
      prefersReducedMotion()
    );
  });

  $effect(() => {
    const globalShortcutsEnabled =
      getSettingValue('hotkeys.globalShortcuts') === true;
    const displays = HOTKEY_COMMANDS.map((cmd) => {
      const binding = getBinding(cmd.id);
      const accelerator =
        globalShortcutsEnabled || !isGlobalShortcutCommand(cmd)
          ? tauriAccelerator(binding)
          : null;
      return {
        commandId: cmd.id,
        display: displayBinding(binding) || null,
        accelerator
      };
    });
    void setNativeHotkeyDisplays(displays);
    // Only the OS-shortcut-compatible accelerator form goes to
    // syncGlobalShortcuts — `globalShortcutAccelerator` returns null
    // when the user's chord uses a key the plugin can't dispatch (any
    // non-ASCII character, plus a handful of less common physical
    // keys). The HotkeysPanel blocks save for those, so this branch
    // mostly handles legacy bindings stored before the validation
    // existed; we silently skip them rather than handing the plugin
    // a chord that would register but never fire.
    const globalRegistrations = globalShortcutsEnabled
      ? HOTKEY_COMMANDS.filter(isGlobalShortcutCommand).map((cmd) => ({
          commandId: cmd.id,
          accelerator: globalShortcutAccelerator(getBinding(cmd.id))
        }))
      : [];
    void syncGlobalShortcuts(globalRegistrations).catch((err) => {
      // Surfacing this so a bad accelerator (e.g. a legacy binding
      // stored before validation) shows up in the dev console instead
      // of silently leaving every global shortcut unregistered.
      console.error('[hotkeys] syncGlobalShortcuts threw', err);
    });
  });

  // Trash retention sweep. The Rust scheduler runs the actual purge
  // (see src-tauri/src/data.rs). This effect mirrors the
  // `set_sync_schedule` pattern above: translate the user's settings
  // choice ("forever" / "7" / "30" / "90") into a day count and push
  // it to the scheduler.
  //
  // We also fire a one-shot `sweepTrashRetention` whenever the value
  // changes, so the first sweep doesn't have to wait up to an hour
  // for the scheduler tick. The scheduler keeps running it on its
  // own cadence after that.
  const RETENTION_DAYS: Record<string, number> = {
    '7': 7,
    '30': 30,
    '90': 90,
    forever: 0
  };
  $effect(() => {
    const choice =
      (getSettingValue('data.trashRetentionDays') as string | undefined) ??
      '30';
    const days = RETENTION_DAYS[choice] ?? 0;
    void setTrashRetention(days);
    void sweepTrashRetention(days)
      .then(async (purged) => {
        // If the sweep actually removed anything, the in-memory tree
        // store is stale. The hourly scheduler tick can't see the
        // store, so reload from here — cheap when nothing changed.
        if (purged > 0) {
          const { refreshTree } = await import('$lib/stores/tree-refresh');
          await refreshTree();
        }
      })
      .catch((err) => {
        // Surface but don't block render — a failed sweep doesn't
        // break anything user-visible, but worth knowing in dev tools.
        console.warn('[trash-retention] initial sweep failed', err);
      });
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
>
  {@render children()}
</div>

<!-- Lazy singleton host: imports each dialog/search component only when
     its tiny queue/open-state store says it is actually needed. -->
<LazyRootSingletons />

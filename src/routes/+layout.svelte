<script lang="ts">
    import '../app.css';
    import {onMount} from 'svelte';
    import {ModeWatcher} from 'mode-watcher';
    import {getSettingValue, isModified} from '$lib/settings/store.svelte';
    import {applyAccentColor, clearAccentColor} from '$lib/settings/accent';
    import {invokeOrFallback} from '$lib/api';
    import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';

    let {children} = $props();

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

    import {ui} from '$lib/state.svelte.js';

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

    $effect(() => {
        const interval =
            (getSettingValue('account.syncInterval') as string | undefined) ??
            'live';
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

<ModeWatcher defaultMode="system"/>

<div class="flex h-full w-full flex-col overflow-hidden bg-background text-foreground"
     style:--left-sidebar-width="{ui.leftSidebarWidth}px"
     style:--left-sidebar-enabled={Number(ui.leftSidebarOpen)}
>
    {@render children()}
</div>

<!-- Singleton confirm-dialog instance: lives at the root so any
     caller anywhere in the tree can `await confirm(...)` without
     stashing its own component. -->
<ConfirmDialog/>

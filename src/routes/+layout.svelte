<script lang="ts">
    import '../app.css';
    import {onMount} from 'svelte';
    import {ModeWatcher} from 'mode-watcher';
    import {getSettingValue} from '$lib/settings/store.svelte';
    import {runSync} from '$lib/sync/runner';

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

    // Periodic sync. Schema options are live | 1m | 5m | 15m | manual.
    // 'live' has no Etebase server-push channel, so we poll on a short
    // interval instead — 30s strikes a balance between freshness and
    // server load. Tune INTERVAL_MS if a longpoll/SSE path lands later.
    const INTERVAL_MS: Record<string, number> = {
        live: 30_000,
        '1m': 60_000,
        '5m': 300_000,
        '15m': 900_000
    };

    $effect(() => {
        const enabled = getSettingValue('account.syncEnabled') === true;
        const interval = (getSettingValue('account.syncInterval') as string | undefined) ?? 'live';
        if (!enabled || interval === 'manual') return;
        const delay = INTERVAL_MS[interval] ?? 60_000;

        let timer: ReturnType<typeof setTimeout> | null = null;
        let cancelled = false;

        async function tick() {
            if (cancelled) return;
            try {
                await runSync();
            } catch (err) {
                // Most common case is "not signed in" while the user is
                // configuring the app — keep noise low.
                console.debug('[sync] periodic tick failed:', err);
            }
            if (!cancelled) timer = setTimeout(tick, delay);
        }
        // Fire immediately so toggling sync on (or shortening the interval)
        // is felt right away instead of after one full delay.
        void tick();

        return () => {
            cancelled = true;
            if (timer !== null) clearTimeout(timer);
        };
    });
</script>

<ModeWatcher defaultMode="system"/>

<div class="flex h-full w-full flex-col overflow-hidden bg-background text-foreground"
     style:--left-sidebar-width="{ui.leftSidebarWidth}px"
     style:--left-sidebar-enabled={Number(ui.leftSidebarOpen)}
>
    {@render children()}
</div>

<script lang="ts">
  import {
    Download,
    MonitorPlay,
    RotateCcw,
    LoaderCircle
  } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import { isBrowserDemo } from './demo';
  import { tUi } from '$lib/settings/i18n.svelte';

  let busy = $state(false);
  let failed = $state(false);
  async function reset() {
    if (!window.confirm(tUi('browser.demo.confirm'))) return;
    busy = true;
    failed = false;
    try {
      const { prepareBrowserTestReset } = await import('./vault');
      await prepareBrowserTestReset();
      window.location.reload();
    } catch (error) {
      console.error('[demo] reset failed', error);
      failed = true;
      busy = false;
    }
  }
</script>

{#if isBrowserDemo()}
  <aside
    aria-label={tUi('browser.demo.label')}
    class="demo-banner flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 text-foreground"
  >
    <div
      class="flex size-8 shrink-0 items-center justify-center rounded-lg border border-accent-brand/20 bg-accent-brand/10 text-accent-brand"
      aria-hidden="true"
    >
      <MonitorPlay class="size-4" />
    </div>
    <div class="min-w-0 flex-1 basis-64">
      <p class="text-xs font-semibold text-accent-brand">
        {tUi('browser.demo.label')}
      </p>
      <p class="mt-0.5 text-xs leading-relaxed text-muted-foreground">
        {tUi('browser.demo.notice')}
      </p>
    </div>
    <div class="ml-auto flex shrink-0 items-center gap-2">
      <Button
        variant="ghost"
        size="sm"
        class="text-muted-foreground"
        disabled={busy}
        onclick={reset}
      >
        {#if busy}<LoaderCircle class="animate-spin" aria-hidden="true" />
        {:else}<RotateCcw aria-hidden="true" />{/if}
        {tUi(busy ? 'browser.demo.resetting' : 'browser.demo.reset')}
      </Button>
      <Button
        size="sm"
        href="https://github.com/jannikgohr/mindstream-notes/releases/latest"
        target="_blank"
        rel="noreferrer"
      >
        <Download aria-hidden="true" />
        {tUi('browser.demo.download')}
      </Button>
    </div>
    {#if failed}
      <p role="alert" class="w-full text-xs text-destructive">
        {tUi('browser.demo.failed')}
      </p>
    {/if}
  </aside>
{/if}

<style>
  .demo-banner {
    padding: calc(0.625rem + env(safe-area-inset-top, 0px))
      calc(1rem + env(safe-area-inset-right, 0px)) 0.625rem
      calc(1rem + env(safe-area-inset-left, 0px));
    border-top: 2px solid var(--accent-brand);
    background: color-mix(in oklch, var(--accent-brand) 7%, var(--surface-1));
    border-bottom: 1px solid
      color-mix(in oklch, var(--accent-brand) 24%, var(--border));
  }
</style>

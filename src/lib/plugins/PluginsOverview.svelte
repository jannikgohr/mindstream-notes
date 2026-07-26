<script lang="ts">
  /**
   * Plugin management overview — lists every installed plugin (core +
   * third-party, enabled + disabled) with a source badge, version, an
   * enable/disable switch, and a load-error line when the plugin isn't
   * contributing (bad manifest / integrity gate). Shared by the desktop and
   * mobile settings shells. Toggling is optimistic + reactive (see
   * manage.svelte.ts) so the plugin's settings, create-menu templates and
   * hotkeys appear/vanish live.
   */
  import { onMount } from 'svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { tooltip } from '$lib/actions/tooltip';
  import {
    approvePluginAdmin,
    pluginOverview,
    refreshPluginAdmin,
    setPluginEnabledAdmin
  } from './manage.svelte';
  import { SOURCE_BUILTIN, SOURCE_INSTALLED } from './source';

  onMount(() => {
    void refreshPluginAdmin();
  });

  const entries = $derived(pluginOverview());

  function sourceLabel(source: string): string {
    return source === SOURCE_BUILTIN
      ? tUi('plugins.source.builtin')
      : tUi('plugins.source.installed');
  }

  /**
   * Signature status classes, or null to hide the chip. Only shown for
   * third-party plugins — a Core plugin is trusted by its bundled location, not
   * by a signature, so a signature chip there would be noise.
   */
  function signatureChip(
    source: string,
    status: string
  ): { label: string; class: string } | null {
    if (source === SOURCE_BUILTIN) return null;
    if (status === 'valid') {
      return {
        label: tUi('plugins.signature.valid'),
        class: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400'
      };
    }
    if (status === 'invalid') {
      return {
        label: tUi('plugins.signature.invalid'),
        class: 'border-destructive/40 text-destructive'
      };
    }
    return {
      label: tUi('plugins.signature.unsigned'),
      class: 'border-border text-muted-foreground'
    };
  }
</script>

<div class="mt-4">
  {#if entries.length === 0}
    <p class="py-6 text-center text-sm text-muted-foreground">
      {tUi('plugins.manage.empty')}
    </p>
  {:else}
    <div class="divide-y divide-border">
      {#each entries as entry (entry.id)}
        {@const sig = signatureChip(entry.source, entry.signatureStatus)}
        {@const gated =
          !entry.enabled &&
          !!entry.loadError &&
          entry.source === SOURCE_INSTALLED}
        <div class="flex items-start justify-between gap-4 py-3">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-sm font-medium">{entry.name}</span>
              <span
                class="rounded border border-border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
              >
                {sourceLabel(entry.source)}
              </span>
              <span class="font-mono text-xs text-muted-foreground"
                >v{entry.version}</span
              >
              {#if sig}
                <span
                  class="rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide {sig.class}"
                  use:tooltip={entry.signer
                    ? `${sig.label} · ${entry.signer.slice(0, 16)}…`
                    : sig.label}
                >
                  {sig.label}
                </span>
              {/if}
            </div>
            <p class="mt-0.5 truncate font-mono text-xs text-muted-foreground">
              {entry.id}
            </p>
            {#if entry.description}
              <p class="mt-1 text-xs text-muted-foreground">
                {entry.description}
              </p>
            {/if}
            {#if entry.loadError}
              <p class="mt-1 text-xs text-destructive">
                {tUi('plugins.manage.notLoaded')}: {entry.loadError}
              </p>
            {/if}
          </div>
          <div class="flex shrink-0 items-center gap-2">
            {#if gated}
              <button
                type="button"
                onclick={() => void approvePluginAdmin(entry.id)}
                class="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {tUi('plugins.manage.approve')}
              </button>
            {:else}
              <button
                type="button"
                role="switch"
                aria-checked={entry.enabled}
                aria-label={tUi('plugins.manage.toggle')}
                onclick={() =>
                  void setPluginEnabledAdmin(entry.id, !entry.enabled)}
                class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 {entry.enabled
                  ? 'bg-primary'
                  : 'bg-input'}"
              >
                <span
                  class="pointer-events-none block size-4 rounded-full bg-background shadow-sm ring-0 transition-transform {entry.enabled
                    ? 'translate-x-4.5'
                    : 'translate-x-0.5'}"
                ></span>
              </button>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

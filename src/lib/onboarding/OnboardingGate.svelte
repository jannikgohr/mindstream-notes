<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import { replaceState } from '$app/navigation';
  import { Button } from '$lib/components/ui/button';
  import { isTauri } from '$lib/api/core';
  import { getOnboarding, restartOnboarding } from '$lib/api/onboarding';
  import { listen, TauriEventName } from '$lib/api/events';
  import { refreshAuthSession } from '$lib/api/auth.svelte';
  import { toErrorMessage } from '$lib/api/errors';
  import {
    loadProfilesAtStartup,
    profilesState
  } from '$lib/stores/profiles.svelte';
  import { hydrateSettings } from '$lib/settings/store.svelte';
  import { refreshThemePresets } from '$lib/settings/theme.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { onboarding } from './store.svelte';
  import { commandAvailability } from '$lib/hotkeys/bus.svelte';

  let { children }: { children: Snippet } = $props();
  let ready = $state(false);
  let error = $state('');
  const active = $derived(
    onboarding.progress?.status === 'inProgress' &&
      onboarding.progress.vaultId === profilesState.active
  );
  $effect(() => {
    commandAvailability.onboarding = ready && active;
    return () => {
      commandAvailability.onboarding = false;
    };
  });
  async function refresh() {
    const progress = await getOnboarding();
    // Completion installs the initial-note intent before mounting the shell.
    // A focus event while that write is finishing must not mount it early.
    if (!onboarding.finishing) onboarding.progress = progress;
  }
  async function initialize() {
    ready = false;
    error = '';
    try {
      await loadProfilesAtStartup();
      if (!profilesState.loaded) throw new Error(tUi('onboarding.loadFailed'));
      await hydrateSettings();
      await refreshAuthSession();
      await refreshThemePresets();
      // Browser development and browser E2E are opt-in, just like native dev.
      const url = new URL(window.location.href);
      if (!isTauri() && url.searchParams.has('onboarding')) {
        onboarding.progress = await restartOnboarding();
        url.searchParams.delete('onboarding');
        replaceState(url, {});
      } else await refresh();
      ready = true;
    } catch (cause) {
      error = toErrorMessage(cause);
    }
  }
  onMount(() => {
    let disposed = false;
    void initialize();
    const onFocus = () => {
      if (ready)
        void refresh().catch((cause) => {
          error = toErrorMessage(cause);
        });
    };
    window.addEventListener('focus', onFocus);
    const unlisten = isTauri()
      ? listen(TauriEventName.OnboardingChanged, onFocus).catch((cause) => {
          console.warn('[onboarding] progress listener unavailable', cause);
          return () => {};
        })
      : Promise.resolve(() => {});
    let stopListening: (() => void) | undefined;
    void unlisten.then((stop) => {
      if (disposed) stop();
      else stopListening = stop;
    });
    return () => {
      disposed = true;
      window.removeEventListener('focus', onFocus);
      stopListening?.();
    };
  });
</script>

{#if !ready}
  <div
    class="flex h-full flex-col items-center justify-center gap-4 p-6 text-center"
  >
    {#if error}<p role="alert" class="max-w-lg text-sm text-destructive">
        {error}
      </p>
      <Button onclick={initialize}>{tUi('onboarding.retry')}</Button>
    {:else}<p role="status" class="text-sm text-muted-foreground">
        {tUi('boot.loading')}
      </p>{/if}
  </div>
{:else if active}
  {#await import('./Onboarding.svelte')}
    <div class="flex h-full items-center justify-center p-6" role="status">
      {tUi('boot.loading')}
    </div>
  {:then module}
    <module.default
      oncomplete={() => {
        error = '';
      }}
    />
  {:catch cause}
    <div class="flex h-full flex-col items-center justify-center gap-4 p-6">
      <p role="alert" class="text-sm text-destructive">
        {toErrorMessage(cause)}
      </p>
      <Button onclick={initialize}>{tUi('onboarding.retry')}</Button>
    </div>
  {/await}
{:else}
  {@render children()}
{/if}

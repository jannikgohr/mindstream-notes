<script lang="ts">
  import { onMount } from 'svelte';
  import { ModeWatcher, setMode, mode } from 'mode-watcher';
  import {
    getThemeAppearance,
    type ThemeAppearance
  } from '$lib/api/theme-presets';
  import { applyThemeAppearance } from '$lib/settings/theme-presets';
  import { listen, TauriEventName } from '$lib/api/events';
  import {
    getVaultPickerState,
    openPickerVault,
    type PickerVault
  } from '$lib/api/vault-picker';
  import { createProfile } from '$lib/api/profiles';
  import { setLanguage, tUi } from '$lib/settings/i18n.svelte';
  import VaultTile from '$lib/components/VaultTile.svelte';
  import { toErrorMessage } from '$lib/api/errors';
  let vaults = $state<PickerVault[]>([]);
  let loading = $state(true);
  let busy = $state(false);
  let error = $state('');
  let name = $state('');
  let appearance = $state<ThemeAppearance | null>(null);
  async function refreshAppearance() {
    try {
      appearance = await getThemeAppearance();
      localStorage.setItem('mode-watcher-mode', appearance.mode);
      setMode(appearance.mode);
    } catch (cause) {
      error = toErrorMessage(cause);
    }
  }
  $effect(() => {
    if (appearance)
      applyThemeAppearance(
        appearance.preset,
        $mode === 'dark',
        appearance.uiFontSize
      );
  });
  async function refresh() {
    loading = true;
    error = '';
    try {
      const state = await getVaultPickerState();
      setLanguage(state.languageCode);
      document.documentElement.lang = state.languageCode;
      localStorage.setItem('mode-watcher-mode', state.themeMode);
      setMode(state.themeMode);
      vaults = state.vaults;
    } catch (cause) {
      error = toErrorMessage(cause);
    } finally {
      loading = false;
    }
  }
  async function open(id: string) {
    if (busy) return;
    busy = true;
    error = '';
    try {
      await openPickerVault(id);
    } catch (cause) {
      error = toErrorMessage(cause);
    } finally {
      busy = false;
    }
  }
  async function create() {
    if (busy || !name.trim()) return;
    busy = true;
    error = '';
    try {
      const vault = await createProfile(name.trim());
      name = '';
      await refresh();
      await openPickerVault(vault.id);
    } catch (cause) {
      error = toErrorMessage(cause);
    } finally {
      busy = false;
    }
  }
  onMount(() => {
    void refresh();
    void refreshAppearance();
    const unlisten = listen(TauriEventName.UiSettingsChanged, () => {
      void refreshAppearance();
    });
    return () => {
      void unlisten.then((dispose) => dispose());
    };
  });
</script>

<ModeWatcher defaultMode="system" />
<div class="flex min-h-screen flex-col bg-background p-6 text-foreground">
  <h1 class="text-xl font-semibold">{tUi('vault.picker.title')}</h1>
  <p class="mt-2 text-sm text-muted-foreground">
    {tUi('vault.picker.message')}
  </p>
  {#if error}
    <p class="mt-3 text-sm text-destructive" role="alert">{error}</p>
    <button
      type="button"
      class="mt-2 text-sm underline"
      disabled={busy}
      onclick={refresh}>{tUi('vault.windows.retry')}</button
    >
  {/if}
  {#if loading}
    <p class="mt-4 text-sm" role="status">{tUi('vault.windows.checking')}</p>
  {:else}
    <div class="my-4 flex flex-col gap-2">
      {#each vaults as vault (vault.id)}
        <button
          type="button"
          class="flex items-center gap-2.5 rounded-md border border-border p-3 text-left text-sm hover:bg-accent disabled:opacity-50"
          disabled={busy || !vault.available}
          onclick={() => open(vault.id)}
          ><VaultTile
            id={vault.id}
            name={vault.name}
            color={vault.color}
          /><span class="min-w-0 truncate">{vault.name}</span
          >{#if !vault.available}<span class="text-muted-foreground"
              >{tUi('vault.windows.unavailable')}</span
            >{/if}</button
        >
      {/each}
    </div>
    <form
      class="mt-auto flex gap-2"
      onsubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <input
        class="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
        aria-label={tUi('vault.create.placeholder')}
        placeholder={tUi('vault.create.placeholder')}
        bind:value={name}
        disabled={busy}
      />
      <button
        type="submit"
        class="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
        disabled={busy || !name.trim()}>{tUi('vault.create.button')}</button
      >
    </form>
  {/if}
</div>

<script lang="ts">
  /**
   * Top-bar vault (profile) switcher. Sits right of the app title.
   *
   * The current vault name is always shown next to the icon. The jis3r
   * Vault icon animates only while the menu is open (i.e. on click) —
   * driven by the `animate` prop from the `open` state rather than the
   * library's built-in mouseenter, so hovering the top bar stays quiet.
   *
   * Click: opens a dropdown (same outside-pointerdown + Escape pattern as
   * NotificationCenter) listing every vault with the active one checked.
   * Supervised workers open/focus vault windows through the coordinator.
   * Direct devices retain their restart flow. Menu observations never grant
   * ownership; the native action rechecks the target.
   */
  import { onMount } from 'svelte';
  import { Vault } from '@jis3r/icons';
  import {
    ArrowLeftRight,
    Check,
    ExternalLink,
    Pencil,
    Plus,
    Trash2
  } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { confirm, alert } from '$lib/components/confirm-dialog.svelte';
  import { isTauri } from '$lib/api';
  import {
    createProfile,
    switchProfile,
    renameProfile,
    deleteProfile
  } from '$lib/api/profiles';
  import type { Profile } from '$lib/api/profiles';
  import {
    profilesState,
    loadProfiles,
    currentProfile
  } from '$lib/stores/profiles.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { toErrorMessage } from '$lib/api/errors';
  import { VaultWindowStatus } from '$lib/api/vault-window-state';
  import { VaultMenu, type VaultOpenMode } from '$lib/vaults/menu.svelte';
  import { getSettingValue, setSettingValue } from '$lib/settings/store.svelte';

  let open = $state(false);
  let creating = $state(false);
  let busy = $state(false);
  let newName = $state('');
  let renamingId = $state<string | null>(null);
  let renameValue = $state('');
  let root: HTMLDivElement | null = $state(null);
  let createInput: HTMLInputElement | null = $state(null);
  let renameInput: HTMLInputElement | null = $state(null);
  const windows = new VaultMenu();
  let choice = $state<{ id: string; name: string } | null>(null);
  let rememberChoice = $state(false);

  const current = $derived(currentProfile());
  const currentName = $derived(current?.name ?? tUi('vault.unknown'));

  function toggle() {
    if (busy) return;
    if (open) close();
    else {
      open = true;
      void refreshWindows();
    }
  }

  async function refreshWindows() {
    if (await windows.refresh()) await loadProfiles();
  }

  function windowStatus(id: string) {
    return windows.status(id);
  }

  function openingLabel(id: string) {
    return tUi(
      windowStatus(id) === VaultWindowStatus.Ready
        ? 'vault.open.focus'
        : 'vault.open.newWindow'
    );
  }

  async function selectProfile(
    id: string,
    name: string,
    explicit?: VaultOpenMode,
    event?: MouseEvent
  ) {
    if (busy || windows.checking || !windows.view) return;
    if (!windows.view.supervised) {
      await confirmAndSwitch(id, name);
      return;
    }
    const mode =
      explicit ??
      windows.decision(
        id,
        getSettingValue('general.vaultOpening'),
        event?.ctrlKey || event?.metaKey
      );
    if (mode === 'ask') {
      choice = { id, name };
      rememberChoice = false;
      return;
    }
    busy = true;
    try {
      if (choice?.id === id && rememberChoice)
        await setSettingValue('general.vaultOpening', mode);
      await windows.open(id, mode);
      close();
    } catch (err) {
      await alert({
        title: tUi('vault.open.failed.title'),
        message: tUi('vault.open.failed.message').replace(
          '{error}',
          toErrorMessage(err)
        )
      });
      if (open) await refreshWindows();
    } finally {
      busy = false;
    }
  }

  function close() {
    windows.invalidate();
    open = false;
    creating = false;
    newName = '';
    renamingId = null;
    renameValue = '';
    choice = null;
    rememberChoice = false;
  }

  /**
   * Apply a completed switch. A packaged build relaunches into the new
   * vault. Under `tauri dev` the Tauri CLI owns the process *and* the
   * Vite dev server, so a relaunched instance is torn straight back down
   * (window flashes open then closes) — there's no app-side fix for that,
   * so we tell the user to restart manually instead. No-op outside Tauri.
   */
  async function finishSwitch(name: string) {
    if (!isTauri()) return;
    if (import.meta.env.DEV) {
      await alert({
        title: tUi('vault.switch.devRestart.title'),
        message: tUi('vault.switch.devRestart.message').replace('{name}', name)
      });
      return;
    }
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  }

  async function confirmAndSwitch(id: string, name: string) {
    if (busy || id === profilesState.active) {
      close();
      return;
    }
    const confirmed = await confirm({
      title: tUi('vault.switch.confirm.title'),
      message: tUi('vault.switch.confirm.message').replace('{name}', name),
      confirmLabel: tUi('vault.switch.confirm.button')
    });
    if (!confirmed) return;
    busy = true;
    try {
      await switchProfile(id);
      await loadProfiles();
      close();
      await finishSwitch(name);
    } catch (err) {
      console.error('[vault] switch failed', err);
      await alert({
        title: tUi('vault.switch.failed.title'),
        message: tUi('vault.switch.failed.message').replace(
          '{error}',
          toErrorMessage(err)
        )
      });
    } finally {
      busy = false;
    }
  }

  function startCreate() {
    if (busy || windows.checking || !windows.view) return;
    creating = true;
    renamingId = null;
    newName = '';
    // Focus the field once it renders.
    queueMicrotask(() => createInput?.focus());
  }

  function startRename(profile: Profile) {
    creating = false;
    renamingId = profile.id;
    renameValue = profile.name;
    queueMicrotask(() => renameInput?.select());
  }

  function canDeleteProfile(profile: Profile) {
    return (
      profile.id !== profilesState.active &&
      profile.id !== profilesState.indexActive &&
      windows.canDelete(profile.id)
    );
  }

  async function submitRename() {
    const id = renamingId;
    const name = renameValue.trim();
    if (!id || !name || busy) return;
    busy = true;
    try {
      await renameProfile(id, name);
      renamingId = null;
      await loadProfiles();
    } catch (err) {
      console.error('[vault] rename failed', err);
      await alert({
        title: tUi('vault.rename.failed.title'),
        message: tUi('vault.rename.failed.message').replace(
          '{error}',
          toErrorMessage(err)
        )
      });
    } finally {
      busy = false;
    }
  }

  function onRenameKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      void submitRename();
    } else if (event.key === 'Escape') {
      event.stopPropagation();
      renamingId = null;
    }
  }

  async function confirmAndDelete(profile: Profile) {
    if (busy || !canDeleteProfile(profile)) return;
    const confirmed = await confirm({
      title: tUi('vault.delete.confirm.title'),
      message: tUi('vault.delete.confirm.message').replace(
        '{name}',
        profile.name
      ),
      confirmLabel: tUi('vault.delete.confirm.button'),
      destructive: true,
      confirmDelaySeconds: 3
    });
    if (!confirmed) return;
    busy = true;
    try {
      await deleteProfile(profile.id);
      await loadProfiles();
    } catch (err) {
      console.error('[vault] delete failed', err);
      await alert({
        title: tUi('vault.delete.failed.title'),
        message: tUi('vault.delete.failed.message').replace(
          '{error}',
          toErrorMessage(err)
        )
      });
    } finally {
      busy = false;
    }
  }

  async function submitCreate() {
    const name = newName.trim();
    if (!name || busy || windows.checking || !windows.view) return;
    busy = true;
    try {
      const profile = await createProfile(name);
      if (windows.view.supervised) {
        creating = false;
        newName = '';
        await loadProfiles();
        busy = false;
        await selectProfile(profile.id, profile.name);
      } else if (import.meta.env.DEV) {
        // Dev can't relaunch into the new vault (see finishSwitch), so
        // instead of a dead-end switch prompt we just refresh the list
        // and keep the menu open — the new vault appears immediately and
        // the user can switch when they next restart.
        creating = false;
        newName = '';
        await loadProfiles();
        busy = false;
      } else {
        // Packaged: switch into the new vault, which re-confirms and
        // relaunches.
        busy = false;
        await confirmAndSwitch(profile.id, profile.name);
      }
    } catch (err) {
      console.error('[vault] create failed', err);
      busy = false;
      await alert({
        title: tUi('vault.create.failed.title'),
        message: tUi('vault.create.failed.message').replace(
          '{error}',
          toErrorMessage(err)
        )
      });
    }
  }

  function onCreateKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      void submitCreate();
    } else if (event.key === 'Escape') {
      // Collapse the inline field first; let the panel stay open.
      event.stopPropagation();
      creating = false;
    }
  }

  function handleDocumentPointerDown(event: PointerEvent) {
    if (!open || !root) return;
    if (event.target instanceof Node && !root.contains(event.target)) {
      close();
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') close();
  }

  onMount(() => {
    void loadProfiles();
    document.addEventListener('pointerdown', handleDocumentPointerDown, true);
    document.addEventListener('keydown', handleKeydown);
    return () => {
      document.removeEventListener(
        'pointerdown',
        handleDocumentPointerDown,
        true
      );
      document.removeEventListener('keydown', handleKeydown);
    };
  });

  $effect(() => {
    if (!open) return;
    const timer = setInterval(() => {
      if (!busy && !windows.checking) void refreshWindows();
    }, 3000);
    return () => clearInterval(timer);
  });
</script>

<div bind:this={root} class="relative">
  <Button
    variant="ghost"
    size="sm"
    class="h-7 gap-1.5 px-2"
    onclick={toggle}
    title={currentName}
    aria-label={tUi('vault.switch')}
    aria-expanded={open}
    disabled={busy}
  >
    <Vault size={16} animate={open} />
    <span class="inline-block max-w-48 truncate">{currentName}</span>
  </Button>

  {#if open}
    <div
      class="absolute left-0 top-[calc(100%+0.375rem)] z-300 w-64 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-lg"
    >
      <div class="border-b border-border px-3 py-2">
        <p class="text-xs font-medium text-muted-foreground">
          {tUi('vault.title')}
        </p>
      </div>

      <div class="max-h-80 overflow-y-auto p-1">
        {#if choice}
          <div
            class="space-y-2 border-b border-border p-2"
            role="group"
            aria-label={tUi('vault.open.choose')}
          >
            <p class="text-sm font-medium">{choice.name}</p>
            <div class="flex flex-col gap-1">
              <Button
                size="sm"
                disabled={busy || windows.checking}
                onclick={() =>
                  choice && selectProfile(choice.id, choice.name, 'thisWindow')}
                >{tUi('vault.open.thisWindow')}</Button
              >
              <Button
                size="sm"
                variant="outline"
                disabled={busy || windows.checking}
                onclick={() =>
                  choice && selectProfile(choice.id, choice.name, 'newWindow')}
                >{tUi('vault.open.newWindow')}</Button
              >
            </div>
            <label class="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                bind:checked={rememberChoice}
                disabled={busy}
              />
              {tUi('vault.open.remember')}
            </label>
            <button
              type="button"
              class="text-xs underline"
              disabled={busy}
              onclick={() => {
                choice = null;
                rememberChoice = false;
              }}>{tUi('vault.open.cancel')}</button
            >
          </div>
        {/if}
        {#if windows.failed}
          <div class="space-y-1 px-2 py-1.5 text-sm" role="alert">
            <p>{tUi('vault.windows.failed')}</p>
            <button
              type="button"
              class="underline"
              disabled={windows.checking}
              onclick={() => refreshWindows()}
              >{tUi('vault.windows.retry')}</button
            >
          </div>
        {:else if windows.checking && !windows.view}
          <p class="px-2 py-1.5 text-sm text-muted-foreground" role="status">
            {tUi('vault.windows.checking')}
          </p>
        {/if}
        {#each profilesState.profiles as profile (profile.id)}
          {#if renamingId === profile.id}
            <div class="flex items-center gap-1 p-1">
              <Input
                bind:ref={renameInput}
                bind:value={renameValue}
                class="h-7 text-sm"
                disabled={busy}
                onkeydown={onRenameKeydown}
              />
              <Button
                variant="default"
                size="sm"
                class="h-7"
                disabled={busy || renameValue.trim() === ''}
                onclick={submitRename}
              >
                {tUi('vault.rename.save')}
              </Button>
            </div>
          {:else}
            <div
              class="flex items-center rounded-sm hover:bg-accent hover:text-accent-foreground"
            >
              <button
                type="button"
                class="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm"
                disabled={busy || windows.checking || !windows.view}
                title={windows.view?.supervised
                  ? openingLabel(profile.id)
                  : undefined}
                onclick={(event) =>
                  selectProfile(profile.id, profile.name, undefined, event)}
              >
                <span class="flex size-4 shrink-0 items-center justify-center">
                  {#if profile.id === profilesState.active}
                    <Check class="size-4" />
                  {/if}
                </span>
                <span class="truncate">{profile.name}</span>
                {#if windows.view?.supervised && windowStatus(profile.id)}
                  <span class="ml-auto text-xs text-muted-foreground">
                    {tUi(`vault.windows.${windowStatus(profile.id)}`)}
                  </span>
                {/if}
              </button>
              <div class="flex shrink-0 items-center gap-0.5 pr-1">
                {#if windows.view?.supervised}
                  <button
                    type="button"
                    class="rounded-sm p-1 text-muted-foreground hover:text-foreground"
                    title={openingLabel(profile.id)}
                    aria-label={`${openingLabel(profile.id)}: ${profile.name}`}
                    disabled={busy || windows.checking}
                    onclick={() =>
                      selectProfile(profile.id, profile.name, 'newWindow')}
                  >
                    <ExternalLink class="size-3.5" />
                  </button>
                  {#if !windowStatus(profile.id)}
                    <button
                      type="button"
                      class="rounded-sm p-1 text-muted-foreground hover:text-foreground"
                      title={tUi('vault.open.thisWindow')}
                      aria-label={`${tUi('vault.open.thisWindow')}: ${profile.name}`}
                      disabled={busy || windows.checking}
                      onclick={() =>
                        selectProfile(profile.id, profile.name, 'thisWindow')}
                      ><ArrowLeftRight class="size-3.5" /></button
                    >
                  {/if}
                {/if}
                <button
                  type="button"
                  class="rounded-sm p-1 text-muted-foreground hover:text-foreground"
                  title={tUi('vault.rename')}
                  aria-label={tUi('vault.rename')}
                  disabled={busy}
                  onclick={() => startRename(profile)}
                >
                  <Pencil class="size-3.5" />
                </button>
                {#if canDeleteProfile(profile)}
                  <button
                    type="button"
                    class="rounded-sm p-1 text-muted-foreground hover:text-destructive"
                    title={tUi('vault.delete')}
                    aria-label={tUi('vault.delete')}
                    disabled={busy}
                    onclick={() => confirmAndDelete(profile)}
                  >
                    <Trash2 class="size-3.5" />
                  </button>
                {/if}
              </div>
            </div>
          {/if}
        {/each}
      </div>

      <div class="border-t border-border p-1">
        {#if creating}
          <div class="flex items-center gap-1 p-1">
            <Input
              bind:ref={createInput}
              bind:value={newName}
              placeholder={tUi('vault.create.placeholder')}
              class="h-7 text-sm"
              disabled={busy}
              onkeydown={onCreateKeydown}
            />
            <Button
              variant="default"
              size="sm"
              class="h-7"
              disabled={busy ||
                windows.checking ||
                !windows.view ||
                newName.trim() === ''}
              onclick={submitCreate}
            >
              {tUi('vault.create.button')}
            </Button>
          </div>
        {:else}
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
            disabled={busy || windows.checking || !windows.view}
            onclick={startCreate}
          >
            <Plus class="size-4 shrink-0" />
            <span>{tUi('vault.create')}</span>
          </button>
        {/if}
      </div>
    </div>
  {/if}
</div>

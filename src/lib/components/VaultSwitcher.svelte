<script lang="ts">
  /**
   * Top-bar vault (profile) switcher. Sits right of the app title.
   *
   * Hover: the jis3r Vault icon animates (driven by the `animate` prop —
   * we control it from the button's hover/open state rather than the
   * library's built-in mouseenter so the whole control, including the
   * revealed name label, drives one animation) and the current vault
   * name slides into view.
   *
   * Click: opens a dropdown (same outside-pointerdown + Escape pattern as
   * NotificationCenter) listing every vault with the active one checked.
   * Picking another vault confirms, then switches and relaunches into it
   * — switching only takes effect on a fresh launch (the boot code reads
   * the index and opens that vault's DB). "Create vault" reveals an
   * inline name field that creates then switches into the new vault.
   */
  import { onMount } from 'svelte';
  import { Vault } from '@jis3r/icons';
  import { Check, Plus } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { confirm, alert } from '$lib/components/confirm-dialog.svelte';
  import { isTauri } from '$lib/api';
  import { createProfile, switchProfile } from '$lib/api/profiles';
  import {
    profilesState,
    loadProfiles,
    currentProfile
  } from '$lib/stores/profiles.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';

  let open = $state(false);
  let hovered = $state(false);
  let creating = $state(false);
  let busy = $state(false);
  let newName = $state('');
  let root: HTMLDivElement | null = $state(null);
  let createInput: HTMLInputElement | null = $state(null);

  const current = $derived(currentProfile());
  const currentName = $derived(current?.name ?? tUi('vault.unknown'));

  function toggle() {
    open = !open;
    if (!open) creating = false;
  }

  function close() {
    open = false;
    creating = false;
    newName = '';
  }

  /** Relaunch into the freshly-selected vault (no-op outside Tauri). */
  async function relaunchApp() {
    if (!isTauri()) return;
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
      close();
      await relaunchApp();
    } catch (err) {
      console.error('[vault] switch failed', err);
      await alert({
        title: tUi('vault.switch.failed.title'),
        message: tUi('vault.switch.failed.message').replace(
          '{error}',
          String(err)
        )
      });
    } finally {
      busy = false;
    }
  }

  function startCreate() {
    creating = true;
    newName = '';
    // Focus the field once it renders.
    queueMicrotask(() => createInput?.focus());
  }

  async function submitCreate() {
    const name = newName.trim();
    if (!name || busy) return;
    busy = true;
    try {
      const profile = await createProfile(name);
      // Switching into the new vault re-confirms + relaunches.
      busy = false;
      await confirmAndSwitch(profile.id, profile.name);
    } catch (err) {
      console.error('[vault] create failed', err);
      busy = false;
      await alert({
        title: tUi('vault.create.failed.title'),
        message: tUi('vault.create.failed.message').replace(
          '{error}',
          String(err)
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
</script>

<div bind:this={root} class="relative">
  <Button
    variant="ghost"
    size="sm"
    class="h-7 gap-1.5 px-2"
    onclick={toggle}
    onmouseenter={() => (hovered = true)}
    onmouseleave={() => (hovered = false)}
    title={currentName}
    aria-label={tUi('vault.switch')}
    aria-expanded={open}
  >
    <Vault size={16} animate={hovered || open} />
    <span class="vault-name {hovered || open ? 'is-shown' : ''}">
      {currentName}
    </span>
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
        {#each profilesState.profiles as profile (profile.id)}
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
            disabled={busy}
            onclick={() => confirmAndSwitch(profile.id, profile.name)}
          >
            <span class="flex size-4 shrink-0 items-center justify-center">
              {#if profile.id === profilesState.active}
                <Check class="size-4" />
              {/if}
            </span>
            <span class="truncate">{profile.name}</span>
          </button>
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
              disabled={busy || newName.trim() === ''}
              onclick={submitCreate}
            >
              {tUi('vault.create.button')}
            </Button>
          </div>
        {:else}
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
            disabled={busy}
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

<style>
  /* Current-vault name reveals on hover / when the menu is open. */
  .vault-name {
    display: inline-block;
    max-width: 0;
    overflow: hidden;
    white-space: nowrap;
    opacity: 0;
    transition:
      max-width 0.2s ease,
      opacity 0.2s ease;
  }
  .vault-name.is-shown {
    max-width: 9rem;
    opacity: 1;
  }
</style>

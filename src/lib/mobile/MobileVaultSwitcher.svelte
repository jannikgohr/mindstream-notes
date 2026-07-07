<script lang="ts">
  /**
   * Mobile vault (profile) switcher — a full-screen surface driven by an
   * external `open` binding, opened from the unified options menu.
   *
   * Mirrors the desktop VaultSwitcher's lifecycle (switch / create /
   * rename / delete against the shared profiles store) but in the
   * mobile full-bleed dialog idiom. The one real divergence is applying
   * a switch: desktop relaunches through @tauri-apps/plugin-process,
   * which is desktop-only, so mobile reboots through the native Android
   * restart bridge (restartApp → src-tauri/src/app_restart.rs) instead.
   *
   * The unified options menu (MobileOptionsMenu) owns the trigger and
   * the nav-stack entry; this component is the controlled sheet. `open`
   * shows it and any dismissal reports back through `onClose`.
   */
  import { Dialog } from 'bits-ui';
  import { Check, Pencil, Plus, Trash2, X } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { confirm, alert } from '$lib/components/confirm-dialog.svelte';
  import { isTauri } from '$lib/api';
  import { restartApp } from '$lib/api/system';
  import {
    createProfile,
    switchProfile,
    renameProfile,
    deleteProfile
  } from '$lib/api/profiles';
  import type { Profile } from '$lib/api/profiles';
  import { profilesState, loadProfiles } from '$lib/stores/profiles.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';

  let { open = false, onClose }: { open?: boolean; onClose: () => void } =
    $props();

  let busy = $state(false);
  let creating = $state(false);
  let newName = $state('');
  let renamingId = $state<string | null>(null);
  let renameValue = $state('');
  let createInput: HTMLInputElement | null = $state(null);
  let renameInput: HTMLInputElement | null = $state(null);

  // Refresh the vault list on open and reset the inline edit affordances
  // on close so it reopens on the plain list rather than mid-edit.
  $effect(() => {
    if (open) {
      void loadProfiles();
    } else {
      creating = false;
      newName = '';
      renamingId = null;
      renameValue = '';
    }
  });

  /**
   * Apply a completed switch by rebooting into the new vault. On Android
   * the native restart bridge kills and relaunches the process, so a
   * successful call never returns. Outside Tauri (browser dev with a
   * mobile UA) or if the restart command is unavailable, fall back to
   * telling the user to relaunch manually.
   */
  async function finishSwitch(name: string) {
    if (isTauri()) {
      try {
        await restartApp();
        return;
      } catch (err) {
        console.error('[vault] native restart failed', err);
      }
    }
    await alert({
      title: tUi('vault.switch.devRestart.title'),
      message: tUi('vault.switch.devRestart.message').replace('{name}', name)
    });
  }

  async function confirmAndSwitch(id: string, name: string) {
    if (busy || id === profilesState.active) {
      onClose();
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
      onClose();
      await finishSwitch(name);
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
    renamingId = null;
    newName = '';
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
      profile.id !== profilesState.indexActive
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
          String(err)
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
          String(err)
        )
      });
    } finally {
      busy = false;
    }
  }

  async function submitCreate() {
    const name = newName.trim();
    if (!name || busy) return;
    busy = true;
    try {
      const profile = await createProfile(name);
      busy = false;
      if (!isTauri()) {
        // Browser dev can't restart into the new vault — just refresh
        // the list and let the user switch when they relaunch.
        creating = false;
        newName = '';
        await loadProfiles();
      } else {
        // Switch into the freshly-created vault (re-confirms + reboots).
        await confirmAndSwitch(profile.id, profile.name);
      }
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
      event.stopPropagation();
      creating = false;
    }
  }
</script>

<Dialog.Root
  {open}
  onOpenChange={(o: boolean) => {
    if (!o) onClose();
  }}
>
  <Dialog.Portal>
    <Dialog.Content
      class="safe-top safe-bottom safe-x fixed inset-0 z-50 flex flex-col bg-background text-foreground focus:outline-none"
    >
      <header
        class="flex h-12 shrink-0 items-center justify-between border-b border-border bg-card px-2"
      >
        <div class="w-9 shrink-0"></div>
        <Dialog.Title class="truncate text-sm font-semibold">
          {tUi('vault.title')}
        </Dialog.Title>
        <Dialog.Close
          class="flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={tUi('close')}
        >
          <X class="size-5" />
        </Dialog.Close>
      </header>

      <section class="flex-1 overflow-y-auto p-2">
        <div class="space-y-1">
          {#each profilesState.profiles as profile (profile.id)}
            {#if renamingId === profile.id}
              <div class="flex items-center gap-2 p-1">
                <Input
                  bind:ref={renameInput}
                  bind:value={renameValue}
                  class="h-11 flex-1 text-base"
                  disabled={busy}
                  onkeydown={onRenameKeydown}
                />
                <Button
                  variant="default"
                  class="h-11"
                  disabled={busy || renameValue.trim() === ''}
                  onclick={submitRename}
                >
                  {tUi('vault.rename.save')}
                </Button>
              </div>
            {:else}
              <div
                class="flex items-center rounded-md border border-border bg-card"
              >
                <button
                  type="button"
                  class="flex min-w-0 flex-1 items-center gap-3 px-3 py-3 text-left text-base"
                  disabled={busy}
                  onclick={() => confirmAndSwitch(profile.id, profile.name)}
                >
                  <span
                    class="flex size-5 shrink-0 items-center justify-center text-primary"
                  >
                    {#if profile.id === profilesState.active}
                      <Check class="size-5" />
                    {/if}
                  </span>
                  <span class="truncate">{profile.name}</span>
                </button>
                <div class="flex shrink-0 items-center gap-1 pr-2">
                  <button
                    type="button"
                    class="flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                    title={tUi('vault.rename')}
                    aria-label={tUi('vault.rename')}
                    disabled={busy}
                    onclick={() => startRename(profile)}
                  >
                    <Pencil class="size-4" />
                  </button>
                  {#if canDeleteProfile(profile)}
                    <button
                      type="button"
                      class="flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-destructive"
                      title={tUi('vault.delete')}
                      aria-label={tUi('vault.delete')}
                      disabled={busy}
                      onclick={() => confirmAndDelete(profile)}
                    >
                      <Trash2 class="size-4" />
                    </button>
                  {/if}
                </div>
              </div>
            {/if}
          {/each}
        </div>
      </section>

      <footer class="shrink-0 border-t border-border p-2">
        {#if creating}
          <div class="flex items-center gap-2">
            <Input
              bind:ref={createInput}
              bind:value={newName}
              placeholder={tUi('vault.create.placeholder')}
              class="h-11 flex-1 text-base"
              disabled={busy}
              onkeydown={onCreateKeydown}
            />
            <Button
              variant="default"
              class="h-11"
              disabled={busy || newName.trim() === ''}
              onclick={submitCreate}
            >
              {tUi('vault.create.button')}
            </Button>
          </div>
        {:else}
          <button
            type="button"
            class="flex w-full items-center gap-3 rounded-md px-3 py-3 text-left text-base hover:bg-accent hover:text-accent-foreground"
            disabled={busy}
            onclick={startCreate}
          >
            <Plus class="size-5 shrink-0" />
            <span>{tUi('vault.create')}</span>
          </button>
        {/if}
      </footer>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

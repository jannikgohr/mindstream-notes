<script module lang="ts">
  export interface PermissionItem {
    id: string;
    label: string;
    binaries: string[];
  }
</script>

<script lang="ts">
  /**
   * A plugin's permissions as a bottom sheet, the phone counterpart of the
   * desktop popover in PluginsOverview: full-width rows at reading size, the
   * binaries a native permission covers as chips under it. System back closes
   * it like the other mobile overlays.
   */
  import { Dialog } from 'bits-ui';
  import { ShieldCheck, X } from '@lucide/svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { closeNavOverlay, openNavOverlay } from '$lib/mobile/state.svelte';

  interface Props {
    open: boolean;
    /** The plugin's display name, under the sheet title. */
    pluginName: string;
    permissions: PermissionItem[];
  }
  let { open = $bindable(), pluginName, permissions }: Props = $props();

  const NAV_ID = 'plugin-permissions-sheet';
  let navHeld = false;
  $effect(() => {
    if (open && !navHeld) {
      navHeld = true;
      openNavOverlay(NAV_ID, () => (open = false));
    } else if (!open && navHeld) {
      navHeld = false;
      closeNavOverlay(NAV_ID);
    }
  });
</script>

<Dialog.Root bind:open>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-[400] bg-scrim" />
    <Dialog.Content
      class="permissions-sheet safe-bottom safe-x fixed inset-x-0 bottom-0 z-[400] flex max-h-[80vh] flex-col rounded-t-xl border-t border-border bg-card text-card-foreground shadow-2xl focus:outline-none"
    >
      <header
        class="flex min-h-14 shrink-0 items-center gap-3 border-b border-border py-2 pl-4 pr-1.5"
      >
        <div class="min-w-0 flex-1">
          <Dialog.Title class="text-base font-semibold">
            {tUi('plugins.permissions.title')}
          </Dialog.Title>
          <Dialog.Description class="truncate text-xs text-muted-foreground">
            {pluginName}
          </Dialog.Description>
        </div>
        <Dialog.Close
          class="flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={tUi('close')}
        >
          <X class="size-5" />
        </Dialog.Close>
      </header>

      {#if permissions.length > 0}
        <ul class="divide-y divide-border overflow-y-auto px-4 pb-2">
          {#each permissions as perm (perm.id)}
            <li class="flex gap-3 py-3.5">
              <ShieldCheck
                class="mt-px size-5 shrink-0 text-muted-foreground"
              />
              <div class="min-w-0 flex-1">
                <p class="text-sm leading-5">{perm.label}</p>
                {#if perm.binaries.length > 0}
                  <div class="mt-2 flex flex-wrap gap-1.5">
                    {#each perm.binaries as binary (binary)}
                      <code
                        class="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
                        >{binary}</code
                      >
                    {/each}
                  </div>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="px-4 py-6 text-sm text-muted-foreground">
          {tUi('plugins.permissions.none')}
        </p>
      {/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  :global(.permissions-sheet) {
    animation: sheet-up 180ms ease-out;
  }
  @keyframes sheet-up {
    from {
      transform: translateY(100%);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    :global(.permissions-sheet) {
      animation: none;
    }
  }
  :global(.reduce-motion .permissions-sheet) {
    animation: none;
  }
</style>

<script lang="ts">
  /**
   * The create button: a split, labelled button anchored bottom-right. The
   * main part creates the default (the first of `actions`, which follow the
   * file-tree toolbar's order on this device); the chevron opens a menu of
   * everything that can be created, where another kind can be made the
   * default. `extras` (templates) are listed after and never the default.
   */
  import { ChevronUp, Pin } from '@lucide/svelte';
  import type { IconComponent } from '$lib/settings/icons';
  import { tUi, tUiFormat } from '$lib/settings/i18n.svelte';
  import { mobileState, toggleFabExpanded, collapseFab } from './state.svelte';

  export interface FabAction {
    id: string;
    label: string;
    icon: IconComponent;
    onSelect: () => void;
  }

  interface Props {
    /** Creatable kinds in the user's order; the first is the default. */
    actions: FabAction[];
    /** Listed after the kinds, never the default (templates). */
    extras: FabAction[];
    onSetDefault: (id: string) => void;
  }
  let { actions, extras, onSetDefault }: Props = $props();

  const primary = $derived(actions[0]);
  // Rebind to a PascalCase local so the markup can render it as a component.
  const PrimaryIcon = $derived(primary?.icon);

  function run(action: FabAction) {
    collapseFab();
    action.onSelect();
  }
</script>

{#snippet item(action: FabAction)}
  {@const Icon = action.icon}
  <button
    type="button"
    role="menuitem"
    class="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm hover:bg-accent"
    onclick={() => run(action)}
  >
    <Icon class="size-4 shrink-0 text-muted-foreground" />
    <span class="truncate">{action.label}</span>
  </button>
{/snippet}

{#if mobileState.fabExpanded}
  <!-- Scrim absorbs taps elsewhere so the menu behaves like a popover. -->
  <button
    type="button"
    aria-label={tUi('mobile.closeActionMenu')}
    class="fixed inset-0 z-30 bg-scrim"
    onclick={collapseFab}
  ></button>
{/if}

{#if primary}
  <div class="pointer-events-none absolute inset-0 z-40">
    <!-- Pointer events come back on the interactive children only, so the
         rest of the screen stays tappable. -->
    <div
      class="pointer-events-none absolute bottom-4 right-4 flex flex-col items-end gap-3"
    >
      {#if mobileState.fabExpanded}
        <div
          role="menu"
          aria-label={tUi('fab.menu')}
          class="pointer-events-auto w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-overlay"
        >
          {#each actions as action, index (action.id)}
            <div class="flex items-center">
              {@render item(action)}
              {#if index === 0}
                <span
                  class="shrink-0 px-3 text-[11px] font-medium text-accent-brand"
                  >{tUi('fab.default')}</span
                >
              {:else}
                <button
                  type="button"
                  class="grid size-9 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label={tUiFormat('fab.makeDefault', {
                    action: action.label
                  })}
                  title={tUiFormat('fab.makeDefault', {
                    action: action.label
                  })}
                  onclick={() => onSetDefault(action.id)}
                >
                  <Pin class="size-4" />
                </button>
              {/if}
            </div>
          {/each}
          {#if extras.length > 0}
            <div class="mx-2 my-1 border-t border-border"></div>
            {#each extras as action (action.id)}
              <div class="flex items-center">{@render item(action)}</div>
            {/each}
          {/if}
        </div>
      {/if}

      <div
        class="pointer-events-auto flex h-14 items-stretch overflow-hidden rounded-2xl bg-primary text-primary-foreground shadow-overlay"
      >
        <button
          type="button"
          class="flex min-w-0 items-center gap-2.5 pl-5 pr-4 text-sm font-medium hover:bg-primary-foreground/10"
          onclick={() => run(primary)}
        >
          <PrimaryIcon class="size-5 shrink-0" />
          <span class="truncate">{primary.label}</span>
        </button>
        <span class="my-3.5 w-px bg-primary-foreground/25" aria-hidden="true"
        ></span>
        <button
          type="button"
          class="flex w-12 shrink-0 items-center justify-center hover:bg-primary-foreground/10"
          onclick={toggleFabExpanded}
          aria-haspopup="menu"
          aria-expanded={mobileState.fabExpanded}
          aria-label={tUi(
            mobileState.fabExpanded ? 'mobile.closeActionMenu' : 'fab.showMenu'
          )}
          title={tUi(
            mobileState.fabExpanded ? 'mobile.closeActionMenu' : 'fab.showMenu'
          )}
        >
          <ChevronUp
            class="size-5 transition-transform {mobileState.fabExpanded
              ? 'rotate-180'
              : ''}"
          />
        </button>
      </div>
    </div>
  </div>
{/if}

<script lang="ts">
  /**
   * The create bar, anchored bottom-right. It mirrors the desktop file-tree
   * toolbar on this device: the first kind is the main button (the default),
   * the other toolbar kinds are pinned quick buttons beside it, as many as fit
   * in one row. The chevron opens everything that can be created, where a pin
   * toggles a kind's quick button and a radio picks the one default.
   * `extras` (templates) are listed after and are never pinned or default.
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
    /** Creatable kinds in toolbar order; the first is the default. */
    actions: FabAction[];
    /** Kinds shown as quick buttons beside the main one, in order. */
    pinned: string[];
    /** Listed after the kinds; never pinned or default (templates). */
    extras: FabAction[];
    onSetDefault: (id: string) => void;
    onTogglePin: (id: string) => void;
  }
  let { actions, pinned, extras, onSetDefault, onTogglePin }: Props = $props();

  /** A quick button (`size-11`) plus the row's `gap-2`, in px. */
  const QUICK_PX = 44 + 8;

  let rowWidth = $state(0);
  let mainWidth = $state(0);

  const primary = $derived(actions[0]);
  // Rebind to a PascalCase local so the markup can render it as a component.
  const PrimaryIcon = $derived(primary?.icon);
  const pinnedActions = $derived(
    pinned
      .map((id) => actions.find((action) => action.id === id))
      .filter((action): action is FabAction => !!action)
  );
  // Pinned kinds that do not fit beside the main button stay in the menu.
  const quickActions = $derived(
    pinnedActions.slice(
      0,
      Math.max(0, Math.floor((rowWidth - mainWidth) / QUICK_PX))
    )
  );

  function run(action: FabAction) {
    collapseFab();
    action.onSelect();
  }
</script>

{#snippet create(action: FabAction)}
  {@const Icon = action.icon}
  <button
    type="button"
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
      class="pointer-events-none absolute inset-x-4 bottom-4 flex flex-col items-end gap-3"
    >
      {#if mobileState.fabExpanded}
        <div
          role="dialog"
          aria-label={tUi('fab.menu')}
          class="pointer-events-auto w-80 max-w-full rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-overlay"
        >
          <!-- Column labels: pins can be many, the default only one. -->
          <div
            class="flex items-center pb-1 pl-3 pt-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
            aria-hidden="true"
          >
            <span class="flex-1">{tUi('fab.menu')}</span>
            <span class="w-9 text-center">{tUi('fab.pin')}</span>
            <span class="w-14 text-center">{tUi('fab.default')}</span>
          </div>
          <div role="radiogroup" aria-label={tUi('fab.defaultGroup')}>
            {#each actions as action, index (action.id)}
              {@const isDefault = index === 0}
              {@const isPinned = pinned.includes(action.id)}
              <div class="flex items-center">
                {@render create(action)}
                {#if isDefault}
                  <!-- The default is always on screen as the main button. -->
                  <span class="w-9 shrink-0"></span>
                {:else}
                  <button
                    type="button"
                    class="grid size-9 shrink-0 place-items-center rounded-lg hover:bg-accent {isPinned
                      ? 'text-accent-brand'
                      : 'text-muted-foreground'}"
                    aria-pressed={isPinned}
                    aria-label={tUiFormat('fab.pinAction', {
                      action: action.label
                    })}
                    title={tUiFormat('fab.pinAction', {
                      action: action.label
                    })}
                    onclick={() => onTogglePin(action.id)}
                  >
                    <Pin
                      class="size-4"
                      fill={isPinned ? 'currentColor' : 'none'}
                    />
                  </button>
                {/if}
                <button
                  type="button"
                  role="radio"
                  aria-checked={isDefault}
                  aria-label={tUiFormat('fab.makeDefault', {
                    action: action.label
                  })}
                  class="grid h-9 w-14 shrink-0 place-items-center rounded-lg hover:bg-accent"
                  onclick={() => onSetDefault(action.id)}
                >
                  <span
                    class="grid size-4 place-items-center rounded-full border-2 {isDefault
                      ? 'border-accent-brand'
                      : 'border-border-strong'}"
                  >
                    {#if isDefault}<span
                        class="size-1.5 rounded-full bg-accent-brand"
                      ></span>{/if}
                  </span>
                </button>
              </div>
            {/each}
          </div>
          {#if extras.length > 0}
            <div class="mx-2 my-1 border-t border-border"></div>
            {#each extras as action (action.id)}
              <div class="flex items-center">{@render create(action)}</div>
            {/each}
          {/if}
        </div>
      {/if}

      <div
        class="flex w-full items-center justify-end gap-2"
        bind:clientWidth={rowWidth}
      >
        {#each quickActions as action (action.id)}
          {@const Icon = action.icon}
          <button
            type="button"
            class="pointer-events-auto grid size-11 shrink-0 place-items-center rounded-full border border-border bg-surface-3 text-foreground shadow-raised hover:bg-accent"
            aria-label={action.label}
            title={action.label}
            onclick={() => run(action)}
          >
            <Icon class="size-5" />
          </button>
        {/each}
        <div
          bind:offsetWidth={mainWidth}
          class="pointer-events-auto flex h-11 min-w-0 shrink-0 items-stretch overflow-hidden rounded-full bg-primary text-primary-foreground shadow-overlay"
        >
          <button
            type="button"
            class="flex min-w-0 items-center gap-2 pl-4 pr-3 text-[13px] font-medium hover:bg-primary-foreground/10"
            onclick={() => run(primary)}
          >
            <PrimaryIcon class="size-4 shrink-0" />
            <span class="max-w-44 truncate">{primary.label}</span>
          </button>
          <span class="my-3 w-px bg-primary-foreground/25" aria-hidden="true"
          ></span>
          <button
            type="button"
            class="flex w-10 shrink-0 items-center justify-center hover:bg-primary-foreground/10"
            onclick={toggleFabExpanded}
            aria-haspopup="dialog"
            aria-expanded={mobileState.fabExpanded}
            aria-label={tUi(
              mobileState.fabExpanded
                ? 'mobile.closeActionMenu'
                : 'fab.showMenu'
            )}
            title={tUi(
              mobileState.fabExpanded
                ? 'mobile.closeActionMenu'
                : 'fab.showMenu'
            )}
          >
            <ChevronUp
              class="size-4 transition-transform {mobileState.fabExpanded
                ? 'rotate-180'
                : ''}"
            />
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}

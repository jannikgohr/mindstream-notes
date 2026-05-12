<script lang="ts">
  /**
   * Stacked floating action buttons. The bottom button is the primary
   * "new note" quick action; above it sits a plus button that fans out
   * the rest of `actions` as a vertical chip column.
   *
   * Drop another `{ id, label, icon, onSelect }` into the array passed
   * from MobileLayout and it appears in the fan-out — no changes here.
   * The primary action is wired separately because it always shows
   * regardless of expansion state.
   */
  import { Plus, X } from 'lucide-svelte';
  import type { IconComponent } from '$lib/settings/icons';
  import { mobileState, toggleFabExpanded, collapseFab } from './state.svelte';

  export interface FabAction {
    id: string;
    label: string;
    icon: IconComponent;
    onSelect: () => void;
  }

  interface Props {
    /** Primary quick action — always visible at the bottom. */
    primary: FabAction;
    /** Extra actions revealed when the plus is expanded. */
    actions: FabAction[];
  }
  let { primary, actions }: Props = $props();

  // Rebind the primary icon to a PascalCase local so the markup can
  // render it with the standard `<Component />` syntax — Svelte's dot-
  // notation form (`<primary.icon />`) trips the IDE's HTML parser even
  // though the compiler accepts it.
  const PrimaryIcon = $derived(primary.icon);

  function runPrimary() {
    collapseFab();
    primary.onSelect();
  }

  function runAction(a: FabAction) {
    collapseFab();
    a.onSelect();
  }
</script>

{#if mobileState.fabExpanded}
  <!-- Scrim absorbs taps elsewhere so the fan-out feels like a popover. -->
  <button
    type="button"
    aria-label="Close action menu"
    class="fixed inset-0 z-30 bg-black/20"
    onclick={collapseFab}
  ></button>
{/if}

<div class="pointer-events-none absolute inset-0 z-40">
  <!-- Stack anchored bottom-right. pointer-events re-enabled on the
       interactive children only so the rest of the screen stays tappable. -->
  <div class="pointer-events-none absolute bottom-4 right-4 flex flex-col items-end gap-3">
    {#if mobileState.fabExpanded}
      {#each actions as a (a.id)}
        {@const Icon = a.icon}
        <div class="pointer-events-auto flex items-center gap-2">
          <span class="rounded-md bg-card px-2 py-1 text-xs font-medium shadow-md">
            {a.label}
          </span>
          <button
            type="button"
            class="flex size-12 items-center justify-center rounded-full bg-card text-foreground shadow-md ring-1 ring-border hover:bg-accent"
            onclick={() => runAction(a)}
            aria-label={a.label}
            title={a.label}
          >
            <Icon class="size-5" />
          </button>
        </div>
      {/each}
    {/if}

    <button
      type="button"
      class="pointer-events-auto flex size-12 items-center justify-center rounded-full bg-secondary text-secondary-foreground shadow-md ring-1 ring-border transition-transform hover:bg-accent"
      class:rotate-45={mobileState.fabExpanded}
      onclick={toggleFabExpanded}
      aria-expanded={mobileState.fabExpanded}
      aria-label={mobileState.fabExpanded ? 'Close action menu' : 'More actions'}
      title={mobileState.fabExpanded ? 'Close' : 'More actions'}
    >
      {#if mobileState.fabExpanded}
        <X class="size-5" />
      {:else}
        <Plus class="size-5" />
      {/if}
    </button>

    <button
      type="button"
      class="pointer-events-auto flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90"
      onclick={runPrimary}
      aria-label={primary.label}
      title={primary.label}
    >
      <PrimaryIcon class="size-6" />
    </button>
  </div>
</div>

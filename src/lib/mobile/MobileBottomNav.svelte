<script lang="ts">
  /**
   * Bottom tab bar with the four primary buckets. Each entry is a tap
   * target plus an accessible label; the active bucket gets a coloured
   * icon + label and a top accent stripe. Add a new tab by appending
   * to the TABS array and matching MobileView.
   */
  import { Home, Share2, Star, Trash2 } from 'lucide-svelte';
  import type { IconComponent } from '$lib/settings/icons';
  import { mobileState, setMobileView, type MobileView } from './state.svelte';

  interface Tab {
    id: MobileView;
    label: string;
    icon: IconComponent;
  }

  const TABS: Tab[] = [
    { id: 'home', label: 'Home', icon: Home as unknown as IconComponent },
    { id: 'shared', label: 'Shared', icon: Share2 as unknown as IconComponent },
    { id: 'favourite', label: 'Favourites', icon: Star as unknown as IconComponent },
    { id: 'trash', label: 'Trash', icon: Trash2 as unknown as IconComponent }
  ];
</script>

<nav
  class="flex shrink-0 select-none items-stretch border-t border-border bg-card"
  aria-label="Primary"
>
  {#each TABS as tab (tab.id)}
    {@const active = mobileState.view === tab.id}
    {@const Icon = tab.icon}
    <button
      type="button"
      class="relative flex flex-1 flex-col items-center justify-center gap-0.5 py-2 transition-colors {active
        ? 'text-foreground'
        : 'text-muted-foreground hover:text-foreground'}"
      onclick={() => setMobileView(tab.id)}
      aria-current={active ? 'page' : undefined}
      aria-label={tab.label}
    >
      {#if active}
        <span
          class="absolute inset-x-6 top-0 h-0.5 rounded-b-full bg-primary"
          aria-hidden="true"
        ></span>
      {/if}
      <Icon class="size-5" />
      <span class="text-[10px] font-medium">{tab.label}</span>
    </button>
  {/each}
</nav>

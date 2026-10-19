<script lang="ts">
  /**
   * Bottom tab bar with the four primary buckets. Each entry is a tap
   * target plus an accessible label; the active bucket gets a coloured
   * icon + label and a top accent stripe. Add a new tab by appending
   * to the TABS array and matching MobileView.
   */
  // Bottom-nav star is a tab affordance, not a favourite-toggle —
  // there's no "flip" moment to celebrate, so we stick to the static
  // lucide glyph instead of pulling in jis3r's hover-driven version.
  import { Home, Share2, Star, Trash2 } from '@lucide/svelte';
  import type { IconComponent } from '$lib/settings/icons';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { mobileState, setMobileView, type MobileView } from './state.svelte';

  interface Tab {
    id: MobileView;
    /** i18n key under `ui.*` resolved at render time. */
    labelKey: string;
    icon: IconComponent;
  }

  // Labels go through tUi at render time (see {#each} below) rather
  // than being baked into the array, so language switches re-evaluate.
  const TABS: Tab[] = [
    {
      id: 'home',
      labelKey: 'nav.home',
      icon: Home as unknown as IconComponent
    },
    {
      id: 'shared',
      labelKey: 'nav.shared',
      icon: Share2 as unknown as IconComponent
    },
    {
      id: 'favourite',
      labelKey: 'nav.favourite',
      icon: Star as unknown as IconComponent
    },
    {
      id: 'trash',
      labelKey: 'nav.trash',
      icon: Trash2 as unknown as IconComponent
    }
  ];
</script>

<nav
  class="flex shrink-0 select-none items-stretch border-t border-border bg-surface-0"
  aria-label={tUi('nav.primary')}
>
  {#each TABS as tab (tab.id)}
    {@const active = mobileState.view === tab.id}
    {@const Icon = tab.icon}
    {@const label = tUi(tab.labelKey)}
    <!-- Active is the desktop sidebar's accent wash, behind the icon. -->
    <button
      type="button"
      class="flex flex-1 flex-col items-center justify-center gap-1 pb-2 pt-2.5 transition-colors {active
        ? 'text-accent-brand'
        : 'text-muted-foreground hover:text-foreground'}"
      onclick={() => setMobileView(tab.id)}
      aria-current={active ? 'page' : undefined}
      aria-label={label}
    >
      <span
        class="flex h-7 w-14 items-center justify-center rounded-full transition-colors {active
          ? 'bg-accent-brand/10'
          : ''}"
      >
        <Icon class="size-5" />
      </span>
      <span class="text-[11px] {active ? 'font-semibold' : 'font-medium'}"
        >{label}</span
      >
    </button>
  {/each}
</nav>

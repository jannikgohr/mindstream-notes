<script lang="ts">
  /**
   * Home-screen top bar: tap-to-search trigger + settings button. The
   * editor screen renders its own header (see MobileEditor.svelte) —
   * this one is only shown when the home browser is foreground.
   *
   * The search affordance opens the global SearchDialog (mounted at the
   * root layout) so desktop and mobile share the same scoring, snippet,
   * and match-highlighting behaviour. Tapping the pill auto-focuses the
   * dialog input, so the typing flow stays continuous despite the
   * intermediate UI step.
   */
  import { Settings as SettingsIcon } from 'lucide-svelte';
  import { Search } from '@jis3r/icons';
  import { Button } from '$lib/components/ui/button';
  import { openSettings } from '$lib/settings/store.svelte';
  import { openSearch } from '$lib/search/store.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import MobileNotificationCenter from './MobileNotificationCenter.svelte';
</script>

<header
  class="flex shrink-0 select-none items-center gap-2 border-b border-border bg-card px-3 py-2"
>
  <button
    type="button"
    onclick={openSearch}
    aria-label={tUi('search.notes.label')}
    class="relative flex h-12 min-w-0 flex-1 items-center gap-3 rounded-full border border-input bg-background pl-11 pr-4 text-left text-sm text-muted-foreground hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
  >
    <Search
      size={20}
      class="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground"
    />
    <span class="truncate">{tUi('search.notes.placeholder')}</span>
  </button>

  <MobileNotificationCenter />

  <Button
    variant="ghost"
    onclick={openSettings}
    title={tUi('settings.open')}
    aria-label={tUi('settings.open')}
    class="size-12 shrink-0 rounded-full border border-input p-0 [&_svg]:size-8"
  >
    <!--
      Default Lucide stroke-width is 2 — at the original size-4 (16px)
      that rendered as ~1.3px visually. Doubling the icon to size-8
      (32px) without compensating would double the line thickness too;
      halving stroke-width keeps the visual weight constant.
    -->
    <SettingsIcon strokeWidth={1} />
  </Button>
</header>

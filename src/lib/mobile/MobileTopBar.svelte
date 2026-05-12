<script lang="ts">
  /**
   * Home-screen top bar: search field + settings button. The editor
   * screen renders its own header (see MobileEditor.svelte) — this one
   * is only shown when the home browser is foreground.
   */
  import { Search, Settings as SettingsIcon } from 'lucide-svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { openSettings } from '$lib/settings/store.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { mobileState, setSearchQuery } from './state.svelte';
</script>

<header
  class="flex shrink-0 select-none items-center gap-2 border-b border-border bg-card px-3 py-2"
>
  <div class="relative min-w-0 flex-1">
    <Search
      class="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-muted-foreground"
    />
    <Input
      type="search"
      placeholder={tUi('search.notes.placeholder')}
      value={mobileState.searchQuery}
      oninput={(e) => setSearchQuery((e.currentTarget as HTMLInputElement).value)}
      class="h-12 w-full rounded-full pl-11 pr-4"
      aria-label={tUi('search.notes.label')}
    />
  </div>

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

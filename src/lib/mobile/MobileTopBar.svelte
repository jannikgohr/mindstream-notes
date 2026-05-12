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
  class="flex h-14 shrink-0 select-none items-center gap-2 border-b border-border bg-card px-3"
>
  <div class="relative min-w-0 flex-1">
    <Search
      class="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
    />
    <Input
      type="search"
      placeholder={tUi('search.notes.placeholder')}
      value={mobileState.searchQuery}
      oninput={(e) => setSearchQuery((e.currentTarget as HTMLInputElement).value)}
      class="h-9 w-full pl-8"
      aria-label={tUi('search.notes.label')}
    />
  </div>

  <Button
    variant="ghost"
    size="icon"
    onclick={openSettings}
    title={tUi('settings.open')}
    aria-label={tUi('settings.open')}
  >
    <SettingsIcon class="size-5" />
  </Button>
</header>

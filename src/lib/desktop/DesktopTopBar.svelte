<script lang="ts">
  import { PanelLeft, PanelRight } from 'lucide-svelte';
  import { Search as SearchIcon, Settings as SettingsIcon } from '@jis3r/icons';
  import { Button } from '$lib/components/ui/button';
  import { Separator } from '$lib/components/ui/separator';
  import ThemeToggle from '$lib/components/ThemeToggle.svelte';
  import WindowControls from '$lib/components/WindowControls.svelte';
  import NotificationCenter from '$lib/notifications/NotificationCenter.svelte';
  import { ui, toggleLeftSidebar, toggleRightSidebar } from '$lib/state.svelte';
  import { openSettings } from '$lib/settings/store.svelte';
  import { openSearch } from '$lib/search/store.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
</script>

<header
  data-tauri-drag-region
  class="flex h-10 shrink-0 select-none items-center gap-1 border-b border-border bg-card px-2"
>
  <Button
    variant="ghost"
    size="icon"
    onclick={toggleLeftSidebar}
    title={ui.leftSidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
    aria-label="Toggle left sidebar"
  >
    <PanelLeft class="size-4" />
  </Button>
  <Separator orientation="vertical" class="mx-1 h-5" />
  <span
    data-tauri-drag-region
    class="text-xs font-medium text-muted-foreground"
  >
    Mindstream Notes
  </span>

  <div data-tauri-drag-region class="flex-1"></div>

  <Button
    variant="ghost"
    size="icon"
    onclick={openSearch}
    title={tUi('search.open')}
    aria-label={tUi('search.open')}
  >
    <SearchIcon size={16} />
  </Button>
  <NotificationCenter />
  <Button
    variant="ghost"
    size="icon"
    onclick={openSettings}
    title="Settings"
    aria-label="Open settings"
  >
    <SettingsIcon size={16} />
  </Button>
  <ThemeToggle />
  <Button
    variant="ghost"
    size="icon"
    onclick={toggleRightSidebar}
    title={ui.rightSidebarOpen ? 'Hide metadata' : 'Show metadata'}
    aria-label="Toggle right sidebar"
  >
    <PanelRight class="size-4" />
  </Button>

  <Separator orientation="vertical" class="mx-1 h-5" />
  <WindowControls />
</header>

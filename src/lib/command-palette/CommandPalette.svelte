<script lang="ts">
  /**
   * Obsidian / Joplin-style command palette.
   *
   * Mounted once at the root layout (via `LazyRootSingletons`); opens via
   * `openCommandPalette()` — the `Mod+P` hotkey or the top-bar button. Type to
   * filter, ArrowUp/Down to move the selection, Enter to run, Esc to close.
   *
   * The entry list (`paletteCommands()`) is snapshotted once when the dialog
   * mounts — the component is unmounted on close, so every open rebuilds it
   * against the live app state (enabled plugins, current bindings, the active
   * editor). Filtering and selection are local and don't need to survive a
   * close, exactly like `SearchDialog`.
   */
  import { tick } from 'svelte';
  import { Dialog } from 'bits-ui';
  import { SquareChevronRight, X } from '@lucide/svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { closeCommandPalette, commandPalette } from './store.svelte';
  import {
    paletteCommands,
    type PaletteCommand,
    type PaletteSection
  } from './commands';

  // Snapshot the runnable commands for this open. Fresh per mount.
  const all = paletteCommands();

  let query = $state('');
  let selectedIndex = $state(0);
  let inputEl: HTMLInputElement | null = $state(null);
  let listEl: HTMLDivElement | null = $state(null);

  const lowerQuery = $derived(query.trim().toLowerCase());

  const SECTION_ORDER: PaletteSection[] = ['application', 'templates'];

  function sectionTitle(section: PaletteSection): string {
    return tUi(`commandPalette.section.${section}`);
  }

  function matches(cmd: PaletteCommand): boolean {
    if (!lowerQuery) return true;
    return [
      cmd.label,
      cmd.keywords ?? '',
      sectionTitle(cmd.section),
      cmd.hint ?? ''
    ]
      .join(' ')
      .toLowerCase()
      .includes(lowerQuery);
  }

  // Flat, ordered list of the currently-visible commands. `selectedIndex`
  // indexes into this so arrow navigation crosses section boundaries.
  const visible = $derived(all.filter(matches));

  // The visible list grouped by section (for headers), each item tagged with
  // its flat index so a row can highlight/activate the right selection.
  const groups = $derived.by(() => {
    const result: {
      section: PaletteSection;
      title: string;
      items: { cmd: PaletteCommand; index: number }[];
    }[] = [];
    visible.forEach((cmd, index) => {
      let group = result.find((g) => g.section === cmd.section);
      if (!group) {
        group = {
          section: cmd.section,
          title: sectionTitle(cmd.section),
          items: []
        };
        result.push(group);
      }
      group.items.push({ cmd, index });
    });
    result.sort(
      (a, b) =>
        SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section)
    );
    return result;
  });

  // Keep the selection in range as the filtered list shrinks/grows.
  $effect(() => {
    if (selectedIndex > visible.length - 1) selectedIndex = 0;
  });

  async function handleOpenAutoFocus(e: Event) {
    e.preventDefault();
    await tick();
    inputEl?.focus();
  }

  function moveSelection(delta: number) {
    if (visible.length === 0) return;
    selectedIndex = (selectedIndex + delta + visible.length) % visible.length;
    scrollSelectedIntoView();
  }

  function scrollSelectedIntoView() {
    if (!listEl) return;
    const el = listEl.querySelector(
      `[data-result-index="${selectedIndex}"]`
    ) as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  }

  function activate(index: number) {
    const cmd = visible[index];
    if (!cmd) return;
    // Close first so anything the command opens (settings, a new note) isn't
    // fighting the palette for focus.
    closeCommandPalette();
    cmd.run();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSelection(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activate(selectedIndex);
    }
    // Esc is handled by bits-ui Dialog automatically.
  }
</script>

<Dialog.Root
  bind:open={commandPalette.open}
  onOpenChange={(o: boolean) => {
    if (!o) closeCommandPalette();
  }}
>
  <Dialog.Portal>
    <Dialog.Overlay
      class="fixed inset-0 z-350 bg-scrim backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
    />
    <Dialog.Content
      onkeydown={onKeydown}
      onOpenAutoFocus={handleOpenAutoFocus}
      class="fixed left-1/2 top-[8vh] z-350 flex h-[min(72vh,640px)] w-[min(720px,94vw)] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-border bg-background text-foreground shadow-xl focus:outline-none"
    >
      <Dialog.Title class="sr-only">{tUi('commandPalette.title')}</Dialog.Title>

      <header class="flex items-center gap-2 border-b border-border px-3 py-2">
        <SquareChevronRight class="size-4 shrink-0 text-muted-foreground" />
        <input
          bind:this={inputEl}
          bind:value={query}
          type="text"
          placeholder={tUi('commandPalette.placeholder')}
          aria-label={tUi('commandPalette.title')}
          class="h-9 w-full bg-transparent text-sm placeholder:text-muted-foreground focus:outline-none"
        />
        <Dialog.Close
          class="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={tUi('commandPalette.close')}
        >
          <X class="size-4" />
        </Dialog.Close>
      </header>

      <div
        bind:this={listEl}
        class="themed-scrollbar min-h-0 flex-1 overflow-y-auto"
      >
        {#if all.length === 0}
          <p class="px-4 py-8 text-center text-sm text-muted-foreground">
            {tUi('commandPalette.empty')}
          </p>
        {:else if visible.length === 0}
          <p class="px-4 py-8 text-center text-sm text-muted-foreground">
            {tUi('commandPalette.noResults')}
          </p>
        {:else}
          <div class="py-1">
            {#each groups as group (group.section)}
              <h3
                class="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
              >
                {group.title}
              </h3>
              <ul class="flex flex-col">
                {#each group.items as item (item.cmd.id)}
                  {@const isActive = item.index === selectedIndex}
                  <li>
                    <button
                      type="button"
                      data-result-index={item.index}
                      onmouseenter={() => (selectedIndex = item.index)}
                      onclick={() => activate(item.index)}
                      class="flex w-full items-center justify-between gap-3 border-l-2 px-3 py-2 text-left text-sm transition-colors {isActive
                        ? 'border-primary bg-accent text-accent-foreground'
                        : 'border-transparent text-foreground hover:bg-accent/60'}"
                    >
                      <span class="min-w-0 truncate">{item.cmd.label}</span>
                      {#if item.cmd.hint}
                        <kbd
                          class="shrink-0 rounded-md border border-border bg-muted px-2 py-0.5 font-mono text-xs"
                        >
                          {item.cmd.hint}
                        </kbd>
                      {/if}
                    </button>
                  </li>
                {/each}
              </ul>
            {/each}
          </div>
        {/if}
      </div>

      <footer
        class="hidden shrink-0 items-center justify-end border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground sm:flex"
      >
        {tUi('commandPalette.hint')}
      </footer>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

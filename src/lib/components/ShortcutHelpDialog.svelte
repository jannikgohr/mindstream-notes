<script lang="ts">
  /**
   * Cheat-sheet overlay showing every catalogued command and its
   * current keyboard binding.
   *
   * Mounted once at the root layout. Driven entirely by the
   * `shortcutHelp` $state from `$lib/hotkeys/help.svelte.ts` — open
   * the dialog from anywhere with `openShortcutHelp()`. Defaults to
   * `Shift+?` (Gmail / GitHub convention).
   *
   * Render strategy:
   *
   *   - `groupedCommands()` returns the static catalogue grouped by
   *     scope / editor kind; we render one column per group when the
   *     viewport is wide enough, single column otherwise.
   *   - Per-command rows read `getBinding(cmd.id)` so the displayed
   *     shortcut is live — rebinding from the settings panel while
   *     this dialog is open updates the chip immediately.
   *   - "Unset" rows still render so users can see what's available
   *     even when they have nothing bound. Sorting them to the
   *     bottom of each group keeps the bound shortcuts at the top
   *     where most users will look.
   */
  import { Dialog } from 'bits-ui';
  import { Keyboard, Search, X } from '@lucide/svelte';
  import {
    groupedCommands,
    isGlobalShortcutOnlyCommand,
    type CommandDefinition
  } from '$lib/hotkeys/catalogue';
  import { displayBinding } from '$lib/hotkeys/format';
  import { getBinding } from '$lib/hotkeys/store.svelte';
  import { closeShortcutHelp, shortcutHelp } from '$lib/hotkeys/help.svelte';
  import { getSettingValue } from '$lib/settings/store.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';

  /**
   * Static catalogue grouped by scope / editor kind. The catalogue
   * doesn't change at runtime; per-binding reactivity comes from
   * `getBinding(cmd.id)` at the row level.
   */
  const catalogueGroups = groupedCommands();
  const globalShortcutsEnabled = $derived(
    getSettingValue('hotkeys.globalShortcuts') === true
  );
  const groups = $derived.by(() => {
    if (globalShortcutsEnabled) return catalogueGroups;
    return catalogueGroups
      .map((group) =>
        group.scope === 'global'
          ? {
              ...group,
              commands: group.commands.filter(
                (cmd) => !isGlobalShortcutOnlyCommand(cmd)
              )
            }
          : group
      )
      .filter((group) => group.commands.length > 0);
  });
  let query = $state('');
  const lowerQuery = $derived(query.trim().toLowerCase());

  function groupTitle(scope: string, kind: string | null): string {
    if (scope === 'global') return tUi('hotkeys.group.global');
    return tUi(`hotkeys.group.editor.${kind}`);
  }

  function commandLabel(cmd: CommandDefinition): string {
    return tUi(cmd.labelKey);
  }

  function matchesCommand(
    cmd: CommandDefinition,
    groupLabel: string,
    current: string | null
  ): boolean {
    if (!lowerQuery) return true;
    const display = displayBinding(current) || tUi('hotkeys.unset');
    return [cmd.id, commandLabel(cmd), groupLabel, current ?? '', display]
      .join(' ')
      .toLowerCase()
      .includes(lowerQuery);
  }
</script>

<Dialog.Root
  bind:open={shortcutHelp.open}
  onOpenChange={(o: boolean) => {
    if (!o) closeShortcutHelp();
  }}
>
  <Dialog.Portal>
    <Dialog.Overlay
      class="fixed inset-0 z-350 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
    />
    <Dialog.Content
      class="fixed left-1/2 top-1/2 z-350 grid h-[80vh] w-[min(720px,92vw)] -translate-x-1/2 -translate-y-1/2 grid-rows-[auto_1fr] overflow-hidden rounded-lg border border-border bg-background text-foreground shadow-xl focus:outline-none"
    >
      <header
        class="flex items-center gap-3 border-b border-border bg-card px-4 py-3"
      >
        <Keyboard class="size-4 text-muted-foreground" aria-hidden="true" />
        <Dialog.Title class="text-base font-semibold">
          {tUi('hotkeys.help.title')}
        </Dialog.Title>
        <div class="relative ml-2 flex-1">
          <Search
            class="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            type="search"
            bind:value={query}
            placeholder={tUi('hotkeys.search.placeholder')}
            aria-label={tUi('hotkeys.search.label')}
            class="h-8 w-full rounded-md border border-input bg-background pl-7 pr-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <Dialog.Close
          class="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={tUi('close')}
        >
          <X class="size-4" />
        </Dialog.Close>
      </header>

      <section class="themed-scrollbar overflow-y-auto px-5 py-4">
        <div class="space-y-6">
          {#each groups as group (`${group.scope}:${group.editorKind ?? ''}`)}
            {@const title = groupTitle(group.scope, group.editorKind)}
            {@const visibleCommands = group.commands.filter((cmd) =>
              matchesCommand(cmd, title, getBinding(cmd.id))
            )}
            {#if visibleCommands.length > 0}
              <div>
                <h3
                  class="border-b border-border pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  {title}
                </h3>
                <ul class="divide-y divide-border">
                  {#each visibleCommands as cmd (cmd.id)}
                    {@const current = getBinding(cmd.id)}
                    {@const display = displayBinding(current)}
                    <li
                      class="flex items-center justify-between gap-3 py-2 text-sm"
                    >
                      <span class="min-w-0 truncate">{commandLabel(cmd)}</span>
                      {#if display}
                        <kbd
                          class="shrink-0 rounded-md border border-border bg-muted px-2 py-0.5 font-mono text-xs"
                        >
                          {display}
                        </kbd>
                      {:else}
                        <span
                          class="shrink-0 text-xs italic text-muted-foreground"
                        >
                          {tUi('hotkeys.unset')}
                        </span>
                      {/if}
                    </li>
                  {/each}
                </ul>
              </div>
            {/if}
          {/each}
          {#if lowerQuery && groups.every((group) => {
              const title = groupTitle(group.scope, group.editorKind);
              return group.commands.every((cmd) => !matchesCommand(cmd, title, getBinding(cmd.id)));
            })}
            <p class="py-8 text-center text-sm text-muted-foreground">
              {tUi('hotkeys.search.empty')}
            </p>
          {/if}
        </div>
      </section>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

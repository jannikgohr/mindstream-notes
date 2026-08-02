<script lang="ts">
  /**
   * Plugin management overview — one row per installed plugin (core +
   * third-party, enabled + disabled), styled after Obsidian's community-plugins
   * list: name + version + author + description on the left, a row of action
   * icons on the right.
   *
   * Right-side icons, left→right, each shown only when it applies:
   *   - docs (book)      — opens the read-only documentation modal (if the
   *     plugin ships `contributes.documentation`);
   *   - permissions      — a popover listing what the plugin may do;
   *   - settings (gear)  — jumps to the plugin's settings pane (enabled +
   *     contributes settings; navigation supplied by the host shell);
   *   - hotkeys (keyboard) — jumps to the hotkeys panel (enabled + publishes
   *     commands; desktop only — the host omits the callback on mobile);
   *   - trash            — uninstalls a third-party plugin (behind a confirm);
   *   - toggle           — enable/disable, or an Approve button when the
   *     integrity gate disabled a third-party plugin.
   *
   * Toggling is optimistic + reactive (see manage.svelte.ts) so a plugin's
   * settings, create-menu templates and hotkeys appear/vanish live.
   */
  import { onMount } from 'svelte';
  import { Popover } from 'bits-ui';
  import {
    BookOpen,
    Keyboard,
    Settings as SettingsIcon,
    Shield,
    Trash2
  } from '@lucide/svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { tooltip } from '$lib/actions/tooltip';
  import { confirm } from '$lib/components/confirm-dialog.svelte';
  import {
    approvePluginAdmin,
    pluginOverview,
    refreshPluginAdmin,
    removePluginAdmin,
    setPluginEnabledAdmin,
    type PluginOverviewEntry
  } from './manage.svelte';
  import { SOURCE_BUILTIN, SOURCE_INSTALLED } from './source';
  import type { PluginDocSection } from './types';
  import PluginDocsDialog from './PluginDocsDialog.svelte';

  interface Props {
    /** Jump to a plugin's own settings pane. Omit to hide the settings icon. */
    onOpenSettings?: (id: string) => void;
    /** Jump to the hotkeys panel for a plugin. Omit (e.g. mobile) to hide it. */
    onOpenHotkeys?: (id: string) => void;
  }
  let { onOpenSettings, onOpenHotkeys }: Props = $props();

  onMount(() => {
    void refreshPluginAdmin();
  });

  const entries = $derived(pluginOverview());

  // Documentation modal (read-only Milkdown), opened per plugin. Content is
  // loaded lazily from the plugin's bundled .md files by the dialog itself.
  let docsOpen = $state(false);
  let docsTitle = $state('');
  let docsPluginId = $state('');
  let docsSections = $state<PluginDocSection[]>([]);
  function openDocs(entry: PluginOverviewEntry) {
    docsTitle = entry.name;
    docsPluginId = entry.id;
    docsSections = entry.documentation;
    docsOpen = true;
  }

  /** Confirm, then uninstall a third-party plugin. */
  async function requestDelete(entry: PluginOverviewEntry) {
    const ok = await confirm({
      title: tUi('plugins.delete.confirm.title'),
      message: tUi('plugins.delete.confirm.message').replace(
        '{name}',
        entry.name
      ),
      confirmLabel: tUi('plugins.delete.confirm.confirm'),
      destructive: true
    });
    if (ok) await removePluginAdmin(entry.id);
  }

  /** Human label for a permission id (falls back to the raw id if untranslated). */
  function permissionLabel(perm: string): string {
    return tUi(`plugins.permission.${perm}`);
  }

  /**
   * The concrete binary names a native-execution permission covers, so the user
   * sees exactly which PATH executables a plugin may run — listed as sub-bullets
   * under the permission. Empty for every other permission.
   */
  function permissionBinaries(
    entry: PluginOverviewEntry,
    perm: string
  ): string[] {
    if (perm === 'nativeTools.runDeclared') return entry.nativeToolBinaries;
    if (perm === 'nativeServices.run') return entry.nativeServiceBinaries;
    return [];
  }

  function sourceLabel(source: string): string {
    return source === SOURCE_BUILTIN
      ? tUi('plugins.source.builtin')
      : tUi('plugins.source.installed');
  }

  /**
   * Signature status classes, or null to hide the chip. Only shown for
   * third-party plugins — a Core plugin is trusted by its bundled location, not
   * by a signature, so a signature chip there would be noise.
   */
  function signatureChip(
    source: string,
    status: string
  ): { label: string; class: string } | null {
    if (source === SOURCE_BUILTIN) return null;
    if (status === 'valid') {
      return {
        label: tUi('plugins.signature.valid'),
        class: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400'
      };
    }
    if (status === 'invalid') {
      return {
        label: tUi('plugins.signature.invalid'),
        class: 'border-destructive/40 text-destructive'
      };
    }
    return {
      label: tUi('plugins.signature.unsigned'),
      class: 'border-border text-muted-foreground'
    };
  }

  // Shared classes for the round ghost icon buttons in the action row.
  const iconButton =
    'flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
</script>

<div class="mt-4">
  {#if entries.length === 0}
    <p class="py-6 text-center text-sm text-muted-foreground">
      {tUi('plugins.manage.empty')}
    </p>
  {:else}
    <div class="divide-y divide-border">
      {#each entries as entry (entry.id)}
        {@const sig = signatureChip(entry.source, entry.signatureStatus)}
        {@const gated =
          !entry.enabled &&
          !!entry.loadError &&
          entry.source === SOURCE_INSTALLED}
        {@const showSettings =
          entry.enabled && entry.hasSettings && !!onOpenSettings}
        {@const showHotkeys =
          entry.enabled && entry.hasCommands && !!onOpenHotkeys}
        {@const showTrash = entry.source === SOURCE_INSTALLED}
        <div class="flex items-start justify-between gap-4 py-3">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-sm font-medium" use:tooltip={entry.id}>
                {entry.name}
              </span>
              <span
                class="rounded border border-border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
              >
                {sourceLabel(entry.source)}
              </span>
              {#if sig}
                <span
                  class="rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide {sig.class}"
                  use:tooltip={entry.signer
                    ? `${sig.label} · ${entry.signer.slice(0, 16)}…`
                    : sig.label}
                >
                  {sig.label}
                </span>
              {/if}
            </div>
            <p class="mt-0.5 text-xs text-muted-foreground">
              {tUi('plugins.version')}: {entry.version}
            </p>
            {#if entry.author}
              <p class="text-xs text-muted-foreground">
                {tUi('plugins.author')}
                {entry.author}
              </p>
            {/if}
            {#if entry.description}
              <p class="mt-1 text-xs text-muted-foreground">
                {entry.description}
              </p>
            {/if}
            {#if entry.loadError}
              <p class="mt-1 text-xs text-destructive">
                {tUi('plugins.manage.notLoaded')}: {entry.loadError}
              </p>
            {/if}
          </div>

          <div class="flex shrink-0 items-center gap-0.5">
            {#if entry.documentation.length > 0}
              <button
                type="button"
                class={iconButton}
                aria-label={tUi('plugins.docs.view')}
                use:tooltip={tUi('plugins.docs.view')}
                onclick={() => openDocs(entry)}
              >
                <BookOpen class="size-4" />
              </button>
            {/if}

            <Popover.Root>
              <Popover.Trigger>
                {#snippet child({ props })}
                  <button
                    {...props}
                    class={iconButton}
                    aria-label={tUi('plugins.permissions.title')}
                    use:tooltip={tUi('plugins.permissions.title')}
                  >
                    <Shield class="size-4" />
                  </button>
                {/snippet}
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  sideOffset={6}
                  class="z-[400] w-64 rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-md focus:outline-none"
                >
                  <p class="text-xs font-semibold">
                    {tUi('plugins.permissions.title')}
                  </p>
                  {#if entry.permissions.length > 0}
                    <ul
                      class="mt-1.5 list-disc space-y-1 pl-4 text-xs text-muted-foreground"
                    >
                      {#each entry.permissions as perm (perm)}
                        {@const binaries = permissionBinaries(entry, perm)}
                        <li>
                          {permissionLabel(perm)}
                          {#if binaries.length > 0}
                            <ul class="mt-0.5 list-disc space-y-0.5 pl-4">
                              {#each binaries as binary (binary)}
                                <li>
                                  <code class="font-mono">{binary}</code>
                                </li>
                              {/each}
                            </ul>
                          {/if}
                        </li>
                      {/each}
                    </ul>
                  {:else}
                    <p class="mt-1.5 text-xs text-muted-foreground">
                      {tUi('plugins.permissions.none')}
                    </p>
                  {/if}
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>

            {#if showSettings}
              <button
                type="button"
                class={iconButton}
                aria-label={tUi('plugins.settings.open')}
                use:tooltip={tUi('plugins.settings.open')}
                onclick={() => onOpenSettings?.(entry.id)}
              >
                <SettingsIcon class="size-4" />
              </button>
            {/if}

            {#if showHotkeys}
              <button
                type="button"
                class={iconButton}
                aria-label={tUi('plugins.hotkeys.open')}
                use:tooltip={tUi('plugins.hotkeys.open')}
                onclick={() => onOpenHotkeys?.(entry.id)}
              >
                <Keyboard class="size-4" />
              </button>
            {/if}

            {#if showTrash}
              <button
                type="button"
                class="{iconButton} hover:text-destructive"
                aria-label={tUi('plugins.delete')}
                use:tooltip={tUi('plugins.delete')}
                onclick={() => void requestDelete(entry)}
              >
                <Trash2 class="size-4" />
              </button>
            {/if}

            {#if gated}
              <button
                type="button"
                onclick={() => void approvePluginAdmin(entry.id)}
                class="ml-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {tUi('plugins.manage.approve')}
              </button>
            {:else}
              <button
                type="button"
                role="switch"
                aria-checked={entry.enabled}
                aria-label={tUi('plugins.manage.toggle')}
                onclick={() =>
                  void setPluginEnabledAdmin(entry.id, !entry.enabled)}
                class="relative ml-1 inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 {entry.enabled
                  ? 'bg-primary'
                  : 'bg-input'}"
              >
                <span
                  class="pointer-events-none block size-4 rounded-full bg-background shadow-sm ring-0 transition-transform {entry.enabled
                    ? 'translate-x-4.5'
                    : 'translate-x-0.5'}"
                ></span>
              </button>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<PluginDocsDialog
  bind:open={docsOpen}
  title={docsTitle}
  pluginId={docsPluginId}
  sections={docsSections}
/>

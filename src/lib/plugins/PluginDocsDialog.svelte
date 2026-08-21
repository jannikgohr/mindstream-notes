<script lang="ts">
  /**
   * Plugin documentation modal. Renders a plugin's file-backed docs
   * (`contributes.documentation`) read-only with Milkdown. When a plugin ships
   * more than one section, a left-hand list lets the user navigate between them;
   * a single-section plugin renders just the content.
   *
   * Section content + nav titles are loaded lazily when the dialog opens (see
   * docs-loader): the manifest only carries file references, and titles come
   * from each file's first `# H1`. Stacks above the settings dialog.
   */
  import { Dialog } from 'bits-ui';
  import { X } from '@lucide/svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import ReadonlyNoteView from '$lib/components/history/ReadonlyNoteView.svelte';
  import { loadPluginDocs, type LoadedDocSection } from './docs-loader';
  import type { PluginDocSection } from './types';

  interface Props {
    open: boolean;
    /** The plugin's display name — the modal heading. */
    title: string;
    pluginId: string;
    sections: PluginDocSection[];
  }
  let { open = $bindable(), title, pluginId, sections }: Props = $props();

  let loaded = $state<LoadedDocSection[]>([]);
  let selected = $state(0);
  let loading = $state(false);

  // (Re)load whenever the dialog opens for a plugin. Keyed on open + pluginId so
  // switching plugins without closing (unlikely, but cheap) still refreshes.
  let loadToken = 0;
  $effect(() => {
    if (!open) return;
    const token = ++loadToken;
    const id = pluginId;
    const secs = sections;
    loaded = [];
    selected = 0;
    loading = true;
    void loadPluginDocs(id, secs)
      .then((result) => {
        if (token !== loadToken) return;
        loaded = result;
        loading = false;
      })
      .catch(() => {
        if (token !== loadToken) return;
        loaded = [];
        loading = false;
      });
  });

  const current = $derived(loaded[selected]);
  const showNav = $derived(loaded.length > 1);
</script>

<Dialog.Root bind:open>
  <Dialog.Portal>
    <Dialog.Overlay
      class="fixed inset-0 z-[400] bg-scrim backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
    />
    <Dialog.Content
      class="fixed left-1/2 top-1/2 z-[400] grid h-[80vh] w-[min(880px,94vw)] -translate-x-1/2 -translate-y-1/2 grid-rows-[auto_1fr] overflow-hidden rounded-lg border border-border bg-background text-foreground shadow-xl focus:outline-none"
    >
      <header
        class="flex items-center justify-between gap-3 border-b border-border bg-card px-4 py-3"
      >
        <Dialog.Title class="truncate text-base font-semibold">
          {title}
        </Dialog.Title>
        <Dialog.Close
          class="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={tUi('close')}
        >
          <X class="size-4" />
        </Dialog.Close>
      </header>

      <div
        class="grid min-h-0 {showNav
          ? 'grid-cols-[200px_1fr] divide-x divide-border'
          : 'grid-cols-1'}"
      >
        {#if showNav}
          <nav class="themed-scrollbar overflow-y-auto bg-card/40 py-2">
            <ul class="flex flex-col">
              {#each loaded as section, i (section.file)}
                <li>
                  <button
                    type="button"
                    onclick={() => (selected = i)}
                    class="flex w-full items-center border-l-2 px-3 py-2 text-left text-sm transition-colors {i ===
                    selected
                      ? 'border-primary bg-accent text-accent-foreground'
                      : 'border-transparent text-foreground hover:bg-accent/60'}"
                  >
                    <span class="truncate">{section.title}</span>
                  </button>
                </li>
              {/each}
            </ul>
          </nav>
        {/if}

        <section class="themed-scrollbar min-h-0 overflow-y-auto px-6 py-4">
          {#if loading}
            <p class="py-8 text-center text-sm text-muted-foreground">
              {tUi('plugins.docs.loading')}
            </p>
          {:else if current}
            <div class="docs-md">
              {#key current.file}
                <ReadonlyNoteView markdown={current.markdown} />
              {/key}
            </div>
          {:else}
            <p class="py-8 text-center text-sm text-muted-foreground">
              {tUi('plugins.docs.empty')}
            </p>
          {/if}
        </section>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  /* The reused read-only view scrolls internally with an unthemed bar; let this
     dialog's themed-scrollbar container own the scrolling instead. */
  .docs-md :global(.milkdown-readonly) {
    height: auto;
    overflow: visible;
  }
</style>

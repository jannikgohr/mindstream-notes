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
   *
   * On phones it fills the screen like mobile settings: several sections open
   * on their list, each section is a page of its own with a back arrow, and
   * system back steps out a level at a time.
   */
  import { Dialog } from 'bits-ui';
  import { ArrowLeft, ChevronRight, X } from '@lucide/svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import ReadonlyNoteView from '$lib/components/history/ReadonlyNoteView.svelte';
  import { isMobile } from '$lib/platform';
  import { closeNavOverlay, openNavOverlay } from '$lib/mobile/state.svelte';
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

  const mobile = isMobile();
  // Phones only: with several sections, whether one is open or the list is.
  let reading = $state(false);
  $effect(() => {
    if (!open) reading = false;
  });
  const onList = $derived(mobile && showNav && !reading);

  // One nav level for the dialog and one for an open section, as in
  // MobileSettingsDialog, so system back closes them in order.
  const DOCS_NAV_ID = 'plugin-docs';
  const SECTION_NAV_ID = 'plugin-docs-section';
  let docsNavHeld = false;
  let sectionNavHeld = false;
  $effect(() => {
    if (!mobile) return;
    if (open && !docsNavHeld) {
      docsNavHeld = true;
      openNavOverlay(DOCS_NAV_ID, () => (open = false));
    } else if (!open && docsNavHeld) {
      docsNavHeld = false;
      closeNavOverlay(DOCS_NAV_ID);
    }
  });
  $effect(() => {
    const inSection = mobile && open && reading;
    if (inSection && !sectionNavHeld) {
      sectionNavHeld = true;
      openNavOverlay(SECTION_NAV_ID, () => (reading = false));
    } else if (!inSection && sectionNavHeld) {
      sectionNavHeld = false;
      closeNavOverlay(SECTION_NAV_ID);
    }
  });

  function openSection(i: number) {
    selected = i;
    reading = true;
  }

  const closeButton =
    'flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
</script>

<Dialog.Root bind:open>
  <Dialog.Portal>
    <Dialog.Overlay
      class="fixed inset-0 z-[400] bg-scrim backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
    />
    {#if mobile}
      <Dialog.Content
        class="safe-top safe-bottom safe-x fixed inset-0 z-[400] flex flex-col bg-background text-foreground focus:outline-none"
      >
        <header
          class="grid h-14 shrink-0 grid-cols-[2.75rem_1fr_2.75rem] items-center border-b border-border bg-card px-1.5"
        >
          {#if showNav && reading}
            <button
              type="button"
              class={closeButton}
              onclick={() => (reading = false)}
              aria-label={tUi('back')}
              title={tUi('back')}
            >
              <ArrowLeft class="size-5" />
            </button>
          {:else}
            <span aria-hidden="true"></span>
          {/if}
          <Dialog.Title class="truncate text-center text-base font-semibold">
            {title}
          </Dialog.Title>
          <Dialog.Close class={closeButton} aria-label={tUi('close')}>
            <X class="size-5" />
          </Dialog.Close>
        </header>

        {#if loading}
          <p class="py-8 text-center text-sm text-muted-foreground">
            {tUi('plugins.docs.loading')}
          </p>
        {:else if onList}
          <nav class="flex-1 overflow-y-auto" aria-label={title}>
            {#each loaded as section, i (section.file)}
              <button
                type="button"
                class="flex min-h-13 w-full items-center gap-3 border-b border-border px-4 py-3 text-left text-sm transition-colors hover:bg-accent"
                onclick={() => openSection(i)}
              >
                <span class="min-w-0 flex-1 truncate font-medium">
                  {section.title}
                </span>
                <ChevronRight class="size-4 shrink-0 text-muted-foreground" />
              </button>
            {/each}
          </nav>
        {:else if current}
          <!-- The mobile editor's gutters and heading scale; no toolbar sits
               under this page, whatever an open note below has set. -->
          <section
            class="docs-md mobile-editor flex-1 overflow-y-auto pb-6"
            style:--mobile-toolbar-height="0px"
          >
            {#key current.file}
              <ReadonlyNoteView markdown={current.markdown} />
            {/key}
          </section>
        {:else}
          <p class="py-8 text-center text-sm text-muted-foreground">
            {tUi('plugins.docs.empty')}
          </p>
        {/if}
      </Dialog.Content>
    {:else}
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
    {/if}
  </Dialog.Portal>
</Dialog.Root>

<style>
  /* The reused read-only view scrolls internally with an unthemed bar; let this
     dialog's themed-scrollbar container own the scrolling instead. */
  .docs-md :global(.milkdown-readonly) {
    height: auto;
    overflow: visible;
  }
  /* On a phone the section's own heading opens the page, right under the
     header, the way a note's title opens the mobile editor. */
  .docs-md.mobile-editor :global(.milkdown) {
    padding-top: 0;
  }
  .docs-md.mobile-editor :global(.milkdown .ProseMirror) {
    padding-top: 1.25rem;
  }
  /* Crepe puts a widget node before the first block. */
  .docs-md.mobile-editor
    :global(.milkdown .ProseMirror > :first-child:not(.ProseMirror-widget)),
  .docs-md.mobile-editor
    :global(.milkdown .ProseMirror > .ProseMirror-widget:first-child + *) {
    margin-top: 0;
  }
</style>

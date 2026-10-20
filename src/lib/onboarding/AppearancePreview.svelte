<script lang="ts">
  import {
    Bold,
    Italic,
    FileText,
    Folder,
    Search,
    Plus,
    Check,
    ChevronRight
  } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Surface } from '$lib/components/ui/surface';
  import { SectionHeader } from '$lib/components/ui/section-header';
  import {
    Toolbar,
    ToolbarButton,
    ToolbarSeparator
  } from '$lib/components/ui/toolbar';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { getSettingValue } from '$lib/settings/store.svelte';

  let { uiFontSize = null }: { uiFontSize?: number | null } = $props();
  const appliedUiFontSize = $derived(
    Number(getSettingValue('appearance.uiFontSize'))
  );
  // Shared controls use rem units. Zoom only this sample while the root stays
  // fixed, then return to normal once the released value applies globally.
  const uiScale = $derived(
    (uiFontSize ?? appliedUiFontSize) / appliedUiFontSize
  );

  let bold = $state(false);
  let italic = $state(false);
  let checked = $state(true);
  let query = $state('');
  let selected = $state(0);
  const notes = $derived([
    tUi('onboarding.preview.note'),
    tUi('onboarding.preview.ideas')
  ]);
</script>

<section
  class="preview"
  aria-label={tUi('onboarding.preview.label')}
  data-testid="appearance-preview"
  style:zoom={uiScale}
  style:--preview-ui-scale={uiScale}
>
  <div class="preview-title">
    <span class="size-2 rounded-full bg-accent-brand"></span> Mindstream
    <span class="ml-auto text-xs text-muted-foreground"
      >{tUi('onboarding.preview.live')}</span
    >
  </div>
  <div class="preview-panes">
    <Surface as="aside" variant="panel" class="preview-sidebar">
      <SectionHeader>{tUi('onboarding.preview.vault')}</SectionHeader>
      <div class="relative my-4">
        <Search
          class="absolute top-2.5 left-2 size-4 text-muted-foreground"
        /><Input
          class="pl-8"
          aria-label={tUi('onboarding.preview.search')}
          placeholder={tUi('onboarding.preview.search')}
          bind:value={query}
        />
      </div>
      <div class="mb-2 flex items-center gap-2 text-sm">
        <ChevronRight class="size-3" /><Folder
          class="size-4 text-muted-foreground"
        />{tUi('onboarding.preview.folder')}
      </div>
      {#each notes as note, index (index)}
        {#if note.toLocaleLowerCase().includes(query.toLocaleLowerCase())}
          <Button
            variant={selected === index ? 'secondary' : 'ghost'}
            class="mb-1 w-full justify-start gap-2"
            onclick={() => (selected = index)}
            ><FileText class="size-4 shrink-0" /><span class="truncate"
              >{note}</span
            ></Button
          >
        {/if}
      {/each}
      <Button
        variant="outline"
        size="sm"
        class="mt-4 w-full gap-2"
        onclick={() => {
          selected = 1;
          query = '';
        }}><Plus class="size-4" />{tUi('onboarding.preview.newNote')}</Button
      >
    </Surface>
    <Surface variant="panel" class="min-w-0 bg-editor-surface">
      <div class="border-b border-border px-4 py-2 text-sm">
        {notes[selected]}
      </div>
      <Toolbar
        class="border-b border-border"
        aria-label={tUi('onboarding.preview.toolbar')}
      >
        <ToolbarButton
          active={bold}
          aria-pressed={bold}
          aria-label={tUi('onboarding.preview.bold')}
          onclick={() => (bold = !bold)}><Bold /></ToolbarButton
        >
        <ToolbarButton
          active={italic}
          aria-pressed={italic}
          aria-label={tUi('onboarding.preview.italic')}
          onclick={() => (italic = !italic)}><Italic /></ToolbarButton
        >
        <ToolbarSeparator />
        <span class="px-2 text-xs text-muted-foreground"
          >{tUi('onboarding.preview.formatting')}</span
        >
      </Toolbar>
      <article class="preview-document" data-testid="preview-document">
        <span
          class="mb-4 inline-block rounded-md bg-accent px-2 py-1 text-xs text-accent-foreground"
          >{tUi('onboarding.preview.tag')}</span
        >
        <h3>{notes[selected]}</h3>
        <p class:font-bold={bold} class:italic>
          {tUi(
            selected === 0
              ? 'onboarding.preview.body'
              : 'onboarding.preview.ideaBody'
          )}
        </p>
        <label class="my-5 flex items-center gap-2"
          ><input
            type="checkbox"
            bind:checked
            class="accent-[var(--color-accent-brand)]"
          />{tUi('onboarding.preview.task')}</label
        >
        <Surface variant="section" padding="md"
          ><div class="flex items-start gap-2">
            <Check class="mt-0.5 size-4 shrink-0 text-accent-brand" /><span
              >{tUi('onboarding.preview.saved')}</span
            >
          </div></Surface
        >
      </article>
    </Surface>
  </div>
</section>

<style>
  .preview {
    overflow: hidden;
    border: 1px solid var(--color-border-strong);
    border-radius: 0.75rem;
    background: var(--color-surface-0);
    box-shadow: var(--shadow-raised);
  }
  .preview-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--color-border);
    font-size: 0.875rem;
  }
  .preview-panes {
    display: grid;
    grid-template-columns: minmax(9rem, 0.7fr) minmax(0, 1.7fr);
    min-height: 24rem;
  }
  :global(.preview-sidebar) {
    padding: 1rem;
    border-right: 1px solid var(--color-border);
  }
  .preview-document {
    padding: 1.75rem;
    /* Editor text is sized independently of UI zoom in the real workspace. */
    font-size: calc(var(--editor-font-size) / var(--preview-ui-scale));
    line-height: var(--editor-line-height, 1.6);
  }
  .preview-document h3 {
    margin-bottom: 1rem;
    font-size: 1.6em;
    font-weight: 600;
    line-height: 1.25;
  }
  @media (max-width: 520px) {
    .preview-panes {
      grid-template-columns: 1fr;
    }
    :global(.preview-sidebar) {
      display: none;
    }
    .preview-document {
      padding: 1.25rem;
    }
  }
</style>

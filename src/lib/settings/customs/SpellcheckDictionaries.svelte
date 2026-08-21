<script lang="ts">
  /**
   * Install and remove spellcheck dictionaries.
   *
   * Rendered as a single `type: 'custom'` row (schema.json → category
   * `editor`, section `editor.spellcheck`). Dictionaries are downloaded on
   * request rather than shipped in the installer: the German dictionary
   * alone is 4.3MB, and their licences are a patchwork — `de_DE_frami` is
   * GPLv2/GPLv3 only, others are MPL, BSD or CC-BY. Bundling them would mean
   * distributing that with the app; fetching them at the user's request,
   * with the licence shown first, does not.
   *
   * Hence the licence column is not decoration. Where the dictionary's own
   * header states no licence we say so and link to the source rather than
   * inventing one.
   *
   * The row also reconciles the two halves of the feature: which languages
   * are SELECTED (a per-vault preference, so it syncs) versus which
   * dictionaries are INSTALLED (files on this device). Selecting a language
   * whose dictionary is missing does nothing, so that combination is called
   * out explicitly instead of failing silently.
   */
  import {
    Check,
    Download,
    ExternalLink,
    Loader2,
    Trash2
  } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import {
    spellcheckAvailableDictionaries,
    spellcheckInstallDictionary,
    spellcheckRemoveDictionary,
    type AvailableDictionary
  } from '$lib/api/spellcheck';
  import { getSettingValue } from '$lib/settings/store.svelte';
  import { reloadSpellcheckConfig } from '$lib/diagnostics/editor-diagnostics.svelte';
  import { tUi, tValue } from '$lib/settings/i18n.svelte';
  import { spellingOwner } from '$lib/diagnostics/editor-diagnostics.svelte';

  interface Props {
    searchQuery?: string;
  }

  let { searchQuery = '' }: Props = $props();

  let dictionaries = $state<AvailableDictionary[]>([]);
  let busy = $state<string | null>(null);
  let failed = $state<string | null>(null);

  const selected = $derived.by(() => {
    const value = getSettingValue('editor.spellcheck.languages');
    return Array.isArray(value) ? (value as string[]) : [];
  });

  const visible = $derived.by(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return dictionaries;
    return dictionaries.filter(
      (entry) =>
        entry.id.toLowerCase().includes(query) ||
        entry.bcp47.toLowerCase().includes(query) ||
        label(entry).toLowerCase().includes(query)
    );
  });

  function label(entry: AvailableDictionary): string {
    return tValue('editor.spellcheck.languages', entry.id);
  }

  async function refresh() {
    dictionaries = await spellcheckAvailableDictionaries();
  }

  $effect(() => {
    void refresh();
  });

  async function install(entry: AvailableDictionary) {
    busy = entry.id;
    failed = null;
    try {
      await spellcheckInstallDictionary(entry.id);
      // Awaited: the new dictionary's word characters have to be loaded
      // before the re-check runs, or it tokenizes with the old ones.
      await reloadSpellcheckConfig();
      await refresh();
    } catch (err) {
      console.error('[spellcheck] install failed', err);
      failed = entry.id;
    } finally {
      busy = null;
    }
  }

  async function remove(entry: AvailableDictionary) {
    busy = entry.id;
    failed = null;
    try {
      await spellcheckRemoveDictionary(entry.id);
      await reloadSpellcheckConfig();
      await refresh();
    } finally {
      busy = null;
    }
  }
</script>

<!--
  A plugin can take spelling over entirely, which leaves this panel looking
  unchanged while something else does the work — exactly the situation where
  "my spellchecking stopped" is hard to answer. Say who has it.
-->
{#if spellingOwner()}
  <p
    class="mt-2 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground"
  >
    {tUi('editor.spellcheck.ownedByPlugin').replace(
      '{plugin}',
      spellingOwner()?.label ?? ''
    )}
  </p>
{/if}

<div class="mt-2 flex flex-col gap-1">
  {#each visible as entry (entry.id)}
    {@const isSelected = selected.includes(entry.id)}
    <div
      class="flex items-center gap-3 rounded-md border border-border px-3 py-2"
    >
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <span class="truncate text-sm">{label(entry)}</span>
          <span class="shrink-0 text-xs text-muted-foreground"
            >{entry.bcp47}</span
          >
          {#if entry.installed}
            <Check class="size-3 shrink-0 text-muted-foreground" />
          {/if}
        </div>
        <div
          class="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground"
        >
          <span class="truncate">
            {entry.license ||
              tUi('editor.spellcheck.dictionaries.licenseUnstated')}
          </span>
          <a
            href={entry.sourceUrl}
            target="_blank"
            rel="noreferrer noopener"
            class="inline-flex shrink-0 items-center gap-0.5 underline"
          >
            {tUi('editor.spellcheck.dictionaries.source')}
            <ExternalLink class="size-3" />
          </a>
        </div>
        {#if failed === entry.id}
          <p class="mt-0.5 text-xs text-destructive">
            {tUi('editor.spellcheck.dictionaries.failed')}
          </p>
        {:else if isSelected && !entry.installed}
          <!-- The one combination that silently does nothing, so it is said
               out loud rather than left for the user to work out. -->
          <p class="mt-0.5 text-xs text-destructive">
            {tUi('editor.spellcheck.dictionaries.enabledNotInstalled')}
          </p>
        {/if}
      </div>

      {#if busy === entry.id}
        <Loader2 class="size-4 animate-spin text-muted-foreground" />
      {:else if entry.installed}
        <Button
          variant="ghost"
          size="sm"
          onclick={() => remove(entry)}
          aria-label="{tUi('editor.spellcheck.dictionaries.remove')} {label(
            entry
          )}"
        >
          <Trash2 class="size-4" />
        </Button>
      {:else}
        <Button variant="outline" size="sm" onclick={() => install(entry)}>
          <Download class="mr-1 size-3" />
          {tUi('editor.spellcheck.dictionaries.install')}
        </Button>
      {/if}
    </div>
  {/each}
</div>

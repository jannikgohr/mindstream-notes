<script lang="ts">
  /**
   * Install and remove spellcheck dictionaries.
   *
   * Rendered as a single `type: 'custom'` row (schema.json → category
   * `language`, section `language.spellcheck`). Dictionaries are downloaded
   * on request rather than shipped in the installer: the German dictionary
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
   *
   * The catalogue is fifteen entries and growing, which is a wall of rows for
   * a user who only wants the two they already have. So it renders in three
   * groups, in the order they demand attention:
   *
   *   1. selected but not installed — the silent-failure case, always shown;
   *   2. installed — what this device actually checks against;
   *   3. everything else, behind a disclosure, since that list is a catalogue
   *      to browse rather than state to read.
   *
   * A settings search is a request to see the whole catalogue, so it opens the
   * disclosure for as long as the query lasts — otherwise searching for a
   * language you have not installed would silently find nothing.
   */
  import {
    Check,
    ChevronRight,
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
  let browsing = $state(false);

  const selected = $derived.by(() => {
    const value = getSettingValue('language.spellcheck.languages');
    return Array.isArray(value) ? (value as string[]) : [];
  });

  const query = $derived(searchQuery.trim().toLowerCase());

  const visible = $derived.by(() => {
    if (!query) return dictionaries;
    return dictionaries.filter(
      (entry) =>
        entry.id.toLowerCase().includes(query) ||
        entry.bcp47.toLowerCase().includes(query) ||
        label(entry).toLowerCase().includes(query)
    );
  });

  /**
   * Selected languages whose dictionary is missing. Spellcheck silently does
   * nothing for these, so they lead the list whatever the disclosure says.
   */
  const missing = $derived(
    visible.filter((entry) => !entry.installed && selected.includes(entry.id))
  );
  const installed = $derived(visible.filter((entry) => entry.installed));
  const available = $derived(
    visible.filter((entry) => !entry.installed && !selected.includes(entry.id))
  );

  const expanded = $derived(browsing || query.length > 0);

  function label(entry: AvailableDictionary): string {
    return tValue('language.spellcheck.languages', entry.id);
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
  One root element on purpose. A template with several roots — this one had
  two before the grouping went in — renders correctly in the browser but
  trips Svelte's fragment walk under happy-dom, which is what the unit tests
  run on, so the panel could not be covered at all.
-->
<div class="mt-2 flex flex-col gap-1">
  <!--
    A plugin can take spelling over entirely, which leaves this panel looking
    unchanged while something else does the work — exactly the situation where
    "my spellchecking stopped" is hard to answer. Say who has it.
  -->
  {#if spellingOwner()}
    <p
      class="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground"
    >
      {tUi('language.spellcheck.ownedByPlugin').replace(
        '{plugin}',
        spellingOwner()?.label ?? ''
      )}
    </p>
  {/if}

  {#each missing as entry (entry.id)}
    {@render row(entry, true)}
  {/each}

  {#each installed as entry (entry.id)}
    {@render row(entry, false)}
  {/each}

  {#if missing.length === 0 && installed.length === 0}
    <p class="px-3 py-2 text-xs text-muted-foreground">
      {tUi('language.spellcheck.dictionaries.noneInstalled')}
    </p>
  {/if}

  {#if available.length > 0}
    <button
      type="button"
      aria-expanded={expanded}
      onclick={() => (browsing = !expanded)}
      class="mt-1 flex items-center gap-1 self-start rounded-md px-1 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      <ChevronRight
        class="size-3.5 transition-transform {expanded ? 'rotate-90' : ''}"
      />
      {tUi('language.spellcheck.dictionaries.browse')} ({available.length})
    </button>

    {#if expanded}
      {#each available as entry (entry.id)}
        {@render row(entry, true)}
      {/each}
    {/if}
  {/if}

  <!--
    `detailed` carries the licence and the source link. They are what the user
    needs BEFORE downloading, so they ride along with every row that still
    offers a download; an installed row is state rather than a decision and
    stays one line.
  -->
  {#snippet row(entry: AvailableDictionary, detailed: boolean)}
    {@const isSelected = selected.includes(entry.id)}
    {@const unmet = isSelected && !entry.installed}
    <div
      class="flex items-center gap-3 rounded-md border px-3 py-2 {unmet
        ? 'border-destructive/50'
        : 'border-border'}"
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
        {#if detailed}
          <div
            class="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground"
          >
            <span class="truncate">
              {entry.license ||
                tUi('language.spellcheck.dictionaries.licenseUnstated')}
            </span>
            <a
              href={entry.sourceUrl}
              target="_blank"
              rel="noreferrer noopener"
              class="inline-flex shrink-0 items-center gap-0.5 underline"
            >
              {tUi('language.spellcheck.dictionaries.source')}
              <ExternalLink class="size-3" />
            </a>
          </div>
        {/if}
        {#if failed === entry.id}
          <p class="mt-0.5 text-xs text-destructive">
            {tUi('language.spellcheck.dictionaries.failed')}
          </p>
        {:else if unmet}
          <!-- The one combination that silently does nothing, so it is said
               out loud rather than left for the user to work out. -->
          <p class="mt-0.5 text-xs text-destructive">
            {tUi('language.spellcheck.dictionaries.enabledNotInstalled')}
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
          aria-label="{tUi('language.spellcheck.dictionaries.remove')} {label(
            entry
          )}"
        >
          <Trash2 class="size-4" />
        </Button>
      {:else}
        <Button variant="outline" size="sm" onclick={() => install(entry)}>
          <Download class="mr-1 size-3" />
          {tUi('language.spellcheck.dictionaries.install')}
        </Button>
      {/if}
    </div>
  {/snippet}
</div>

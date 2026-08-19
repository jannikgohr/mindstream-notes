<script lang="ts">
  /**
   * The personal dictionary, listed so words can be taken back out.
   *
   * Adding happens in the editor (right-click a flagged word), which is
   * where the user actually is when they decide a word is fine. This panel
   * exists for the other half: without it an accidental "Add to dictionary"
   * would be permanent and invisible, since a word in the personal
   * dictionary is by definition one that no longer gets flagged.
   */
  import { Trash2 } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import {
    customDictionary,
    loadCustomDictionary,
    removeCustomWord
  } from '$lib/diagnostics/custom-dictionary.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';

  interface Props {
    searchQuery?: string;
  }

  let { searchQuery = '' }: Props = $props();

  $effect(() => {
    void loadCustomDictionary();
  });

  const visible = $derived.by(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return customDictionary.words;
    return customDictionary.words.filter((word) =>
      word.toLowerCase().includes(query)
    );
  });
</script>

<div class="mt-2">
  {#if customDictionary.words.length === 0}
    <p class="text-xs text-muted-foreground">
      {tUi('editor.spellcheck.customWords.empty')}
    </p>
  {:else}
    <div class="flex flex-wrap gap-1.5">
      {#each visible as word (word)}
        <span
          class="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs"
        >
          {word}
          <Button
            variant="ghost"
            size="sm"
            class="size-4 p-0"
            onclick={() => removeCustomWord(word)}
            aria-label="{tUi('editor.spellcheck.customWords.remove')} {word}"
          >
            <Trash2 class="size-3" />
          </Button>
        </span>
      {/each}
    </div>
  {/if}
</div>

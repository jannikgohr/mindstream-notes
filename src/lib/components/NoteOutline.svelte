<script lang="ts">
  import { ChevronDown } from '@lucide/svelte';
  import {
    noteOutline,
    scrollToNoteHeading
  } from '$lib/stores/note-outline.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';

  let { noteId }: { noteId: string } = $props();
  const headings = $derived(noteOutline.byNote[noteId] ?? []);
  const firstLevel = $derived(Math.min(...headings.map((h) => h.level)));
</script>

{#if headings.length > 0}
  <details open class="group/outline mt-5 border-t border-border pt-5">
    <summary
      class="flex cursor-pointer list-none items-center gap-2 text-xs font-semibold [&::-webkit-details-marker]:hidden"
    >
      {tUi('sidebar.outline')}
      <span class="ml-auto text-[10px] font-normal text-muted-foreground">
        {headings.length}
      </span>
      <ChevronDown
        class="size-3 -rotate-90 text-muted-foreground transition-transform group-open/outline:rotate-0"
      />
    </summary>
    <nav
      aria-label={tUi('sidebar.outline')}
      class="mt-3 border-l border-border"
    >
      {#each headings as heading, index (index)}
        <button
          type="button"
          class="block w-full truncate py-1.5 pr-1 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          style:padding-left={`${12 + Math.min(heading.level - firstLevel, 3) * 10}px`}
          title={heading.title}
          aria-label={tUi('sidebar.outline.goTo').replace(
            '{heading}',
            heading.title
          )}
          onclick={() => scrollToNoteHeading(noteId, index)}
        >
          {heading.title}
        </button>
      {/each}
    </nav>
  </details>
{/if}

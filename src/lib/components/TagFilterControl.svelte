<script lang="ts">
  import { onMount } from 'svelte';
  import { Popover } from 'bits-ui';
  import { Check, Tag } from '@lucide/svelte';
  import { tooltip } from '$lib/actions/tooltip';
  import { tUi } from '$lib/settings/i18n.svelte';
  import {
    clearTagFilter,
    showTagFilterControl,
    tagFilter,
    tagFilterOptions,
    toggleTagFilter
  } from '$lib/stores/tag-filter.svelte';
  import { tagsInUse } from '$lib/stores/tree.svelte';

  /** `touch`: finger-sized targets, and no search focus raising the keyboard. */
  let { touch = false }: { touch?: boolean } = $props();

  onMount(showTagFilterControl);

  let open = $state(false);
  let query = $state('');

  // Selected tags stay listed after their last note loses them, so they can
  // still be unchecked.
  const options = $derived(
    tagFilterOptions([...tagsInUse(), ...tagFilter.tags])
  );
  const needle = $derived(query.trim().toLowerCase());
  const visible = $derived(
    needle
      ? options.filter((o) => o.path.toLowerCase().includes(needle))
      : options
  );
  const count = $derived(tagFilter.tags.length);
  const label = $derived(
    count > 0
      ? tUi(
          count === 1 ? 'tagFilter.active.one' : 'tagFilter.active.other'
        ).replace('{count}', String(count))
      : tUi('tagFilter.label')
  );
</script>

<Popover.Root
  bind:open
  onOpenChange={(next) => {
    if (!next) query = '';
  }}
>
  <Popover.Trigger>
    {#snippet child({ props })}
      <button
        {...props}
        type="button"
        class="relative inline-flex shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring {touch
          ? 'size-11'
          : 'size-7'} {count > 0
          ? 'bg-accent-brand/10 text-accent-brand'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground'}"
        use:tooltip={label}
        aria-label={label}
      >
        <Tag class={touch ? 'size-4' : 'size-3.5'} />
        {#if count > 0}
          <span
            class="absolute -right-0.5 -top-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-accent-brand px-0.5 text-[9px] font-semibold leading-none text-accent-brand-foreground"
            aria-hidden="true">{count}</span
          >
        {/if}
      </button>
    {/snippet}
  </Popover.Trigger>
  <Popover.Portal>
    <Popover.Content
      side="bottom"
      align="end"
      sideOffset={4}
      aria-label={tUi('tagFilter.label')}
      onOpenAutoFocus={(e) => {
        if (touch) e.preventDefault();
      }}
      class="z-[400] flex w-64 flex-col {touch
        ? 'touch-targets'
        : ''} rounded-lg border border-border bg-popover text-xs text-popover-foreground shadow-overlay focus:outline-none"
    >
      <div class="border-b border-border p-2">
        <input
          bind:value={query}
          type="text"
          placeholder={tUi('tagFilter.search')}
          aria-label={tUi('tagFilter.search')}
          class="h-7 w-full rounded-sm border border-input bg-background px-2 text-xs shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </div>
      <div class="max-h-[min(20rem,60vh)] overflow-y-auto py-1">
        {#each visible as option (option.path)}
          {@const checked = tagFilter.tags.includes(option.path)}
          <button
            type="button"
            aria-pressed={checked}
            class="flex min-h-7 w-full items-center px-2 text-left transition-colors hover:bg-accent hover:text-accent-foreground"
            onclick={() => toggleTagFilter(option.path)}
          >
            {#if !needle}
              <!-- One guide per level, under the parent's checkbox. -->
              {#each { length: option.depth }, level (level)}
                <span
                  class="ml-1.5 w-2.5 shrink-0 self-stretch border-l border-border"
                  aria-hidden="true"
                ></span>
              {/each}
            {/if}
            <span
              class="mr-2 grid size-3.5 shrink-0 place-items-center rounded-sm border {checked
                ? 'border-accent-brand bg-accent-brand text-accent-brand-foreground'
                : 'border-border'}"
            >
              {#if checked}<Check class="size-3" />{/if}
            </span>
            <span class="min-w-0 truncate font-mono"
              >{needle ? option.path : option.segment}</span
            >
          </button>
        {:else}
          <p class="px-3 py-2 text-muted-foreground">
            {options.length === 0
              ? tUi('tagFilter.empty')
              : tUi('tags.noMatches')}
          </p>
        {/each}
      </div>
      {#if count > 0}
        <div class="border-t border-border p-1">
          <button
            type="button"
            class="flex h-7 w-full items-center rounded-md px-2 text-left text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onclick={clearTagFilter}
          >
            {tUi('tagFilter.clear')}
          </button>
        </div>
      {/if}
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>

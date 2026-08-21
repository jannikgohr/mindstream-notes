<script lang="ts">
  /** Searchable folder/tag picker used by settings rows. */
  import { Check, ChevronDown, Search, X } from '@lucide/svelte';

  interface Item {
    value: string;
    label: string;
  }
  interface Props {
    value: string;
    items: Item[];
    onChange: (next: string) => void;
    unsetLabel: string;
    searchLabel?: string;
    emptyLabel?: string;
    ariaLabel?: string;
  }
  let {
    value,
    items,
    onChange,
    unsetLabel,
    searchLabel = 'Search…',
    emptyLabel = 'No matches',
    ariaLabel
  }: Props = $props();

  let root = $state<HTMLDivElement | null>(null);
  let input = $state<HTMLInputElement | null>(null);
  let open = $state(false);
  let query = $state('');
  let highlighted = $state(0);

  const allItems = $derived<Item[]>([
    { value: '', label: unsetLabel },
    ...items
  ]);
  const currentLabel = $derived(
    allItems.find((i) => i.value === value)?.label ?? unsetLabel
  );
  const filteredItems = $derived.by(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return allItems;
    return allItems.filter((item) =>
      item.label.toLocaleLowerCase().includes(normalized)
    );
  });

  $effect(() => {
    if (highlighted >= filteredItems.length) {
      highlighted = Math.max(0, filteredItems.length - 1);
    }
  });

  $effect(() => {
    if (!open) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!root?.contains(event.target as Node)) close();
    };
    window.addEventListener('pointerdown', closeOnOutsidePress, true);
    return () =>
      window.removeEventListener('pointerdown', closeOnOutsidePress, true);
  });

  function show(): void {
    open = true;
    query = '';
    highlighted = Math.max(
      0,
      allItems.findIndex((item) => item.value === value)
    );
    queueMicrotask(() => input?.focus());
  }

  function close(): void {
    open = false;
    query = '';
  }

  function select(item: Item): void {
    onChange(item.value);
    close();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown') {
      highlighted = Math.min(
        highlighted + 1,
        Math.max(0, filteredItems.length - 1)
      );
      event.preventDefault();
    } else if (event.key === 'ArrowUp') {
      highlighted = Math.max(0, highlighted - 1);
      event.preventDefault();
    } else if (event.key === 'Enter') {
      const item = filteredItems[highlighted];
      if (item) select(item);
      event.preventDefault();
    } else if (event.key === 'Escape') {
      close();
      event.preventDefault();
    }
  }
</script>

<div class="relative" bind:this={root}>
  <button
    type="button"
    aria-label={ariaLabel}
    aria-haspopup="listbox"
    aria-expanded={open}
    class="inline-flex h-8 w-56 items-center justify-between gap-2 rounded-md border border-input bg-background px-2 text-sm transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    onclick={() => (open ? close() : show())}
  >
    <span class:italic={value === ''} class="truncate">{currentLabel}</span>
    <ChevronDown class="size-3.5 shrink-0 text-muted-foreground" />
  </button>

  {#if open}
    <div
      class="absolute right-0 z-[360] mt-1 w-64 overflow-hidden rounded-md border border-border bg-popover text-sm text-popover-foreground shadow-lg"
    >
      <div class="flex items-center gap-2 border-b border-border px-2">
        <Search class="size-3.5 shrink-0 text-muted-foreground" />
        <input
          bind:this={input}
          bind:value={query}
          aria-label={searchLabel}
          placeholder={searchLabel}
          class="h-9 min-w-0 flex-1 border-0 bg-transparent outline-none placeholder:text-muted-foreground"
          oninput={() => (highlighted = 0)}
          onkeydown={onKeydown}
        />
        {#if query}
          <button
            type="button"
            class="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={searchLabel}
            onclick={() => {
              query = '';
              highlighted = 0;
              input?.focus();
            }}
          >
            <X class="size-3.5" />
          </button>
        {/if}
      </div>
      <div class="max-h-[min(50vh,320px)] overflow-y-auto p-1" role="listbox">
        {#each filteredItems as item, index (item.value)}
          <button
            type="button"
            role="option"
            aria-selected={item.value === value}
            class="flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left outline-none hover:bg-accent hover:text-accent-foreground"
            class:bg-accent={index === highlighted}
            class:italic={item.value === ''}
            onmouseenter={() => (highlighted = index)}
            onclick={() => select(item)}
          >
            <span class="truncate">{item.label}</span>
            {#if item.value === value}
              <Check class="size-3.5 shrink-0 text-muted-foreground" />
            {/if}
          </button>
        {:else}
          <p class="px-2 py-3 text-center text-xs text-muted-foreground">
            {emptyLabel}
          </p>
        {/each}
      </div>
    </div>
  {/if}
</div>

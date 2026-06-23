<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { DesktopNoteSource } from '$lib/stores/note-source.svelte';

  interface Props {
    source?: DesktopNoteSource;
    onSourceChange?: (source: DesktopNoteSource) => void;
    onOpenNote: (id: string) => void;
    onOpenNoteRight?: (id: string) => void;
    onOpenNoteBelow?: (id: string) => void;
    onOpenInNewWindow?: (id: string) => void;
  }

  let {
    source = 'home',
    onSourceChange,
    onOpenNote,
    onOpenNoteRight,
    onOpenNoteBelow,
    onOpenInNewWindow
  }: Props = $props();

  let FileExplorer = $state<any | null>(null);
  let alive = true;

  onMount(() => {
    void import('$lib/components/FileExplorer.svelte').then((mod) => {
      if (alive) FileExplorer = mod.default;
    });
  });

  onDestroy(() => {
    alive = false;
    FileExplorer = null;
  });
</script>

{#if FileExplorer}
  <FileExplorer
    {source}
    {onSourceChange}
    {onOpenNote}
    {onOpenNoteRight}
    {onOpenNoteBelow}
    {onOpenInNewWindow}
  />
{/if}

<script lang="ts">
  /**
   * Segmented control for switching a single note between WYSIWYG, Source and
   * Split. Purely presentational — it reports the chosen mode through `onSelect`
   * and NoteEditor owns the state (seeded from the `editor.defaultMode` setting).
   */
  import { FileText, Code, Columns2 } from '@lucide/svelte';
  import type { Component } from 'svelte';
  import { ToolbarButton } from '$lib/components/ui/toolbar';
  import { tUi, tValue } from '$lib/settings/i18n.svelte';
  import type { EditorViewMode } from './view-mode';

  interface Props {
    value: EditorViewMode;
    onSelect: (mode: EditorViewMode) => void;
  }
  let { value, onSelect }: Props = $props();

  // Labels reuse the `editor.defaultMode` setting's value translations.
  const modes: { id: EditorViewMode; icon: Component }[] = [
    { id: 'wysiwyg', icon: FileText },
    { id: 'source', icon: Code },
    { id: 'split', icon: Columns2 }
  ];
  const label = (id: EditorViewMode) => tValue('editor.defaultMode', id);
</script>

<div
  class="flex items-center gap-0.5"
  role="group"
  aria-label={tUi('editor.mode.label')}
>
  {#each modes as mode (mode.id)}
    {@const Icon = mode.icon}
    <ToolbarButton
      holdFocus
      active={value === mode.id}
      aria-pressed={value === mode.id}
      title={label(mode.id)}
      aria-label={label(mode.id)}
      onclick={() => onSelect(mode.id)}
    >
      <Icon aria-hidden="true" />
    </ToolbarButton>
  {/each}
</div>

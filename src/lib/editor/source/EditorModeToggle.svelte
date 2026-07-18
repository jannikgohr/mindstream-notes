<script lang="ts">
  /**
   * Single button that cycles the note's editor surface
   * WYSIWYG → Source → Split → WYSIWYG. It shows the CURRENT mode's icon (like
   * the theme toggle) and advances on click. NoteEditor owns the state; the
   * same cycle is also reachable via the `editor.markdown.cycleViewMode` hotkey.
   */
  import { FileText, Code, Columns2 } from '@lucide/svelte';
  import type { Component } from 'svelte';
  import { ToolbarButton } from '$lib/components/ui/toolbar';
  import { tUi, tValue } from '$lib/settings/i18n.svelte';
  import type { EditorViewMode } from './view-mode';

  interface Props {
    value: EditorViewMode;
    /** Advance to the next view mode. */
    onCycle: () => void;
  }
  let { value, onCycle }: Props = $props();

  const icons: Record<EditorViewMode, Component> = {
    wysiwyg: FileText,
    source: Code,
    split: Columns2
  };
  const Icon = $derived(icons[value]);
  // e.g. "Editor view mode: Split" — current state; clicking advances.
  const title = $derived(
    `${tUi('editor.mode.label')}: ${tValue('editor.defaultMode', value)}`
  );
</script>

<ToolbarButton holdFocus {title} aria-label={title} onclick={onCycle}>
  <Icon aria-hidden="true" />
</ToolbarButton>

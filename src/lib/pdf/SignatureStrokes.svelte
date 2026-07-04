<script lang="ts">
  /**
   * Variable-width rendering of signature strokes: one filled outline
   * path per stroke (see strokeOutlinePath). Drop inside any `<svg>`
   * whose viewBox is the signature's pad space — the picker previews,
   * both dialogs, and the annotation layer all share this so a
   * signature looks identical everywhere.
   */
  import { strokeOutlinePath } from './stroke-utils';
  import type { PdfInkStroke } from './types';

  interface Props {
    strokes: PdfInkStroke[];
  }
  let { strokes }: Props = $props();
</script>

{#each strokes as stroke (stroke.id)}
  <path d={strokeOutlinePath(stroke)} fill={stroke.color} stroke="none" />
{/each}

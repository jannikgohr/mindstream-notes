<script lang="ts">
  /**
   * Signature artwork renderer. Photo imports prefer their transparent
   * PNG, while hand-drawn and older saved signatures fall back to the
   * variable-width stroke paths.
   */
  import { strokeOutlinePath } from './stroke-utils';
  import type { PdfInkStroke, PdfSignatureImage } from './types';

  interface Props {
    strokes: PdfInkStroke[];
    image?: PdfSignatureImage;
    width?: number;
    height?: number;
  }
  let {
    strokes,
    image,
    width = image?.width ?? 0,
    height = image?.height ?? 0
  }: Props = $props();
</script>

{#if image?.dataUrl}
  <image
    href={image.dataUrl}
    x="0"
    y="0"
    {width}
    {height}
    preserveAspectRatio="xMidYMid meet"
  />
{:else}
  {#each strokes as stroke (stroke.id)}
    <path d={strokeOutlinePath(stroke)} fill={stroke.color} stroke="none" />
  {/each}
{/if}

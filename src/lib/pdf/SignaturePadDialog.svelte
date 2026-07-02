<script lang="ts">
  /**
   * Modal signature-drawing pad. Owns its own stroke state — the parent
   * just toggles `open` and receives the finished snapshot via `onSave`.
   *
   * Reset behaviour: whenever `open` transitions to true we wipe any
   * leftover strokes so the dialog always reopens as a blank canvas.
   * This is important when the parent uses the dialog for both "first
   * signature" and "add another signature" flows — without the reset
   * the second open would show the previous strokes.
   *
   * Coordinate system: strokes are captured in the pad's local space
   * (0..PAD_WIDTH, 0..PAD_HEIGHT, Y points down) — same space the SVG
   * viewBox uses, so the rendered preview matches the stored data 1:1.
   * The PDF exporter (export-annotated-pdf.ts::mapSignatureToPlacement)
   * is what flips Y when projecting onto a page.
   */

  import { Button } from '$lib/components/ui/button';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { strokePointsAttr } from './stroke-utils';
  import {
    SIGNATURE_PAD_HEIGHT,
    SIGNATURE_PAD_WIDTH,
    SIGNATURE_STROKE_COLOR,
    SIGNATURE_STROKE_WIDTH
  } from './signature-trace';
  import type {
    PdfInkStroke,
    PdfSignatureSnapshot,
    PdfStrokePoint
  } from './types';

  interface Props {
    open: boolean;
    onCancel: () => void;
    onSave: (signature: PdfSignatureSnapshot) => void;
    /** Optional "import from photo instead" switch — the pad is the
     *  entry point when the library is empty, so it offers the photo
     *  path too. */
    onImport?: () => void;
  }
  let { open, onCancel, onSave, onImport }: Props = $props();

  // Shared with the photo-import pipeline so drawn and imported
  // signatures live in the same coordinate space.
  const PAD_WIDTH = SIGNATURE_PAD_WIDTH;
  const PAD_HEIGHT = SIGNATURE_PAD_HEIGHT;
  const STROKE_COLOR = SIGNATURE_STROKE_COLOR;
  const STROKE_WIDTH = SIGNATURE_STROKE_WIDTH;

  let strokes = $state<PdfInkStroke[]>([]);
  let draft = $state<PdfInkStroke | null>(null);

  $effect(() => {
    if (open) {
      strokes = [];
      draft = null;
    }
  });

  function padPoint(event: PointerEvent): PdfStrokePoint {
    const rect = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
    const x =
      ((event.clientX - rect.left) / Math.max(1, rect.width)) * PAD_WIDTH;
    const y =
      ((event.clientY - rect.top) / Math.max(1, rect.height)) * PAD_HEIGHT;
    return {
      x: Math.min(PAD_WIDTH, Math.max(0, x)),
      y: Math.min(PAD_HEIGHT, Math.max(0, y)),
      pressure: event.pressure || 1
    };
  }

  function pushPoint(event: PointerEvent) {
    if (!draft) return;
    const point = padPoint(event);
    const previous = draft.points[draft.points.length - 1];
    // Coalesce sub-pixel jitter so the stored stroke isn't a list of
    // thousands of near-duplicate points (a single signature stroke
    // can fire 60+ pointermove events per second).
    if (
      previous &&
      Math.hypot(point.x - previous.x, point.y - previous.y) < 1.5
    ) {
      return;
    }
    draft = { ...draft, points: [...draft.points, point] };
  }

  function beginStroke(event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    (event.currentTarget as SVGSVGElement).setPointerCapture(event.pointerId);
    draft = {
      id: crypto.randomUUID(),
      points: [padPoint(event)],
      color: STROKE_COLOR,
      width: STROKE_WIDTH
    };
  }

  function finishStroke(event: PointerEvent) {
    if (!draft) return;
    pushPoint(event);
    const finished = draft;
    draft = null;
    // Treat a single-point "stroke" as a stray tap and drop it.
    if (finished.points.length < 2) return;
    strokes = [...strokes, finished];
  }

  function clearPad() {
    draft = null;
    strokes = [];
  }

  function saveFromPad() {
    if (strokes.length === 0) return;
    onSave({
      id: crypto.randomUUID(),
      width: PAD_WIDTH,
      height: PAD_HEIGHT,
      strokes: strokes.map((stroke) => ({
        ...stroke,
        points: stroke.points.map((point) => ({ ...point }))
      }))
    });
  }
</script>

{#if open}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
    role="presentation"
  >
    <div
      class="flex w-[min(34rem,100%)] flex-col rounded-md border border-border bg-popover text-popover-foreground shadow-lg"
      role="dialog"
      aria-modal="true"
      aria-label="Create signature"
    >
      <div
        class="flex h-9 items-center justify-between border-b border-border px-3"
      >
        <div class="text-xs font-medium text-muted-foreground">Signature</div>
        <Button
          variant="ghost"
          size="sm"
          class="h-7 px-2 text-xs"
          onclick={onCancel}
        >
          Cancel
        </Button>
      </div>

      <div class="p-3">
        <svg
          role="img"
          aria-label="Signature drawing pad"
          class="aspect-[420/168] w-full touch-none rounded-md border border-input bg-white"
          viewBox="0 0 {PAD_WIDTH} {PAD_HEIGHT}"
          onpointerdown={beginStroke}
          onpointermove={pushPoint}
          onpointerup={finishStroke}
          onpointercancel={finishStroke}
        >
          {#each strokes as stroke (stroke.id)}
            <polyline
              points={strokePointsAttr(stroke.points)}
              fill="none"
              stroke={stroke.color}
              stroke-width={stroke.width}
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          {/each}
          {#if draft}
            <polyline
              points={strokePointsAttr(draft.points)}
              fill="none"
              stroke={draft.color}
              stroke-width={draft.width}
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          {/if}
        </svg>
      </div>

      <div
        class="flex h-10 items-center justify-between border-t border-border px-3"
      >
        <div class="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            class="h-7 px-2 text-xs"
            onclick={clearPad}
            disabled={strokes.length === 0 && !draft}
          >
            Clear
          </Button>
          {#if onImport}
            <Button
              variant="ghost"
              size="sm"
              class="h-7 px-2 text-xs"
              onclick={onImport}
            >
              {tUi('pdf.signature.import')}
            </Button>
          {/if}
        </div>
        <Button
          size="sm"
          class="h-7 px-2 text-xs"
          onclick={saveFromPad}
          disabled={strokes.length === 0}
        >
          Save
        </Button>
      </div>
    </div>
  </div>
{/if}

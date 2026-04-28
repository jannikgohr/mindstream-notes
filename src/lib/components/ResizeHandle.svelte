<script lang="ts">
  /**
   * Thin vertical handle that lets the user drag-resize a sibling sidebar.
   * Pointer-event based so it works for mouse, pen, and touch.
   *
   * Usage:
   *   <ResizeHandle
   *     side="left" | "right"
   *     value={width}
   *     min={200}
   *     max={500}
   *     onChange={(w) => state.leftWidth = w}
   *   />
   */
  interface Props {
    /** Which sidebar this handle belongs to — determines drag direction. */
    side: 'left' | 'right';
    /** Current width in px. */
    value: number;
    min?: number;
    max?: number;
    onChange: (next: number) => void;
  }

  let { side, value, min = 160, max = 600, onChange }: Props = $props();

  let dragging = $state(false);
  let startX = 0;
  let startValue = 0;

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    dragging = true;
    startX = e.clientX;
    startValue = value;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging) return;
    const delta = e.clientX - startX;
    // Drag handles on the right of left-sidebar grow it as the cursor moves
    // right; handles on the left of right-sidebar grow it as the cursor moves
    // left, so we invert the delta there.
    const next = side === 'left' ? startValue + delta : startValue - delta;
    const clamped = Math.min(Math.max(next, min), max);
    onChange(clamped);
  }

  function endDrag(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Pointer may already be released.
    }
  }
</script>

<div
  role="separator"
  aria-orientation="vertical"
  aria-label={side === 'left' ? 'Resize left sidebar' : 'Resize right sidebar'}
  class="group relative w-1 shrink-0 cursor-ew-resize select-none bg-border/40 transition-colors hover:bg-ring data-[dragging=true]:bg-ring"
  data-dragging={dragging}
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={endDrag}
  onpointercancel={endDrag}
>
  <!-- Wider invisible hit-target so the 1px handle is easy to grab. -->
  <span
    aria-hidden="true"
    class="absolute inset-y-0 -left-1 -right-1"
  ></span>
</div>

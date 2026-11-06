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
   *     onCommit={(w) => save(w)}
   *   />
   *
   * onChange follows the pointer; onCommit fires once on release, so a drag
   * persists one value instead of one per pointer move.
   */
  interface Props {
    /** Which sidebar this handle belongs to — determines drag direction. */
    side: 'left' | 'right';
    /** Current width in px. */
    value: number;
    min?: number;
    max?: number;
    onChange: (next: number) => void;
    /** Final width after a drag that moved the handle. */
    onCommit?: (next: number) => void;
  }

  let {
    side,
    value,
    min = 160,
    max = 600,
    onChange,
    onCommit
  }: Props = $props();

  let dragging = $state(false);
  let startX = 0;
  let startValue = 0;
  let latest = 0;

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    dragging = true;
    startX = e.clientX;
    startValue = value;
    latest = value;
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
    if (clamped === latest) return;
    latest = clamped;
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
    if (latest !== startValue) onCommit?.(latest);
  }
</script>

<div
  role="separator"
  aria-orientation="vertical"
  aria-label={side === 'left' ? 'Resize left sidebar' : 'Resize right sidebar'}
  class="group relative z-10 w-0 shrink-0 cursor-ew-resize select-none"
  data-dragging={dragging}
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={endDrag}
  onpointercancel={endDrag}
>
  <!-- Takes no width at rest, so the panel's own border is the only rule
       between panes. A wider invisible hit-target keeps it easy to grab, and
       the accent line appears on hover and while dragging. -->
  <span aria-hidden="true" class="absolute inset-y-0 -left-1 -right-1"></span>
  <span
    aria-hidden="true"
    class="pointer-events-none absolute inset-y-0 -left-px w-0.5 transition-colors group-hover:bg-ring group-data-[dragging=true]:bg-ring"
  ></span>
</div>

<script lang="ts">
  /**
   * Svelte port of pqoqubbw/icons' `party-popper`. The upstream
   * component uses `motion/react`, which would mean dragging a React
   * island in just for one icon — instead we replicate the three
   * variants (POPPER body translate, DOTS scale + fade-in, LINES
   * path-draw + scale) as CSS keyframes triggered by the `animate`
   * prop.
   *
   * Tied to the in-app `appearance.reduceMotion` toggle via the
   * `.reduce-motion` class on `html` (wired in `src/routes/+layout.svelte`)
   * and the OS-level `prefers-reduced-motion` media query — both
   * disable the animation entirely.
   */

  interface Props {
    /** When true, the icon plays its one-shot pop animation. Set it
     *  back to false (or leave true) — the animation runs once and
     *  holds the final frame via `animation-fill-mode: forwards`. */
    animate?: boolean;
    /** Pixel size for the icon's bounding box. Matches the rest of
     *  the app's icon scale. */
    size?: number;
    /** Extra classes — colour, text-* (the SVG strokes
     *  `currentColor`), spacing, etc. */
    class?: string;
  }

  let { animate = false, size = 28, class: className = '' }: Props = $props();
</script>

<svg
  xmlns="http://www.w3.org/2000/svg"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  class="party-popper {className}"
  class:animate
  aria-hidden="true"
>
  <!-- Main popper body — small slide-in -->
  <g class="pp-popper">
    <path d="M5.8 11.3 2 22l10.7-3.79" />
    <path
      d="M11 13c1.93 1.93 2.83 4.17 2 5-.83.83-3.07-.07-5-2-1.93-1.93-2.83-4.17-2-5 .83-.83 3.07.07 5 2Z"
    />
  </g>

  <!--
    Confetti dots — fade + bounce in. Each dot is a tiny line so the
    round line-cap renders it as a single round point at this stroke
    width.
  -->
  <g class="pp-dots">
    <path d="M4 3h.01" />
    <path d="M22 8h.01" />
    <path d="M15 2h.01" />
    <path d="M22 20h.01" />
  </g>

  <!--
    Radiating lines — draw stroke-on with stroke-dashoffset while
    scaling from the popper's mouth outward. `pathLength="1"`
    normalizes each path's logical length so a single dasharray
    value works for all three.
  -->
  <g class="pp-lines">
    <path
      pathLength="1"
      d="m14 10 1.21-1.06c0.16-0.84 0.9-1.44 1.76-1.44h0.38c0.88 0 1.55-0.77 1.45-1.63a2.9 2.9 0 0 1 1.96-3.12L22 2"
    />
    <path
      pathLength="1"
      d="M17 15h0.77c0.71 0 1.32-0.52 1.43-1.22c0.16-0.91 1.12-1.45 1.98-1.11L22 13"
    />
    <path
      pathLength="1"
      d="M9 7V6.23c0-0.71 0.52-1.33 1.22-1.43c0.91-0.16 1.45-1.12 1.11-1.98L11 2"
    />
  </g>
</svg>

<style>
  .party-popper {
    /* Allow the slight scale-up at the apex of the bounce to peek
     * past the viewBox without getting clipped by the parent. */
    overflow: visible;
  }

  /*
   * Default (rest) state mirrors the "animate" end frame so the icon
   * looks finished even when `animate` is never flipped on — that way
   * the same component renders cleanly as a static glyph too.
   */
  .pp-popper,
  .pp-dots,
  .pp-lines {
    transform: translate(0, 0) scale(1);
    transform-origin: center;
    transform-box: fill-box;
    opacity: 1;
  }
  .pp-lines path {
    stroke-dasharray: 1;
    stroke-dashoffset: 0;
  }

  /*
   * Animate states — triggered by toggling `animate` on the SVG.
   * Each group has its own keyframe so the timings can differ
   * slightly (the popper body slides in faster than the dots /
   * lines pop out around it).
   */
  .party-popper.animate .pp-popper {
    animation: pp-popper 0.45s ease-out;
  }
  .party-popper.animate .pp-dots {
    animation: pp-dots 0.7s ease-out;
  }
  .party-popper.animate .pp-lines {
    animation: pp-lines 0.7s ease-out;
  }
  .party-popper.animate .pp-lines path {
    animation: pp-lines-draw 0.7s ease-out;
  }

  @keyframes pp-popper {
    0% {
      transform: translate(-1.5px, 1.5px);
    }
    100% {
      transform: translate(0, 0);
    }
  }

  @keyframes pp-dots {
    0% {
      opacity: 0;
      transform: translate(-5px, 5px) scale(0.5);
    }
    40% {
      transform: translate(0, 0) scale(0.8);
    }
    65% {
      transform: scale(1);
    }
    85% {
      transform: scale(1.1);
    }
    100% {
      opacity: 1;
      transform: scale(1);
    }
  }

  @keyframes pp-lines {
    0% {
      opacity: 0;
      transform: translate(-5px, 5px) scale(0.3);
    }
    40% {
      transform: translate(0, 0) scale(0.8);
    }
    65% {
      opacity: 1;
      transform: scale(1);
    }
    85% {
      transform: scale(1.1);
    }
    100% {
      opacity: 1;
      transform: scale(1);
    }
  }

  @keyframes pp-lines-draw {
    0% {
      stroke-dashoffset: 1;
    }
    50% {
      stroke-dashoffset: 0.5;
    }
    100% {
      stroke-dashoffset: 0;
    }
  }
</style>

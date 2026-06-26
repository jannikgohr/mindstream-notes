<script lang="ts">
  /**
   * Favourite-toggle star. Wraps `@jis3r/icons` Star but swaps its
   * trigger: the library's default fires on hover, which is too noisy
   * for an icon that appears in every row of the file tree — instead
   * the animation plays once when the `favourited` prop flips.
   *
   * `pointer-events: none` on the wrapper blocks the inner div's
   * built-in mouseenter handler. Click events still reach the parent
   * button (which owns the toggle) because pointer-events are
   * forwarded up the tree, not consumed.
   *
   * The `fav-filled` class on the wrapper turns the outline glyph
   * into a filled one when the note is favourited — see the rule in
   * `src/app.css`.
   */

  import { Star } from '@jis3r/icons';

  interface Props {
    /** Current favourite state. The animation fires when a note is favourited. */
    favourited: boolean;
    size?: number;
    class?: string;
  }

  let { favourited, size = 16, class: className = '' }: Props = $props();

  // Internal animation latch, separate from `favourited` so the
  // animation can be retriggered without changing the parent's state.
  let animate = $state(false);
  // Tracks the previous `favourited` across renders. Plain `let`, not
  // `$state` — writes mustn't be reactive. If it were a $state, mutating
  // it inside the effect would schedule a spurious re-run whose cleanup
  // would cancel the reset-to-false timer, leaving `animate` stuck on
  // `true` after the first toggle. The next toggle would then try
  // `animate = true` (no-op, same value), the class would never come
  // off, and the CSS animation wouldn't restart — which manifested as
  // "the same star only animates once".
  // Starts `undefined` so the first mount doesn't animate (we'd flash
  // every existing star on the initial paint of the file tree).
  let previous: boolean | undefined;

  $effect(() => {
    if (previous === undefined) {
      previous = favourited;
      return;
    }
    if (previous === favourited) return;
    previous = favourited;
    if (!favourited) {
      animate = false;
      return;
    }
    animate = true;
    // Matches the jis3r Star's internal 600 ms keyframe + a small
    // tail so the class is still on when CSS sees it.
    const handle = setTimeout(() => {
      animate = false;
    }, 700);
    return () => clearTimeout(handle);
  });
</script>

<span class="fav-star {favourited ? 'fav-filled' : ''} {className}">
  <Star {size} {animate} />
</span>

<style>
  .fav-star {
    display: inline-flex;
    /*
     * Blocks the inner Star's hover-triggered animation by stopping
     * pointer events from reaching it. The parent button still sees
     * clicks — pointer-events:none on a span doesn't sink events,
     * it just passes them through to whatever's behind it (here, the
     * surrounding button).
     */
    pointer-events: none;
  }
</style>

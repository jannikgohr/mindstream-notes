<script lang="ts">
  /**
   * Wrapper for the `@jis3r/icons` set that takes the animation away
   * from hover and hands the cue to the app.
   *
   * Every icon in that library animates on `mouseenter` via a handler
   * on its own root div. Wrapping it in a `pointer-events: none` span
   * blocks that handler outright — the icon never sees a pointer, so
   * `animate` is whatever we pass and nothing else. Clicks still reach
   * the surrounding button: `pointer-events: none` passes events
   * through to what's behind, it doesn't sink them. Same trick as
   * `FavouriteStar.svelte`, generalised.
   *
   * With no `cue` the icon is simply static — that's how the app-chrome
   * buttons use it. Pass a `cue` and the animation plays whenever that
   * value changes, so the motion means something (a category switched,
   * a notification arrived, a query was typed) instead of firing at
   * every stray pointer.
   *
   * `mode`:
   *   - `pulse`   — set `animate` for `duration` ms, then clear it.
   *                 Right for keyframe icons (Bell, Search) that play
   *                 once and settle.
   *   - `toggle`  — flip `animate` and leave it. Right for the Settings
   *                 gear, whose animation is a CSS *transition* to
   *                 `rotate(180deg)`: flipping turns each cue into one
   *                 half-turn instead of a there-and-back spin.
   *
   * Callers that need to survive the icon being unmounted mid-cue (the
   * notification bell swaps places with a spinner) can drive `animate`
   * themselves instead of passing a `cue` — a controlled `animate` is
   * still true when the icon remounts, so the animation plays.
   */

  import type { Component } from 'svelte';
  import { prefersReducedMotion } from '$lib/reduce-motion.svelte';

  interface Props {
    /** An icon component from `@jis3r/icons`. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    icon: Component<any>;
    /**
     * Animation cue. Every change to this value (after the first
     * render) plays the animation once. Leave it out for a static icon.
     */
    cue?: unknown;
    mode?: 'pulse' | 'toggle';
    /** How long `animate` stays on in `pulse` mode. */
    duration?: number;
    /**
     * Controlled mode: drive the animation directly and skip the `cue`
     * bookkeeping entirely. Mutually exclusive with `cue`.
     */
    animate?: boolean;
    size?: number;
    class?: string;
  }

  let {
    icon: Icon,
    cue,
    mode = 'pulse',
    duration = 1000,
    size = 16,
    animate: controlled,
    class: className = ''
  }: Props = $props();

  let cued = $state(false);
  const animate = $derived(controlled ?? cued);

  // Plain `let`, not `$state`: writing it inside the effect must not
  // schedule a re-run, or the cleanup would cancel the pulse timer
  // before it fires and leave `animate` stuck on. Starts `undefined`
  // so mounting doesn't animate — only an actual change to `cue` does.
  let previous: unknown;

  $effect(() => {
    if (controlled !== undefined) return;
    // Read the cue first so the effect tracks it on every path.
    const next = cue;
    if (next === undefined) return;
    if (previous === undefined) {
      previous = next;
      return;
    }
    if (previous === next) return;
    previous = next;
    if (prefersReducedMotion()) return;
    if (mode === 'toggle') {
      cued = !cued;
      return;
    }
    cued = true;
    const handle = setTimeout(() => {
      cued = false;
    }, duration);
    return () => clearTimeout(handle);
  });
</script>

<!--
  `pointer-events-none` is the load-bearing class here: it's what keeps
  the wrapped icon from ever seeing a pointer (and so from animating on
  hover). Clicks pass straight through to the surrounding button.
-->
<span class="pointer-events-none inline-flex {className}">
  <Icon {size} {animate} />
</span>

import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import CuedIcon from './CuedIcon.svelte';
import ProbeIcon from '../../../../.config/vitest/stubs/probe-icon.svelte';

/**
 * The wrapper exists so motion is app-driven: only a change of `cue`
 * (or a controlled `animate`) may start an animation — never a pointer
 * wandering across the icon.
 */
function probe(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[data-testid="probe-icon"]');
  if (!el) throw new Error('icon did not render');
  return el as HTMLElement;
}

describe('CuedIcon', () => {
  it('renders a static icon behind a pointer-events wall', () => {
    const { container } = render(CuedIcon, { icon: ProbeIcon });

    // The wall is what stops the icon's own mouseenter handler from
    // firing. Its effect can only be seen in a real browser (happy-dom
    // does no hit-testing, and fireEvent dispatches on the element
    // regardless), so the class itself is the assertion here.
    const wrapper = container.querySelector('span');
    expect(wrapper?.classList.contains('pointer-events-none')).toBe(true);
    expect(probe(container).dataset.animate).toBe('false');
  });

  it('animates when the cue changes, but not on mount', async () => {
    const { container, rerender } = render(CuedIcon, {
      icon: ProbeIcon,
      cue: 'appearance'
    });
    expect(probe(container).dataset.animate).toBe('false');

    await rerender({ icon: ProbeIcon, cue: 'editor' });

    expect(probe(container).dataset.animate).toBe('true');
  });

  it('flips instead of pulsing in toggle mode', async () => {
    const { container, rerender } = render(CuedIcon, {
      icon: ProbeIcon,
      cue: 'a',
      mode: 'toggle' as const
    });

    await rerender({ icon: ProbeIcon, cue: 'b', mode: 'toggle' as const });
    expect(probe(container).dataset.animate).toBe('true');

    await rerender({ icon: ProbeIcon, cue: 'c', mode: 'toggle' as const });
    expect(probe(container).dataset.animate).toBe('false');
  });

  it('follows a controlled animate prop', async () => {
    const { container, rerender } = render(CuedIcon, {
      icon: ProbeIcon,
      animate: true
    });
    expect(probe(container).dataset.animate).toBe('true');

    await rerender({ icon: ProbeIcon, animate: false });

    expect(probe(container).dataset.animate).toBe('false');
  });
});

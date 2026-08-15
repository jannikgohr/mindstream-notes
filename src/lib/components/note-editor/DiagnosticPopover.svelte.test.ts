import { cleanup, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DiagnosticPopover from './DiagnosticPopover.svelte';
import {
  closeDiagnosticPopover,
  openDiagnosticPopover
} from '$lib/diagnostics/popover-bridge.svelte';
import type { Diagnostic } from '$lib/diagnostics/types';

vi.mock('$lib/diagnostics/custom-dictionary.svelte', () => ({
  addCustomWord: vi.fn()
}));
vi.mock('$lib/settings/i18n.svelte', () => ({ tUi: (key: string) => key }));

const diagnostic: Diagnostic = {
  from: 0,
  to: 6,
  kind: 'spelling',
  message: 'Possible spelling mistake found.',
  replacements: ['Google', 'Googles'],
  source: 'test'
};

/**
 * Rendered replacement buttons, in order.
 *
 * Scoped by action: "Add to dictionary" is a menu item too, and counting it
 * as a suggestion makes these assertions quietly wrong.
 */
function suggestions(): HTMLButtonElement[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      'button[data-diagnostic-action="replace"]'
    )
  );
}

/** Wait for the bridge's suggestion promise and Svelte's render to settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  closeDiagnosticPopover();
  cleanup();
});

beforeEach(() => {
  closeDiagnosticPopover();
});

describe('applying a suggestion', () => {
  it('calls apply with the exact replacement and closes', async () => {
    // The whole point of the popover. Regressed twice: once because the
    // ranges behind it went stale, once because nothing exercised this path.
    const apply = vi.fn();
    render(DiagnosticPopover);

    openDiagnosticPopover(
      { diagnostic, x: 10, y: 10, word: 'Googel', apply },
      async () => []
    );
    await settle();

    const [first] = suggestions();
    expect(first).toBeDefined();
    first.click();

    expect(apply).toHaveBeenCalledWith('Google');
    await settle();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('applies the raw value, not the rendered whitespace markers', async () => {
    // Whitespace is drawn with visible glyphs; inserting those into the
    // document would put a literal middot in the user's note.
    const apply = vi.fn();
    render(DiagnosticPopover);

    openDiagnosticPopover(
      {
        diagnostic: { ...diagnostic, replacements: [': Google'] },
        x: 10,
        y: 10,
        word: ':Google',
        apply
      },
      async () => []
    );
    await settle();

    suggestions()[0].click();
    expect(apply).toHaveBeenCalledWith(': Google');
  });

  it('uses suggestions fetched on demand when the provider supplied none', async () => {
    const apply = vi.fn();
    render(DiagnosticPopover);

    openDiagnosticPopover(
      {
        diagnostic: { ...diagnostic, replacements: [] },
        x: 10,
        y: 10,
        word: 'Googel',
        apply
      },
      async () => ['Google']
    );
    await settle();

    suggestions()[0].click();
    expect(apply).toHaveBeenCalledWith('Google');
  });

  it('shows the whole message rather than one clipped line', async () => {
    render(DiagnosticPopover);
    openDiagnosticPopover(
      { diagnostic, x: 10, y: 10, word: 'Googel', apply: vi.fn() },
      async () => []
    );
    await settle();

    const menu = document.querySelector('[role="menu"]');
    expect(menu?.textContent).toContain('Possible spelling mistake found.');
    const message = Array.from(menu?.querySelectorAll('p') ?? []).find((p) =>
      p.textContent?.includes('Possible spelling')
    );
    expect(message?.className).not.toContain('truncate');
  });

  it('does not dismiss itself when a suggestion is pressed', async () => {
    // The dismiss-on-outside-click listener runs in the capture phase, so a
    // containment check that got this wrong would swallow every click.
    const apply = vi.fn();
    render(DiagnosticPopover);
    openDiagnosticPopover(
      { diagnostic, x: 10, y: 10, word: 'Googel', apply },
      async () => []
    );
    await settle();

    const button = suggestions()[0];
    button.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, composed: true })
    );
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    button.click();
    expect(apply).toHaveBeenCalledWith('Google');
  });
});

/**
 * Duplicate replacements. Different LanguageTool rules can offer the same
 * fix, and a keyed `each` throws on duplicate keys — taking the whole list
 * with it, so NO suggestion could be clicked.
 */
describe('duplicate suggestions', () => {
  it('renders a list containing duplicates, and it stays clickable', async () => {
    const apply = vi.fn();
    render(DiagnosticPopover);

    openDiagnosticPopover(
      {
        diagnostic: {
          ...diagnostic,
          replacements: ['Google', 'Google', 'Googles']
        },
        x: 10,
        y: 10,
        word: 'Googel',
        apply
      },
      async () => []
    );
    await settle();

    const items = suggestions();
    expect(items.map((b) => b.textContent?.trim())).toEqual([
      'Google',
      'Googles'
    ]);

    items[1].click();
    expect(apply).toHaveBeenCalledWith('Googles');
  });

  it('survives duplicates coming from the on-demand lookup', async () => {
    const apply = vi.fn();
    render(DiagnosticPopover);
    openDiagnosticPopover(
      {
        diagnostic: { ...diagnostic, replacements: [] },
        x: 10,
        y: 10,
        word: 'x',
        apply
      },
      async () => ['the', 'the', 'then']
    );
    await settle();

    expect(suggestions()).toHaveLength(2);
    suggestions()[0].click();
    expect(apply).toHaveBeenCalledWith('the');
  });
});

/**
 * The reported failure: clicking a suggestion did nothing, and scrolling the
 * list or dragging its scrollbar dismissed the menu.
 *
 * The desktop layout mounts a NoteEditor per dockview panel, and the popover
 * used to live inside it — so several copies of this component existed while
 * the state driving them was a module singleton. Each copy's dismiss handler
 * compared the event target against ITS OWN element, so a pointerdown inside
 * one menu looked "outside" to every other copy and closed the shared state
 * on pointerdown, before any click could land.
 *
 * It is mounted once at the root now. These pin the behaviour that made the
 * duplicate case fatal, so a second instance can never break it again.
 */
describe('mouse interaction inside the menu', () => {
  it('survives pointerdown even with another instance mounted', async () => {
    const apply = vi.fn();
    render(DiagnosticPopover);
    render(DiagnosticPopover);

    openDiagnosticPopover(
      { diagnostic, x: 10, y: 10, word: 'Googel', apply },
      async () => []
    );
    await settle();

    const button = suggestions()[0];
    button.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, composed: true })
    );
    await settle();

    expect(document.querySelector('[data-diagnostic-popover]')).not.toBeNull();
    button.click();
    expect(apply).toHaveBeenCalledWith('Google');
  });

  it('survives scrolling its own list', async () => {
    // A long suggestion list has to be scrollable without dismissing itself.
    render(DiagnosticPopover);
    openDiagnosticPopover(
      { diagnostic, x: 10, y: 10, word: 'Googel', apply: vi.fn() },
      async () => []
    );
    await settle();

    const list = document
      .querySelector('[data-diagnostic-popover]')
      ?.querySelector('div');
    list?.dispatchEvent(new Event('scroll', { bubbles: true }));
    await settle();

    expect(document.querySelector('[data-diagnostic-popover]')).not.toBeNull();
  });

  it('still closes on a pointerdown outside', async () => {
    render(DiagnosticPopover);
    openDiagnosticPopover(
      { diagnostic, x: 10, y: 10, word: 'Googel', apply: vi.fn() },
      async () => []
    );
    await settle();

    document.body.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, composed: true })
    );
    await settle();

    expect(document.querySelector('[data-diagnostic-popover]')).toBeNull();
  });
});

import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ContextMenu from './ContextMenu.svelte';

const items = [{ label: 'Rename', onSelect: vi.fn() }];

afterEach(() => {
  cleanup();
});

describe('ContextMenu layering', () => {
  it('uses the app overlay layer by default', () => {
    render(ContextMenu, {
      props: { x: 10, y: 10, items, onClose: vi.fn() }
    });

    expect(document.querySelector('[role="menu"]')?.className).toContain(
      'z-350'
    );
  });

  it('can render on the lower editor-local layer', () => {
    render(ContextMenu, {
      props: { x: 10, y: 10, items, layer: 'editor', onClose: vi.fn() }
    });

    expect(document.querySelector('[role="menu"]')?.className).toContain(
      'z-[250]'
    );
  });
});

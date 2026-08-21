import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ContextMenu from './ContextMenu.svelte';
import type { MenuItem } from './context-menu-types';

const items = [{ label: 'Rename', onSelect: vi.fn() }];

afterEach(() => {
  cleanup();
});

/** Find a rendered menu button by its visible label. */
function menuButton(label: string): HTMLButtonElement | undefined {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')
  ).find((b) => b.textContent?.trim().startsWith(label));
}

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

  it('can render above a popover for attached submenus', () => {
    render(ContextMenu, {
      props: {
        x: 10,
        y: 10,
        items,
        layer: 'overlay',
        onClose: vi.fn()
      }
    });

    expect(document.querySelector('[role="menu"]')?.className).toContain(
      'z-[450]'
    );
  });
});

describe('ContextMenu submenu', () => {
  const parentItems: (MenuItem | 'separator')[] = [
    {
      label: 'Sharing',
      children: [{ label: 'Share folder…', onSelect: vi.fn() }]
    }
  ];

  it('opens a submenu when its parent is clicked', async () => {
    render(ContextMenu, {
      props: { x: 10, y: 10, items: parentItems, onClose: vi.fn() }
    });

    menuButton('Sharing')!.click();
    await Promise.resolve();

    expect(menuButton('Share folder…')).toBeDefined();
  });

  it('offsets submenu padding so its first row aligns with the parent row', async () => {
    render(ContextMenu, {
      props: { x: 10, y: 10, items: parentItems, onClose: vi.fn() }
    });

    menuButton('Sharing')!.click();
    await Promise.resolve();

    const menus = document.querySelectorAll<HTMLElement>('[role="menu"]');
    expect(menus[1]?.className).toContain('-top-1');
  });

  it('keeps the submenu open when a preceding focus/hover already opened it', async () => {
    // Reproduces the flake: focus (or pointerenter) opens the submenu, then the
    // click must NOT toggle it shut. A click that reaches a parent always leaves
    // its submenu open, whatever order the events landed in.
    render(ContextMenu, {
      props: { x: 10, y: 10, items: parentItems, onClose: vi.fn() }
    });

    const sharing = menuButton('Sharing')!;
    sharing.dispatchEvent(new FocusEvent('focus'));
    await Promise.resolve();
    sharing.click();
    await Promise.resolve();

    expect(menuButton('Share folder…')).toBeDefined();
  });
});

describe('ContextMenu shortcuts and destructive styling', () => {
  it('invokes the advertised Delete action from the keyboard', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(ContextMenu, {
      props: {
        x: 10,
        y: 10,
        items: [
          {
            label: 'Delete',
            shortcut: 'Del',
            destructive: true,
            onSelect
          }
        ],
        onClose
      }
    });

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }));

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('lets a destructive item color its icon and shortcut', () => {
    render(ContextMenu, {
      props: {
        x: 10,
        y: 10,
        items: [{ label: 'Delete', shortcut: 'Del', destructive: true }],
        onClose: vi.fn()
      }
    });

    const button = menuButton('Delete')!;
    expect(button.querySelector('svg')?.classList).toContain('text-current');
    expect(button.querySelector('span.text-xs')?.classList).toContain(
      'text-current'
    );
  });
});

import { describe, expect, it, vi } from 'vitest';
import { menuItemForShortcut } from './context-menu-shortcuts';

describe('menuItemForShortcut', () => {
  it('maps the Delete key to a Del menu shortcut', () => {
    const onSelect = vi.fn();
    const item = { label: 'Delete', shortcut: 'Del', onSelect };

    expect(menuItemForShortcut([item], 'Delete')).toBe(item);
  });

  it('finds F2 and skips disabled actions and submenu parents', () => {
    const rename = { label: 'Rename', shortcut: 'F2' };
    expect(
      menuItemForShortcut(
        [
          { label: 'Disabled', shortcut: 'F2', disabled: true },
          { label: 'Parent', shortcut: 'F2', children: [rename] },
          rename
        ],
        'F2'
      )
    ).toBe(rename);
  });
});

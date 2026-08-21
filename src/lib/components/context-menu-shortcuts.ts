import type { MenuItem } from './context-menu-types';

function normalizedShortcut(value: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized === 'delete' ? 'del' : normalized;
}

/** Find the enabled leaf action advertised for a keyboard key. */
export function menuItemForShortcut(
  items: (MenuItem | 'separator')[],
  key: string
): MenuItem | null {
  const shortcut = normalizedShortcut(key);
  for (const item of items) {
    if (item === 'separator') continue;
    if (
      !item.disabled &&
      !item.children?.length &&
      item.shortcut &&
      normalizedShortcut(item.shortcut) === shortcut
    ) {
      return item;
    }
  }
  return null;
}

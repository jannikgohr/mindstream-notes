import { describe, expect, it } from 'vitest';
import { isAimingAtSubmenu } from './submenu-aim';

describe('isAimingAtSubmenu', () => {
  // Parent menu spans x 0..200; the submenu opens to its right.
  const submenu = { left: 204, right: 404, top: 100, bottom: 260 };

  it('accepts a diagonal reach toward the submenu', () => {
    expect(
      isAimingAtSubmenu({ x: 150, y: 110 }, { x: 165, y: 130 }, submenu, false)
    ).toBe(true);
  });

  it('rejects movement away from the submenu', () => {
    expect(
      isAimingAtSubmenu({ x: 150, y: 110 }, { x: 130, y: 130 }, submenu, false)
    ).toBe(false);
  });

  it('rejects mostly vertical movement down the menu', () => {
    expect(
      isAimingAtSubmenu({ x: 150, y: 110 }, { x: 152, y: 150 }, submenu, false)
    ).toBe(false);
  });

  it('rejects a pointer that has not moved', () => {
    expect(
      isAimingAtSubmenu({ x: 150, y: 110 }, { x: 150, y: 110 }, submenu, false)
    ).toBe(false);
  });

  it('mirrors for submenus that open to the left', () => {
    const left = { left: -204, right: -4, top: 100, bottom: 260 };
    expect(
      isAimingAtSubmenu({ x: 50, y: 110 }, { x: 35, y: 130 }, left, true)
    ).toBe(true);
    expect(
      isAimingAtSubmenu({ x: 50, y: 110 }, { x: 65, y: 130 }, left, true)
    ).toBe(false);
  });
});

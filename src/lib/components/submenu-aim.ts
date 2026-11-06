/**
 * Submenu "aim" detection (the safe-triangle pattern).
 *
 * Moving diagonally from a parent item into its submenu crosses the sibling
 * items in between. Switching the submenu on every sibling the pointer grazes
 * makes the submenu vanish mid-reach. Instead, while the pointer travels inside
 * the triangle spanned by where it was a moment ago and the submenu's near
 * edge, the submenu stays put. Once it leaves the triangle or stops moving, the
 * sibling it rests on takes over.
 */

export interface AimPoint {
  x: number;
  y: number;
}

export interface AimRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Vertical slack past the submenu's corners, so a reach that aims at its
 *  first or last item doesn't fall just outside the triangle. */
export const SUBMENU_AIM_TOLERANCE_PX = 20;
/** How long a pointer resting on a sibling keeps the old submenu open. */
export const SUBMENU_AIM_DELAY_MS = 250;

function cross(a: AimPoint, b: AimPoint, c: AimPoint): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function inTriangle(p: AimPoint, a: AimPoint, b: AimPoint, c: AimPoint) {
  const d1 = cross(a, b, p);
  const d2 = cross(b, c, p);
  const d3 = cross(c, a, p);
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNegative && hasPositive);
}

/**
 * Whether a pointer that moved from `from` to `to` is heading into
 * `submenu`, which sits to the right of its parent (or left if `opensLeft`).
 */
export function isAimingAtSubmenu(
  from: AimPoint,
  to: AimPoint,
  submenu: AimRect,
  opensLeft: boolean,
  tolerance = SUBMENU_AIM_TOLERANCE_PX
): boolean {
  if (from.x === to.x && from.y === to.y) return false;
  const edgeX = opensLeft ? submenu.right : submenu.left;
  return inTriangle(
    to,
    from,
    { x: edgeX, y: submenu.top - tolerance },
    { x: edgeX, y: submenu.bottom + tolerance }
  );
}

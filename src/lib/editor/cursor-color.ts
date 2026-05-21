/**
 * Stable cursor colour for live-collab awareness. Same seed (typically a
 * username) maps to the same hex across sessions and devices so a peer
 * shows the same cursor colour everywhere — small readability win.
 *
 * Hex (`#rrggbb`) is mandatory: y-prosemirror's yCursorPlugin warns
 * "A user uses an unsupported color format" on `hsl(...)` and similar
 * CSS functions. Picking from a fixed palette also means all peers agree
 * on the same hex for the same seed without doing colour math.
 */

const CURSOR_COLORS = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#10b981',
  '#06b6d4',
  '#0ea5e9',
  '#3b82f6',
  '#6366f1',
  '#8b5cf6',
  '#a855f7',
  '#d946ef',
  '#ec4899',
  '#f43f5e',
  '#84cc16'
];

export function pickCursorColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return CURSOR_COLORS[Math.abs(hash) % CURSOR_COLORS.length];
}

import {
  DEFAULT_WIDTH,
  type InkStrokeInput,
  type StrokeBounds,
  type StrokeTransform
} from './document';
import type { InkPoint } from './page';

export type { StrokeTransform };

export const SAVE_DEBOUNCE_MS = 800;
/**
 * Legacy fixed eraser radius, kept as the reference point for the
 * width-derived radius: the default brush width (4) maps back to it.
 */
export const ERASER_RADIUS = 10;
/** Smallest eraser radius, so a thin brush still erases usefully. */
export const ERASER_MIN_RADIUS = 5;
/** Eraser radius per unit of brush width (4 × 2.5 = the legacy 10). */
export const ERASER_RADIUS_PER_WIDTH = 2.5;
export const PAGE_FILL_LIGHT = 0xffffffff;
export const PAGE_GRID_STEP = 28;
export const PAGE_RULE_STEP = 48;
export const PAGE_PATTERN_LINE_ALPHA = 0x1f;
export const PAGE_PATTERN_DOT_ALPHA = 0x59;
export const PAGE_PATTERN_OPACITY_DEFAULT = 100;
export const TOOL_PREVIEW_DASH = [5, 4];
export const MAX_ZOOM_FACTOR = 6;
export const INK_ZOOM_DISPLAY_SCALE = 2;
export const INK_ZOOM_STEP = 1.2;
export const RESIZE_SNAPSHOT_RESTORE_SUPPRESS_MS = 350;
export const INK_QUICK_ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
export const INK_COLOR_SWATCHES = [
  '#111827',
  '#dc2626',
  '#2563eb',
  '#16a34a',
  '#f59e0b',
  '#7c3aed'
];

export const POINTER_BUTTON_SECONDARY = 2;
export const POINTER_BUTTON_STYLUS_PRIMARY = 32;
export const POINTER_BUTTON_STYLUS_SECONDARY = 64;
export const SELECTION_HANDLE_RADIUS_PX = 7;
export const SELECTION_HANDLE_HIT_RADIUS_PX = 22;
export const SELECTION_ROTATE_GAP_PX = 30;
export const SELECTION_PASTE_OFFSET_PX = 24;

export const INK_TOOL_SETTING = 'editor.ink.tool';
export const INK_COLOR_SETTING = 'editor.ink.color';
export const INK_WIDTH_SETTING = 'editor.ink.width';
export const INK_ERASER_MODE_SETTING = 'editor.ink.eraserMode';
export const INK_FINGER_SETTING = 'editor.ink.fingerDrawing';
export const INK_PAGE_THEME_SETTING = 'editor.ink.pageTheme';
export const INK_PAGE_BACKGROUND_SETTING = 'editor.ink.pageBackground';
export const INK_PAGE_BACKGROUND_COLOR_SETTING =
  'editor.ink.pageBackgroundColor';
export const INK_PAGE_BACKGROUND_OPACITY_SETTING =
  'editor.ink.pageBackgroundOpacity';

export type ToolMode = 'pen' | 'eraser' | 'lasso';
/**
 * How the eraser removes ink:
 *  - `stroke`: delete whole strokes the eraser touches (the default).
 *  - `pixel`: cut strokes and keep the parts outside the eraser (OneNote /
 *    Samsung Notes call this a "pixel" eraser).
 */
export type EraserMode = 'stroke' | 'pixel';
export type PageThemeMode = 'light' | 'dark' | 'system';
export type PageBackgroundMode = 'clear' | 'points' | 'lines' | 'grid';
export type AndroidStylusEraserAction = 'down' | 'move' | 'up' | 'cancel';
export type AndroidStylusEraserPoint = {
  x: number;
  y: number;
  pressure?: number;
};
export type AndroidStylusEraserPayload = {
  action: AndroidStylusEraserAction;
  points: AndroidStylusEraserPoint[];
};
export type QueuedEraserSample = {
  point: InkPoint;
  hits: Set<string>;
};
export type ToolPreview = {
  point: InkPoint;
  erasing: boolean;
  lassoing: boolean;
  pointerType: string;
};
export type PointerMode =
  | 'draw'
  | 'erase'
  | 'lasso'
  | 'moveSelection'
  | 'pan'
  | 'touchGesture';
export type SelectionHandle = 'nw' | 'ne' | 'se' | 'sw' | 'rotate';
export type SelectionFrame = Record<
  Exclude<SelectionHandle, 'rotate'>,
  { x: number; y: number }
>;
export type SelectionInteraction =
  | { kind: 'move'; start: InkPoint }
  | {
      kind: 'resize';
      handle: Exclude<SelectionHandle, 'rotate'>;
      anchor: { x: number; y: number };
      startCorner: { x: number; y: number };
    }
  | {
      kind: 'rotate';
      center: { x: number; y: number };
      startAngle: number;
    };
export type InkClipboardStroke = InkStrokeInput;
export type TouchPointer = {
  clientX: number;
  clientY: number;
  x: number;
  y: number;
};
export type TouchGestureState = {
  centerX: number;
  centerY: number;
  distance: number;
};
export type WebInkHandleInstance = {
  encode_state_vector: () => Uint8Array;
  encode_diff_for_state_vector: (stateVector: Uint8Array) => Uint8Array;
  apply_remote_update: (update: Uint8Array) => boolean;
};

export function normalizeInkTool(value: unknown): ToolMode {
  if (value === 'eraser' || value === 'lasso') return value;
  return 'pen';
}

export function normalizeInkEraserMode(value: unknown): EraserMode {
  return value === 'pixel' ? 'pixel' : 'stroke';
}

/** Eraser hit radius (page units) for the current brush width. */
export function eraserRadiusForWidth(width: unknown): number {
  const n = typeof width === 'number' ? width : Number(width);
  const safe = Number.isFinite(n) ? n : DEFAULT_WIDTH;
  return Math.max(ERASER_MIN_RADIUS, safe * ERASER_RADIUS_PER_WIDTH);
}

export function normalizeInkPageTheme(value: unknown): PageThemeMode {
  if (value === 'system') return 'system';
  if (value === 'dark') return 'dark';
  return 'light';
}

export function normalizeInkPageBackground(value: unknown): PageBackgroundMode {
  if (value === 'points' || value === 'lines' || value === 'grid') {
    return value;
  }
  return 'clear';
}

export function normalizeInkPageBackgroundOpacity(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  const percent = Number.isFinite(n) ? n : PAGE_PATTERN_OPACITY_DEFAULT;
  return Math.min(1, Math.max(0, percent / 100));
}

export function centeredPatternPositions(
  start: number,
  end: number,
  step: number
): number[] {
  const length = end - start;
  if (!Number.isFinite(length) || !Number.isFinite(step) || length <= 0) {
    return [];
  }
  if (step <= 0 || step > length) return [];
  const count = Math.floor(length / step);
  if (count <= 0) return [];
  const margin = (length - (count - 1) * step) / 2;
  return Array.from({ length: count }, (_, i) => start + margin + i * step);
}

export function normalizeInkWidth(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.min(12, Math.max(0.5, n)) : DEFAULT_WIDTH;
}

export function normalizeColorHex(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  const hex = raw.startsWith('#') ? raw.slice(1) : raw;
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return `#${hex
      .split('')
      .map((c) => c + c)
      .join('')
      .toLowerCase()}`;
  }
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return `#${hex.toLowerCase()}`;
  return null;
}

export function colorHexToArgb(value: unknown): number {
  const raw = typeof value === 'string' ? value : '#000000';
  const hex = raw.startsWith('#') ? raw.slice(1) : raw;
  const expanded =
    hex.length === 3
      ? hex
          .split('')
          .map((c) => c + c)
          .join('')
      : hex.slice(0, 6);
  const rgb = Number.parseInt(expanded.padEnd(6, '0'), 16);
  return (0xff000000 | (Number.isFinite(rgb) ? rgb : 0)) >>> 0;
}

export function argbToColorHex(argb: number): string {
  return `#${(argb & 0x00ffffff).toString(16).padStart(6, '0')}`;
}

export function cssColor(
  argb: number,
  cache: Map<number, string> = new Map()
): string {
  const key = argb >>> 0;
  const cached = cache.get(key);
  if (cached) return cached;
  const a = ((argb >>> 24) & 0xff) / 255;
  const r = (argb >>> 16) & 0xff;
  const g = (argb >>> 8) & 0xff;
  const b = argb & 0xff;
  const value = `rgba(${r}, ${g}, ${b}, ${a})`;
  cache.set(key, value);
  return value;
}

// Mirrors Excalidraw's dark-mode color transform: the CSS filter
// `invert(93%) hue-rotate(180deg)` applied mathematically per ARGB.
export function displayColor(argb: number, dark: boolean): number {
  if (!dark) return argb >>> 0;
  const alpha = argb & 0xff000000;
  const ir = 0.93 - 0.86 * (((argb >>> 16) & 0xff) / 255);
  const ig = 0.93 - 0.86 * (((argb >>> 8) & 0xff) / 255);
  const ib = 0.93 - 0.86 * ((argb & 0xff) / 255);
  const r = clampUnit(-0.574 * ir + 1.43 * ig + 0.144 * ib);
  const g = clampUnit(0.426 * ir + 0.43 * ig + 0.144 * ib);
  const b = clampUnit(0.426 * ir + 1.43 * ig - 0.856 * ib);
  const R = Math.round(r * 255);
  const G = Math.round(g * 255);
  const B = Math.round(b * 255);
  return (alpha | (R << 16) | (G << 8) | B) >>> 0;
}

export function sanitizePressure(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(1, value);
}

export function pressureWidth(pressure: number): number {
  return 0.25 + 0.75 * Math.min(1, Math.max(0, pressure));
}

export function identityTransform(): StrokeTransform {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, widthScale: 1 };
}

export function translationTransform(dx: number, dy: number): StrokeTransform {
  return { a: 1, b: 0, c: 0, d: 1, e: dx, f: dy, widthScale: 1 };
}

export function transformIsIdentity(transform: StrokeTransform): boolean {
  return (
    Math.abs(transform.a - 1) < 0.0001 &&
    Math.abs(transform.b) < 0.0001 &&
    Math.abs(transform.c) < 0.0001 &&
    Math.abs(transform.d - 1) < 0.0001 &&
    Math.abs(transform.e) < 0.001 &&
    Math.abs(transform.f) < 0.001 &&
    Math.abs(transform.widthScale - 1) < 0.0001
  );
}

export function transformPoint(
  point: { x: number; y: number },
  transform: StrokeTransform
): { x: number; y: number } {
  return {
    x: point.x * transform.a + point.y * transform.c + transform.e,
    y: point.x * transform.b + point.y * transform.d + transform.f
  };
}

export function resizeTransform(
  anchor: { x: number; y: number },
  startCorner: { x: number; y: number },
  current: { x: number; y: number }
): StrokeTransform {
  const minScale = 0.08;
  const sxBase = startCorner.x - anchor.x;
  const syBase = startCorner.y - anchor.y;
  const rawSx = Math.abs(sxBase) < 0.001 ? 1 : (current.x - anchor.x) / sxBase;
  const rawSy = Math.abs(syBase) < 0.001 ? 1 : (current.y - anchor.y) / syBase;
  const sx = Math.max(minScale, rawSx);
  const sy = Math.max(minScale, rawSy);
  return {
    a: sx,
    b: 0,
    c: 0,
    d: sy,
    e: anchor.x - anchor.x * sx,
    f: anchor.y - anchor.y * sy,
    widthScale: Math.sqrt(Math.max(minScale * minScale, sx * sy))
  };
}

export function rotationTransform(
  center: { x: number; y: number },
  angle: number
): StrokeTransform {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    a: cos,
    b: sin,
    c: -sin,
    d: cos,
    e: center.x - center.x * cos + center.y * sin,
    f: center.y - center.x * sin - center.y * cos,
    widthScale: 1
  };
}

export function transformedPoints(
  points: InkPoint[],
  transform: StrokeTransform
): InkPoint[] {
  return points.map((point) => ({
    ...transformPoint(point, transform),
    pressure: point.pressure
  }));
}

export function frameFromBounds(bounds: StrokeBounds): SelectionFrame {
  return {
    nw: { x: bounds.minX, y: bounds.minY },
    ne: { x: bounds.maxX, y: bounds.minY },
    se: { x: bounds.maxX, y: bounds.maxY },
    sw: { x: bounds.minX, y: bounds.maxY }
  };
}

export function transformSelectionFrame(
  frame: SelectionFrame,
  transform: StrokeTransform
): SelectionFrame {
  return {
    nw: transformPoint(frame.nw, transform),
    ne: transformPoint(frame.ne, transform),
    se: transformPoint(frame.se, transform),
    sw: transformPoint(frame.sw, transform)
  };
}

export function selectionCenter(frame: SelectionFrame): {
  x: number;
  y: number;
} {
  return {
    x: (frame.nw.x + frame.ne.x + frame.se.x + frame.sw.x) * 0.25,
    y: (frame.nw.y + frame.ne.y + frame.se.y + frame.sw.y) * 0.25
  };
}

export function pointInPolygon(
  point: { x: number; y: number },
  polygon: Array<{ x: number; y: number }>
): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const intersects =
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function base64ToBytes(b64: string): Uint8Array {
  const standard = b64.replace(/-/g, '+').replace(/_/g, '/');
  const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function clampUnit(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

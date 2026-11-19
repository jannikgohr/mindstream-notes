/**
 * The view tree a `schema` sidebar view returns, and its parser.
 *
 * A plugin describes what to show; the host draws it with its own components,
 * so the view looks like the rest of the app, follows the theme and keeps the
 * app's keyboard and screen-reader behaviour. The vocabulary is closed. An
 * interaction either names an event, sent back to the plugin's `onEvent`, or
 * carries an effect the host performs directly.
 *
 * The tree is untrusted: everything is shape-checked, unknown nodes and bad
 * fields are dropped, and size limits keep a runaway plugin from building a
 * page the sidebar can't draw.
 */

import { parsePluginEffect } from './effects';
import type { PluginEffect } from './types';

export type ViewAction = { event: string; value?: string } | PluginEffect;

export type ViewTone = 'default' | 'muted' | 'accent';

export interface ViewCalendarDay {
  /** Up to four dots under the day number. */
  marks: ('accent' | 'muted')[];
  /** Bold day number. */
  strong: boolean;
  /** Tooltip. */
  title?: string;
}

export interface ViewListItem {
  label: string;
  detail?: string;
  /** Plugin-relative `.svg` icon, or a note kind's icon. */
  icon?: string;
  noteKind?: string;
  tone: ViewTone;
  on?: ViewAction;
}

export type ViewNode =
  | { type: 'stack'; children: ViewNode[] }
  | { type: 'heading'; text: string }
  | { type: 'text'; text: string; tone: ViewTone }
  | { type: 'button'; label: string; icon?: string; on: ViewAction }
  | {
      type: 'calendar';
      /** `YYYY-MM` shown. */
      month: string;
      /** `YYYY-MM-DD` highlighted. */
      selected?: string;
      days: Record<string, ViewCalendarDay>;
      /** Event sent with the picked `YYYY-MM-DD` as `value`. */
      onSelect: string;
      /** Event sent with the new `YYYY-MM` as `value`. */
      onMonth: string;
    }
  | { type: 'list'; items: ViewListItem[] };

const MAX_DEPTH = 6;
const MAX_CHILDREN = 100;
const MAX_ITEMS = 200;
const MAX_DAYS = 62;
const MAX_MARKS = 4;
const MAX_TEXT = 300;

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const EVENT_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
// Same rule as manifest icons: a relative .svg inside the plugin.
const SVG_RE = /^(?!\/)(?!.*\.\.)(?!.*\\)[A-Za-z0-9_./-]+\.svg$/;

type Raw = Record<string, unknown>;

function isObject(value: unknown): value is Raw {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value.slice(0, MAX_TEXT) : undefined;
}

/** A `YYYY-MM-DD` that names a real day: `2026-02-31` doesn't. */
function isDay(value: unknown): value is string {
  if (typeof value !== 'string' || !DAY_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDate() === d;
}

function tone(value: unknown): ViewTone {
  return value === 'muted' || value === 'accent' ? value : 'default';
}

function event(value: unknown): string | undefined {
  return typeof value === 'string' && EVENT_RE.test(value) ? value : undefined;
}

function icon(value: unknown): string | undefined {
  return typeof value === 'string' && SVG_RE.test(value) ? value : undefined;
}

export function parseViewAction(value: unknown): ViewAction | undefined {
  if (!isObject(value)) return undefined;
  if ('effect' in value) return parsePluginEffect(value) ?? undefined;
  const name = event(value.event);
  if (!name) return undefined;
  const v = text(value.value);
  return v === undefined ? { event: name } : { event: name, value: v };
}

function parseDays(value: unknown): Record<string, ViewCalendarDay> {
  const days: Record<string, ViewCalendarDay> = {};
  if (!isObject(value)) return days;
  for (const [date, raw] of Object.entries(value).slice(0, MAX_DAYS)) {
    if (!isDay(date) || !isObject(raw)) continue;
    const marks = Array.isArray(raw.marks)
      ? raw.marks
          .filter(
            (m): m is 'accent' | 'muted' => m === 'accent' || m === 'muted'
          )
          .slice(0, MAX_MARKS)
      : [];
    days[date] = { marks, strong: raw.strong === true, title: text(raw.title) };
  }
  return days;
}

function parseItem(value: unknown): ViewListItem | undefined {
  if (!isObject(value)) return undefined;
  const label = text(value.label);
  if (label === undefined) return undefined;
  return {
    label,
    detail: text(value.detail),
    icon: icon(value.icon),
    noteKind: text(value.noteKind),
    tone: tone(value.tone),
    on: parseViewAction(value.on)
  };
}

/** Parse an untrusted view tree, or `null` when its root isn't a node. */
export function parseViewNode(value: unknown, depth = 0): ViewNode | null {
  if (!isObject(value) || depth > MAX_DEPTH) return null;
  switch (value.type) {
    case 'stack': {
      const children = Array.isArray(value.children)
        ? value.children
            .slice(0, MAX_CHILDREN)
            .map((child) => parseViewNode(child, depth + 1))
            .filter((child): child is ViewNode => child !== null)
        : [];
      return { type: 'stack', children };
    }
    case 'heading': {
      const t = text(value.text);
      return t === undefined ? null : { type: 'heading', text: t };
    }
    case 'text': {
      const t = text(value.text);
      return t === undefined
        ? null
        : { type: 'text', text: t, tone: tone(value.tone) };
    }
    case 'button': {
      const label = text(value.label);
      const on = parseViewAction(value.on);
      if (label === undefined || !on) return null;
      return { type: 'button', label, icon: icon(value.icon), on };
    }
    case 'calendar': {
      const onSelect = event(value.onSelect);
      const onMonth = event(value.onMonth);
      if (typeof value.month !== 'string' || !MONTH_RE.test(value.month))
        return null;
      if (!onSelect || !onMonth) return null;
      const selected = isDay(value.selected) ? value.selected : undefined;
      return {
        type: 'calendar',
        month: value.month,
        selected,
        days: parseDays(value.days),
        onSelect,
        onMonth
      };
    }
    case 'list': {
      const items = Array.isArray(value.items)
        ? value.items
            .slice(0, MAX_ITEMS)
            .map(parseItem)
            .filter((item): item is ViewListItem => item !== undefined)
        : [];
      return { type: 'list', items };
    }
    default:
      return null;
  }
}

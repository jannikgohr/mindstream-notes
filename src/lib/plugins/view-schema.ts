/**
 * The view tree a `schema` sidebar view returns, and its parser.
 *
 * A plugin describes what to show; the host draws it with its own components,
 * so the view looks like the rest of the app, follows the theme and keeps the
 * app's keyboard and screen-reader behaviour. The vocabulary is closed. An
 * interaction either names an event, sent back to the plugin's `onEvent`, or
 * carries an effect the host performs directly.
 *
 * Text is language-agnostic: a string shown as is (a note title), a key into
 * the plugin's own `contributes.i18n` strings, or a day the host formats. The
 * host resolves both in the app's language, so a plugin never picks one.
 *
 * The tree is untrusted: everything is shape-checked, unknown nodes and bad
 * fields are dropped, and size limits keep a runaway plugin from building a
 * page the sidebar can't draw.
 */

import { i18n } from '$lib/settings/i18n.svelte';
import { parsePluginEffect } from './effects';
import { resolvePluginPlural, resolvePluginString } from './plugin-i18n';
import type { PluginEffect } from './types';

/** Intl options a `date` text may use. */
export interface ViewDateFormat {
  weekday?: 'long' | 'short' | 'narrow';
  day?: 'numeric' | '2-digit';
  month?: 'long' | 'short' | 'narrow' | 'numeric' | '2-digit';
  year?: 'numeric' | '2-digit';
}

/**
 * - a string, shown as is;
 * - `{ key, params?, count? }`: the plugin's string for `key`, with `{name}`
 *   replaced from `params`. With `count`, the key is suffixed by its plural
 *   category in the app's language (`.one`, `.other`, …, falling back to
 *   `.other`), and `{count}` is available;
 * - `{ date, format }`: a `YYYY-MM-DD` formatted in the app's language.
 */
export type ViewText =
  | string
  | { key: string; params: Record<string, string>; count?: number }
  | { date: string; format: ViewDateFormat };

export type ViewAction = { event: string; value?: string } | PluginEffect;

export type ViewTone = 'default' | 'muted' | 'accent';

export interface ViewCalendarDay {
  /** Up to four dots under the day number. */
  marks: ('accent' | 'muted')[];
  /** Bold day number. */
  strong: boolean;
  /** Tooltip. */
  title?: ViewText;
}

export interface ViewListItem {
  label: ViewText;
  detail?: ViewText;
  /** Plugin-relative `.svg` icon, or a note kind's icon. */
  icon?: string;
  noteKind?: string;
  tone: ViewTone;
  on?: ViewAction;
}

export type ViewNode =
  | { type: 'stack'; children: ViewNode[] }
  | { type: 'heading'; text: ViewText }
  | { type: 'text'; text: ViewText; tone: ViewTone }
  | { type: 'button'; label: ViewText; icon?: string; on: ViewAction }
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
const PARAM_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const MAX_PARAMS = 8;
const DATE_FORMAT_VALUES: Record<keyof ViewDateFormat, readonly string[]> = {
  weekday: ['long', 'short', 'narrow'],
  day: ['numeric', '2-digit'],
  month: ['long', 'short', 'narrow', 'numeric', '2-digit'],
  year: ['numeric', '2-digit']
};
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
  const day = new Date(0);
  day.setUTCFullYear(y, m - 1, d);
  return day.getUTCDate() === d;
}

function displayText(value: unknown): ViewText | undefined {
  if (typeof value === 'string') return value.slice(0, MAX_TEXT);
  if (!isObject(value)) return undefined;
  if (typeof value.key === 'string') {
    if (value.key === '' || value.key.length > MAX_TEXT) return undefined;
    const params: Record<string, string> = {};
    if (isObject(value.params)) {
      for (const [name, v] of Object.entries(value.params).slice(
        0,
        MAX_PARAMS
      )) {
        if (
          PARAM_RE.test(name) &&
          (typeof v === 'string' || typeof v === 'number')
        )
          params[name] = String(v).slice(0, MAX_TEXT);
      }
    }
    const count =
      typeof value.count === 'number' && Number.isFinite(value.count)
        ? value.count
        : undefined;
    return count === undefined
      ? { key: value.key, params }
      : { key: value.key, params, count };
  }
  if (isDay(value.date) && isObject(value.format)) {
    const format: ViewDateFormat = {};
    for (const [part, allowed] of Object.entries(DATE_FORMAT_VALUES)) {
      const v = value.format[part];
      if (typeof v === 'string' && allowed.includes(v))
        (format as Record<string, string>)[part] = v;
    }
    return { date: value.date, format };
  }
  return undefined;
}

/** A view text in the app's language, for `pluginId`'s strings. */
export function viewText(pluginId: string, text: ViewText): string {
  if (typeof text === 'string') return text;
  const locale = i18n.language;
  if ('date' in text) {
    // In UTC, so no time zone can move the day: a local midnight can fall in
    // a skipped day. setUTCFullYear keeps years 0–99 as written.
    const [y, m, d] = text.date.split('-').map(Number);
    const day = new Date(0);
    day.setUTCFullYear(y, m - 1, d);
    return new Intl.DateTimeFormat(locale, {
      ...text.format,
      timeZone: 'UTC'
    }).format(day);
  }
  const params: Record<string, string> = { ...text.params };
  let template: string;
  if (text.count !== undefined) {
    params.count = new Intl.NumberFormat(locale).format(text.count);
    template = resolvePluginPlural(pluginId, text.key, text.count);
  } else {
    template = resolvePluginString(pluginId, text.key);
  }
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (slot, name) =>
    Object.hasOwn(params, name) ? params[name] : slot
  );
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
    days[date] = {
      marks,
      strong: raw.strong === true,
      title: displayText(raw.title)
    };
  }
  return days;
}

function parseItem(value: unknown): ViewListItem | undefined {
  if (!isObject(value)) return undefined;
  const label = displayText(value.label);
  if (label === undefined) return undefined;
  return {
    label,
    detail: displayText(value.detail),
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
      const t = displayText(value.text);
      return t === undefined ? null : { type: 'heading', text: t };
    }
    case 'text': {
      const t = displayText(value.text);
      return t === undefined
        ? null
        : { type: 'text', text: t, tone: tone(value.tone) };
    }
    case 'button': {
      const label = displayText(value.label);
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

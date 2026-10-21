import { clock, uuid, type TimeUnit } from '../../typescript/src/index';

interface RenderContext {
  now: string;
  vars: Record<string, unknown>;
  locale?: string;
}

const defaults: Record<string, string> = {
  date: 'YYYY-MM-DD',
  time: 'HH:mm',
  datetime: 'YYYY-MM-DD HH:mm',
  now: 'YYYY-MM-DD HH:mm'
};
const units: Record<string, TimeUnit> = {
  y: 'year',
  M: 'month',
  w: 'week',
  d: 'day',
  h: 'hour',
  m: 'minute',
  s: 'second'
};
// Match Luau's byte-string case conversion for existing user templates.
const upper = (value: string) =>
  value.replace(/[a-z]/g, (char) => char.toUpperCase());
const lower = (value: string) =>
  value.replace(/[A-Z]/g, (char) => char.toLowerCase());
const trim = (value: string) =>
  value.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, '');

function filter(value: string, name: string): string {
  switch (name) {
    case 'upper':
      return upper(value);
    case 'lower':
      return lower(value);
    case 'trim':
      return trim(value);
    case 'capitalize':
      return upper(value.slice(0, 1)) + value.slice(1);
    case 'slug':
      return trim(lower(value))
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    default:
      return value;
  }
}

function resolve(inner: string, ctx: RenderContext): string {
  const [expression, ...filters] = inner.split('|');
  const part = trim(expression);
  const colon = part.indexOf(':');
  let base = colon < 0 ? part : trim(part.slice(0, colon));
  const format = colon < 0 ? undefined : trim(part.slice(colon + 1));
  let offset = '';
  for (;;) {
    const term = /([+-]\d+[yMwdhms])$/.exec(base);
    if (!term) break;
    offset = term[0] + offset;
    base = base.slice(0, term.index);
  }
  base = trim(base);
  let value: string;
  if (base === 'uuid') value = uuid();
  else if (Object.hasOwn(defaults, base)) {
    let time = ctx.now;
    for (const term of offset.matchAll(/([+-])(\d+)([yMwdhms])/g)) {
      time = clock.add(
        time,
        Number(term[2]) * (term[1] === '-' ? -1 : 1),
        units[term[3]]
      );
    }
    value = clock.format(time, format ?? defaults[base], ctx.locale);
  } else {
    value = ctx.vars[base] == null ? '' : String(ctx.vars[base]);
  }
  for (const name of filters) value = filter(value, trim(name));
  return value;
}

export function render(text: string, ctx: RenderContext): string {
  return text.replace(/\{\{([\s\S]*?)\}\}/g, (_, inner: string) =>
    resolve(inner, ctx)
  );
}

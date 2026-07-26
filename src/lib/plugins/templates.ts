/**
 * App-mediated note creation from plugin templates.
 *
 * The safety property of the whole template slice lives here: a plugin never
 * creates a note itself. It contributes a *declarative* template (title/body
 * strings with `{{variable}}` placeholders); the app renders those strings and
 * calls its own note-creation path. A plugin therefore needs neither
 * `notes.write` nor any code execution to ship a useful template — it only asks
 * for `templates.contribute` (to be shown) and `notes.create` (to be turned
 * into a note by the app).
 *
 * Interpolation stays declarative — a plugin ships strings, never code — but is
 * no longer *dumb*: a placeholder is `{{ base [offset] [:format] [|filter]* }}`
 * (see template-format.ts). `{{name}}` is still a plain variable lookup and an
 * unknown placeholder still renders empty (documented rule — a template can
 * reference an optional variable the user left blank without erroring). On top
 * of that, built-in date bases (`date`, `time`, `datetime`, `now`) support date
 * math and moment-style formatting, `{{uuid}}` yields a fresh id, and `|filter`
 * text transforms apply. There is still no expression language a template can
 * script and no function calls beyond that fixed vocabulary.
 *
 * Precedence when resolving a placeholder's `base`: a context value (a template
 * variable or provided value) always wins — so a user variable literally named
 * `date` overrides the built-in, and any `:format`/offset on it is ignored. Only
 * when `base` is *not* in the context do the built-in date/uuid bases apply.
 */

import { requestOpenNote } from '$lib/stores/open-note-intent.svelte';
import { createNoteIn } from '$lib/stores/tree.svelte';
import { getSettingValue } from '$lib/settings/store.svelte';
import { i18n } from '$lib/settings/i18n.svelte';
import { pluginById, pluginTemplate } from './registry.svelte';
import { resolvePluginString } from './plugin-i18n';
import {
  applyDateOffset,
  applyFilter,
  defaultDateFormat,
  formatDate,
  isDateBase,
  parseExpr
} from './template-format';
import type { PluginNoteTemplateContribution, PluginPermission } from './types';

/** Values interpolated into a template, keyed by placeholder name. */
export type TemplateVariables = Record<string, string>;

/**
 * App-honoured convention for template plugins: if a plugin declares a
 * device-scoped `open-on-create` toggle, the app opens (or doesn't open) the
 * new note in the editor accordingly. A manifest-only plugin can't act on its
 * own settings, so the app reads this one. Absent/unset ⇒ open (the default a
 * user expects); only an explicit `false` suppresses the open.
 */
export function shouldOpenOnCreate(pluginId: string): boolean {
  return getSettingValue(`plugins.${pluginId}.open-on-create`) !== false;
}

// Captures the inner text of a `{{ … }}` placeholder (no nested braces); the
// grammar inside is parsed by template-format's parseExpr.
const PLACEHOLDER_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** Today's date as `YYYY-MM-DD` — the default rendering of `{{date}}`. */
export function todayIsoDate(now: Date = new Date()): string {
  return formatDate(now, 'YYYY-MM-DD');
}

/** A fresh random id for the `{{uuid}}` built-in, with a non-crypto fallback. */
function newUuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Replace every `{{ … }}` placeholder in `template`. A context value always
 * wins; otherwise built-in date bases (with optional offset/format) and
 * `{{uuid}}` resolve, and an unknown base renders empty. `|filter` transforms
 * are applied last. Pure and synchronous given `now`/`locale`.
 */
export function renderTemplateString(
  template: string,
  context: TemplateVariables,
  now: Date = new Date(),
  locale: string = i18n.language
): string {
  return template.replace(PLACEHOLDER_RE, (_match, inner: string) => {
    const { base, offset, format, filters } = parseExpr(inner);
    let value: string;
    if (base && Object.prototype.hasOwnProperty.call(context, base)) {
      value = context[base] ?? '';
    } else if (isDateBase(base)) {
      value = formatDate(
        applyDateOffset(now, offset),
        format ?? defaultDateFormat(base),
        locale
      );
    } else if (base === 'uuid') {
      value = newUuid();
    } else {
      value = '';
    }
    for (const filter of filters) value = applyFilter(value, filter);
    return value;
  });
}

/**
 * Build the render context for a template: each declared variable's default,
 * then the caller-provided values (which win). Date/uuid built-ins are *not*
 * placed here — they are resolved at render time by renderTemplateString — so a
 * variable literally named `date` (declared or provided) still overrides the
 * built-in, as documented.
 */
export function buildTemplateContext(
  template: PluginNoteTemplateContribution,
  provided: TemplateVariables = {}
): TemplateVariables {
  const context: TemplateVariables = {};
  for (const variable of template.variables ?? []) {
    if (variable.default !== undefined) context[variable.id] = variable.default;
  }
  for (const [key, value] of Object.entries(provided)) {
    if (value !== undefined) context[key] = value;
  }
  return context;
}

/** True when a required, defaultless variable has no provided value. */
function missingRequiredVariable(
  template: PluginNoteTemplateContribution,
  context: TemplateVariables
): string | null {
  for (const variable of template.variables ?? []) {
    if (!variable.required) continue;
    const value = context[variable.id];
    if (value === undefined || value === '') return variable.id;
  }
  return null;
}

function pluginHasPermission(
  pluginId: string,
  permission: PluginPermission
): boolean {
  return (
    pluginById(pluginId)?.manifest.permissions.includes(permission) ?? false
  );
}

/** The rendered title + body a template produces for the given variables. */
export interface RenderedTemplate {
  title: string;
  body: string;
}

/**
 * Render a template's title + body. Throws if a required variable is missing.
 * The title is trimmed; if it renders empty it falls back to the template's
 * localized label so a note is never created titleless. `{{title}}` inside the
 * body resolves to the final rendered title.
 */
export function renderPluginTemplate(
  pluginId: string,
  template: PluginNoteTemplateContribution,
  provided: TemplateVariables = {},
  now: Date = new Date()
): RenderedTemplate {
  const context = buildTemplateContext(template, provided);
  const missing = missingRequiredVariable(template, context);
  if (missing) {
    throw new Error(
      `Template "${template.id}" requires a value for variable "${missing}"`
    );
  }
  let title = renderTemplateString(template.titleTemplate, context, now).trim();
  if (title === '') {
    title = resolvePluginString(pluginId, template.labelKey);
  }
  const body = renderTemplateString(
    template.bodyTemplate,
    { ...context, title },
    now
  );
  return { title, body };
}

/**
 * Create a markdown note from an enabled plugin's template and open it.
 *
 * Steps (per the plan):
 *   1. resolve the enabled plugin's template contribution;
 *   2. check the plugin actually holds `notes.create`;
 *   3. render title/body from the variables;
 *   4. create the note through the app's own `createNoteIn`;
 *   5. open it via the existing open-note intent.
 *
 * Returns the new note id. Throws (with a clear message) if the template can't
 * be found or the plugin lacks permission — callers surface that rather than
 * silently doing nothing.
 */
export async function createNoteFromPluginTemplate(
  pluginId: string,
  templateId: string,
  parentId: string | null,
  variables: TemplateVariables = {}
): Promise<string> {
  const ref = pluginTemplate(pluginId, templateId);
  if (!ref) {
    throw new Error(
      `No enabled template "${templateId}" from plugin "${pluginId}"`
    );
  }
  if (!pluginHasPermission(pluginId, 'notes.create')) {
    throw new Error(
      `Plugin "${pluginId}" is not permitted to create notes (missing notes.create)`
    );
  }

  const { title, body } = renderPluginTemplate(
    pluginId,
    ref.template,
    variables
  );
  const id = await createNoteIn(parentId, title, ref.template.noteKind, body);
  if (shouldOpenOnCreate(pluginId)) requestOpenNote(id);
  return id;
}

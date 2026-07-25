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
 * Interpolation is intentionally dumb: `{{name}}` is replaced by a value from
 * the render context, `{{ name }}` with surrounding spaces works too, and an
 * unknown placeholder renders as the empty string (documented rule — a template
 * can reference an optional variable the user left blank without erroring).
 * There is no expression language and no function calls.
 */

import { requestOpenNote } from '$lib/stores/open-note-intent.svelte';
import { createNoteIn } from '$lib/stores/tree.svelte';
import { getSettingValue } from '$lib/settings/store.svelte';
import { pluginById, pluginTemplate } from './registry.svelte';
import { resolvePluginString } from './plugin-i18n';
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

const PLACEHOLDER_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** Today's date as `YYYY-MM-DD`, the value of the built-in `{{date}}`. */
export function todayIsoDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Replace every `{{name}}` in `template` with `context[name]`. Unknown names
 * render as an empty string. Pure and synchronous.
 */
export function renderTemplateString(
  template: string,
  context: TemplateVariables
): string {
  return template.replace(PLACEHOLDER_RE, (_match, name: string) => {
    const value = context[name];
    return value == null ? '' : String(value);
  });
}

/**
 * Build the render context for a template: built-in `date`, then each declared
 * variable's default, then the caller-provided values (which win). A variable
 * literally named `date` therefore overrides the built-in, as documented.
 */
export function buildTemplateContext(
  template: PluginNoteTemplateContribution,
  provided: TemplateVariables = {},
  now: Date = new Date()
): TemplateVariables {
  const context: TemplateVariables = { date: todayIsoDate(now) };
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
  const context = buildTemplateContext(template, provided, now);
  const missing = missingRequiredVariable(template, context);
  if (missing) {
    throw new Error(
      `Template "${template.id}" requires a value for variable "${missing}"`
    );
  }
  let title = renderTemplateString(template.titleTemplate, context).trim();
  if (title === '') {
    title = resolvePluginString(pluginId, template.labelKey);
  }
  const body = renderTemplateString(template.bodyTemplate, {
    ...context,
    title
  });
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

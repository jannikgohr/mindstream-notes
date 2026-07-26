/**
 * Manifest + contribution validation.
 *
 * A plugin is untrusted data. Before any contribution reaches the registry it
 * passes through here, which enforces the invariants the rest of the system
 * relies on:
 *
 *   - stable, namespaced plugin ids and kebab-case local slugs
 *   - only capabilities the app understands, only the note kinds it renders
 *   - permissions that actually cover what the manifest contributes
 *   - internal referential integrity (a command's template exists, a select
 *     setting has options, …)
 *
 * Validation throws {@link PluginValidationError} on the first problem with a
 * message that names the plugin and the offending path. The loader catches it
 * per-plugin and records it as that plugin's `last load error`, so one broken
 * manifest never takes down app startup or another plugin.
 */

import {
  KNOWN_PLUGIN_PERMISSIONS,
  type PluginManifest,
  type PluginNoteTemplateContribution,
  type PluginPermission,
  type PluginSetting,
  type PluginSettingsContribution,
  type PluginCommandContribution,
  type PluginTemplateVariable
} from './types';

export class PluginValidationError extends Error {
  constructor(
    /** The plugin the failure belongs to (`'<unknown>'` before the id parses). */
    readonly pluginId: string,
    message: string
  ) {
    super(message);
    this.name = 'PluginValidationError';
  }
}

/** Dotted, lowercase, ≥2 segments — e.g. `com.mindstream.templates.core`. */
const PLUGIN_ID_RE =
  /^[a-z0-9]+(?:[-.][a-z0-9]+)*\.[a-z0-9]+(?:[-.][a-z0-9]+)*$/;
/** Kebab-case, lowercase — local ids for templates/settings/commands/variables. */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/**
 * Dotted plugin-local i18n keys (`templates.meeting.name`,
 * `settings.defaultTemplate.label`). Segments allow camelCase and underscores
 * since these are opaque map keys, not user-facing slugs.
 */
const I18N_KEY_RE = /^[A-Za-z0-9]+(?:[-._][A-Za-z0-9]+)*$/;
/**
 * A safe `luau` entry filename: a single path segment (letters/digits/`._-`)
 * ending in `.luau`, with no separators or `..`. The backend joins this onto
 * the plugin dir, so this is the traversal guard.
 */
const SAFE_ENTRY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*)\.luau$/;

const SETTING_TYPES = new Set<PluginSetting['type']>([
  'toggle',
  'select',
  'radio',
  'number',
  'slider',
  'color',
  'text',
  'folder',
  'tag'
]);
const VARIABLE_TYPES = new Set<PluginTemplateVariable['type']>([
  'text',
  'date',
  'select'
]);

/** Narrow, throwing on failure. */
function assertNonEmptyString(
  pluginId: string,
  value: unknown,
  path: string
): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PluginValidationError(
      pluginId,
      `${path} must be a non-empty string`
    );
  }
}

/** True for a syntactically valid, stable plugin id. */
export function isValidPluginId(id: unknown): id is string {
  return typeof id === 'string' && PLUGIN_ID_RE.test(id);
}

function assertSlug(pluginId: string, value: unknown, path: string): void {
  assertNonEmptyString(pluginId, value, path);
  if (!SLUG_RE.test(value)) {
    throw new PluginValidationError(
      pluginId,
      `${path} ("${value}") must be a lowercase kebab-case slug`
    );
  }
}

function assertI18nKey(pluginId: string, value: unknown, path: string): void {
  assertNonEmptyString(pluginId, value, path);
  if (!I18N_KEY_RE.test(value)) {
    throw new PluginValidationError(
      pluginId,
      `${path} ("${value}") is not a valid i18n key`
    );
  }
}

function validateVariable(
  pluginId: string,
  v: PluginTemplateVariable,
  path: string
): void {
  assertSlug(pluginId, v?.id, `${path}.id`);
  assertI18nKey(pluginId, v?.labelKey, `${path}.labelKey`);
  if (!VARIABLE_TYPES.has(v.type)) {
    throw new PluginValidationError(
      pluginId,
      `${path}.type ("${String(v.type)}") is not a supported variable type`
    );
  }
  if (v.type === 'select') {
    if (!Array.isArray(v.options) || v.options.length === 0) {
      throw new PluginValidationError(
        pluginId,
        `${path} is a select and must list at least one option`
      );
    }
  }
  if (v.default !== undefined && typeof v.default !== 'string') {
    throw new PluginValidationError(
      pluginId,
      `${path}.default must be a string`
    );
  }
}

function validateTemplate(
  pluginId: string,
  t: PluginNoteTemplateContribution,
  path: string
): void {
  assertSlug(pluginId, t?.id, `${path}.id`);
  assertI18nKey(pluginId, t?.labelKey, `${path}.labelKey`);
  if (t.descriptionKey !== undefined) {
    assertI18nKey(pluginId, t.descriptionKey, `${path}.descriptionKey`);
  }
  // MVP renders markdown only. Reject anything else loudly rather than
  // silently coercing — a mismatched kind would corrupt the note on save.
  if (t.noteKind !== 'markdown') {
    throw new PluginValidationError(
      pluginId,
      `${path}.noteKind ("${String(t.noteKind)}") is unsupported; only "markdown" is allowed`
    );
  }
  assertNonEmptyString(pluginId, t?.titleTemplate, `${path}.titleTemplate`);
  if (typeof t.bodyTemplate !== 'string') {
    throw new PluginValidationError(
      pluginId,
      `${path}.bodyTemplate must be a string`
    );
  }
  const seen = new Set<string>();
  for (const [i, v] of (t.variables ?? []).entries()) {
    validateVariable(pluginId, v, `${path}.variables[${i}]`);
    if (seen.has(v.id)) {
      throw new PluginValidationError(
        pluginId,
        `${path} declares variable "${v.id}" more than once`
      );
    }
    seen.add(v.id);
  }
}

function validateSetting(
  pluginId: string,
  s: PluginSetting,
  path: string
): void {
  assertSlug(pluginId, s?.id, `${path}.id`);
  assertI18nKey(pluginId, s?.labelKey, `${path}.labelKey`);
  if (s.descriptionKey !== undefined) {
    assertI18nKey(pluginId, s.descriptionKey, `${path}.descriptionKey`);
  }
  if (s.scope !== 'V' && s.scope !== 'D') {
    throw new PluginValidationError(
      pluginId,
      `${path}.scope must be "V" or "D"`
    );
  }
  if (!SETTING_TYPES.has(s.type)) {
    throw new PluginValidationError(
      pluginId,
      `${path}.type ("${String(s.type)}") is not a supported setting type`
    );
  }
  if (s.type === 'select' || s.type === 'radio') {
    if (!Array.isArray(s.options) || s.options.length === 0) {
      throw new PluginValidationError(
        pluginId,
        `${path} is a ${s.type} and must list at least one option`
      );
    }
  }
}

function validateSettingsContribution(
  pluginId: string,
  c: PluginSettingsContribution,
  path: string,
  seenSettingIds: Set<string>
): void {
  assertSlug(pluginId, c?.sectionId, `${path}.sectionId`);
  assertI18nKey(pluginId, c?.titleKey, `${path}.titleKey`);
  if (!Array.isArray(c.settings) || c.settings.length === 0) {
    throw new PluginValidationError(
      pluginId,
      `${path}.settings must be a non-empty array`
    );
  }
  for (const [i, s] of c.settings.entries()) {
    validateSetting(pluginId, s, `${path}.settings[${i}]`);
    // Setting ids are unique across the *whole plugin*, not just the section,
    // because they map onto a flat `plugins.<pluginId>.<settingId>` key space.
    if (seenSettingIds.has(s.id)) {
      throw new PluginValidationError(
        pluginId,
        `duplicate setting id "${s.id}" across the plugin's settings`
      );
    }
    seenSettingIds.add(s.id);
  }
}

function validateCommand(
  pluginId: string,
  c: PluginCommandContribution,
  path: string,
  templateIds: Set<string>
): void {
  assertSlug(pluginId, c?.id, `${path}.id`);
  assertI18nKey(pluginId, c?.labelKey, `${path}.labelKey`);
  if (
    c.defaultBinding !== undefined &&
    c.defaultBinding !== null &&
    typeof c.defaultBinding !== 'string'
  ) {
    throw new PluginValidationError(
      pluginId,
      `${path}.defaultBinding must be a string or null`
    );
  }
  if (c.action?.type !== 'createTemplateNote') {
    throw new PluginValidationError(
      pluginId,
      `${path}.action.type ("${String(c.action?.type)}") is not a supported command action`
    );
  }
  assertSlug(pluginId, c.action.templateId, `${path}.action.templateId`);
  if (!templateIds.has(c.action.templateId)) {
    throw new PluginValidationError(
      pluginId,
      `${path}.action references template "${c.action.templateId}", which this plugin does not contribute`
    );
  }
}

/**
 * Validate a manifest end-to-end. Returns the same object (typed) on success;
 * throws {@link PluginValidationError} on the first problem. Pure — it never
 * touches the registry, so the loader can validate before committing anything.
 */
export function validateManifest(input: unknown): PluginManifest {
  if (!input || typeof input !== 'object') {
    throw new PluginValidationError('<unknown>', 'manifest must be an object');
  }
  const m = input as Partial<PluginManifest>;
  if (!isValidPluginId(m.id)) {
    throw new PluginValidationError(
      typeof m.id === 'string' ? m.id : '<unknown>',
      `manifest.id ("${String(m.id)}") must be a stable, dotted, lowercase id (e.g. "com.author.plugin")`
    );
  }
  const pluginId = m.id;
  assertNonEmptyString(pluginId, m.name, 'manifest.name');
  assertNonEmptyString(pluginId, m.version, 'manifest.version');
  if (m.descriptionKey !== undefined) {
    assertI18nKey(pluginId, m.descriptionKey, 'manifest.descriptionKey');
  }

  // Two runtimes are understood: purely-declarative `manifest-only`, and `luau`
  // (a sandboxed backend script). Anything else is refused rather than loaded
  // half-supported.
  if (m.runtime !== 'manifest-only' && m.runtime !== 'luau') {
    throw new PluginValidationError(
      pluginId,
      `manifest.runtime ("${String(m.runtime)}") is unsupported; expected "manifest-only" or "luau"`
    );
  }
  if (m.runtime === 'luau') {
    assertNonEmptyString(pluginId, m.entry, 'manifest.entry');
    // The backend reads `<pluginDir>/<entry>`, so entry must be a safe relative
    // filename — no separators, no traversal, and a `.luau` extension.
    if (!SAFE_ENTRY_RE.test(m.entry)) {
      throw new PluginValidationError(
        pluginId,
        `manifest.entry ("${m.entry}") must be a plain .luau filename inside the plugin dir (no "/", "\\\\" or "..")`
      );
    }
  } else if (m.entry !== undefined) {
    // A declarative plugin has nothing to run; a stray entry is a mistake worth
    // surfacing rather than silently ignoring.
    throw new PluginValidationError(
      pluginId,
      'manifest.entry is only valid for runtime "luau"'
    );
  }

  if (!Array.isArray(m.permissions)) {
    throw new PluginValidationError(
      pluginId,
      'manifest.permissions must be an array'
    );
  }
  for (const p of m.permissions) {
    if (!KNOWN_PLUGIN_PERMISSIONS.includes(p as PluginPermission)) {
      throw new PluginValidationError(
        pluginId,
        `manifest.permissions lists unknown permission "${String(p)}"`
      );
    }
  }
  const permissions = new Set(m.permissions);

  const contributes = m.contributes;
  if (!contributes || typeof contributes !== 'object') {
    throw new PluginValidationError(
      pluginId,
      'manifest.contributes must be an object'
    );
  }

  // ---- Templates -------------------------------------------------------
  const templateIds = new Set<string>();
  const templates = contributes.noteTemplates ?? [];
  if (!Array.isArray(templates)) {
    throw new PluginValidationError(
      pluginId,
      'manifest.contributes.noteTemplates must be an array'
    );
  }
  for (const [i, t] of templates.entries()) {
    validateTemplate(pluginId, t, `noteTemplates[${i}]`);
    if (templateIds.has(t.id)) {
      throw new PluginValidationError(
        pluginId,
        `duplicate template id "${t.id}"`
      );
    }
    templateIds.add(t.id);
  }
  // Contributing a template means it shows up in create surfaces — that is the
  // capability `templates.contribute` grants. Require it explicitly so a
  // manifest can't quietly contribute more than it asked for.
  if (templates.length > 0 && !permissions.has('templates.contribute')) {
    throw new PluginValidationError(
      pluginId,
      'contributes noteTemplates but is missing the "templates.contribute" permission'
    );
  }

  // ---- Settings --------------------------------------------------------
  const settings = contributes.settings ?? [];
  if (!Array.isArray(settings)) {
    throw new PluginValidationError(
      pluginId,
      'manifest.contributes.settings must be an array'
    );
  }
  const seenSettingIds = new Set<string>();
  const seenSectionIds = new Set<string>();
  for (const [i, c] of settings.entries()) {
    validateSettingsContribution(pluginId, c, `settings[${i}]`, seenSettingIds);
    if (seenSectionIds.has(c.sectionId)) {
      throw new PluginValidationError(
        pluginId,
        `duplicate settings section id "${c.sectionId}"`
      );
    }
    seenSectionIds.add(c.sectionId);
  }

  // ---- Commands --------------------------------------------------------
  const commands = contributes.commands ?? [];
  if (!Array.isArray(commands)) {
    throw new PluginValidationError(
      pluginId,
      'manifest.contributes.commands must be an array'
    );
  }
  const seenCommandIds = new Set<string>();
  for (const [i, c] of commands.entries()) {
    validateCommand(pluginId, c, `commands[${i}]`, templateIds);
    if (seenCommandIds.has(c.id)) {
      throw new PluginValidationError(
        pluginId,
        `duplicate command id "${c.id}"`
      );
    }
    seenCommandIds.add(c.id);
  }

  // ---- i18n ------------------------------------------------------------
  const i18n = contributes.i18n;
  if (i18n !== undefined) {
    if (!i18n || typeof i18n !== 'object' || Array.isArray(i18n)) {
      throw new PluginValidationError(
        pluginId,
        'manifest.contributes.i18n must be an object keyed by locale'
      );
    }
    for (const [locale, dict] of Object.entries(i18n)) {
      if (!dict || typeof dict !== 'object' || Array.isArray(dict)) {
        throw new PluginValidationError(
          pluginId,
          `manifest.contributes.i18n["${locale}"] must be a string map`
        );
      }
      for (const [key, val] of Object.entries(dict)) {
        if (typeof val !== 'string') {
          throw new PluginValidationError(
            pluginId,
            `manifest.contributes.i18n["${locale}"]["${key}"] must be a string`
          );
        }
      }
    }
    // English is the guaranteed fallback locale (see plugin-i18n.ts); a plugin
    // that ships translations must include it.
    if (!('en' in i18n)) {
      throw new PluginValidationError(
        pluginId,
        'manifest.contributes.i18n must include an "en" bundle as the fallback locale'
      );
    }
  }

  return input as PluginManifest;
}

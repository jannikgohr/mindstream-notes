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
  PLUGIN_ARTIFACT_KINDS,
  PLUGIN_EDITOR_TOOLBAR_ITEMS,
  PLUGIN_NOTE_EXPORT_FORMATS,
  PLUGIN_PREVIEW_MIME_TYPES,
  PLUGIN_SOURCE_LANGUAGE_HOST_PROVIDERS,
  PLUGIN_TOOLBAR_LOCATIONS,
  PLUGIN_VIEW_MODE_PREVIEW_ICONS,
  type PluginDocSection,
  type PluginArtifactContribution,
  type PluginArtifactKind,
  type PluginManifest,
  type PluginNativeToolContribution,
  type PluginNativeServiceContribution,
  type PluginNoteExporterContribution,
  type PluginNoteExportFormat,
  type PluginNoteKindContribution,
  type PluginNoteKindRenderContribution,
  type PluginNoteTemplateContribution,
  type PluginPreviewMimeType,
  type PluginPermission,
  type PluginSetting,
  type PluginSourceLanguageContribution,
  type PluginSettingsContribution,
  type PluginCommandContribution,
  type PluginTemplateVariable,
  type PluginToolbarButton,
  type PluginToolbarLocation,
  type PluginSourceEditAction
} from './types';
import { KNOWN_NOTE_KINDS } from '$lib/api';

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
 * Safe scripted entry filenames: a single path segment (letters/digits/`._-`)
 * with a runtime-specific extension, no separators or `..`. The backend joins
 * this onto the plugin dir, so this is the traversal guard.
 */
const SAFE_LUAU_ENTRY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*)\.luau$/;
const SAFE_WASM_ENTRY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*)\.wasm$/;
/**
 * A safe relative documentation path: one or more `/`-joined segments ending in
 * `.md`. Each segment must start alphanumeric, so `..` (and any dot-leading
 * segment) is rejected, as are absolute paths and backslashes. The loader joins
 * this onto the plugin dir, so this is the traversal guard.
 */
const SAFE_DOC_PATH_RE =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*\.md$/;
/** Same shape as {@link SAFE_DOC_PATH_RE} but for a bundled `.svg` icon. */
const SAFE_SVG_PATH_RE =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*\.svg$/;
/** Same shape as {@link SAFE_DOC_PATH_RE} but for a bundled `.css` file. */
const SAFE_CSS_PATH_RE =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*\.css$/;
/** Artifact files are stored by basename inside the host-owned artifact dir. */
const SAFE_ARTIFACT_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Safe plugin-owned iframe entry module. */
const SAFE_WEBVIEW_ENTRY_RE =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*\.(?:mjs|js)$/;
/** Exact executable basename, resolved from PATH by the backend. */
const SAFE_BINARY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*(?:\.exe)?$/i;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
/** A Luau export name — a plain identifier looked up as `table[name]`. */
const EXPORT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SOURCE_LANGUAGE_RE = /^[A-Za-z0-9][A-Za-z0-9_+-]{0,31}$/;
const SOURCE_EXTENSION_RE = /^[A-Za-z0-9][A-Za-z0-9_+-]{0,15}$/;

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
const ARTIFACT_KINDS = new Set<PluginArtifactKind>(PLUGIN_ARTIFACT_KINDS);
const SOURCE_LANGUAGE_HOST_PROVIDERS = new Set<string>(
  PLUGIN_SOURCE_LANGUAGE_HOST_PROVIDERS
);
const NOTE_EXPORT_FORMATS = new Set<PluginNoteExportFormat>(
  PLUGIN_NOTE_EXPORT_FORMATS
);
const BUILT_IN_NOTE_KINDS = new Set<string>(KNOWN_NOTE_KINDS);

function isScriptedRuntime(
  runtime: PluginManifest['runtime'] | undefined
): boolean {
  return runtime === 'luau' || runtime === 'wasm';
}

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
  path: string,
  pluginNoteKindIds: Set<string>
): void {
  assertSlug(pluginId, t?.id, `${path}.id`);
  assertI18nKey(pluginId, t?.labelKey, `${path}.labelKey`);
  if (t.descriptionKey !== undefined) {
    assertI18nKey(pluginId, t.descriptionKey, `${path}.descriptionKey`);
  }
  if (
    typeof t.noteKind !== 'string' ||
    (t.noteKind !== 'markdown' && !pluginNoteKindIds.has(t.noteKind))
  ) {
    throw new PluginValidationError(
      pluginId,
      `${path}.noteKind ("${String(t.noteKind)}") must be "markdown" or a note kind declared by this plugin`
    );
  }
  if (t.render !== undefined) {
    // A backend-scripted template: the script produces title/body, so the static
    // templates are optional. Only the export name is validated here; that it
    // requires a scripted runtime is checked once in validateManifest.
    if (typeof t.render !== 'string' || !EXPORT_NAME_RE.test(t.render)) {
      throw new PluginValidationError(
        pluginId,
        `${path}.render must be a backend script export name (letters, digits, underscore)`
      );
    }
  } else {
    assertNonEmptyString(pluginId, t?.titleTemplate, `${path}.titleTemplate`);
    if (typeof t.bodyTemplate !== 'string') {
      throw new PluginValidationError(
        pluginId,
        `${path}.bodyTemplate must be a string`
      );
    }
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

export function pluginNoteKindId(
  pluginId: string,
  localKindId: string
): string {
  return `plugin.${pluginId}.${localKindId}`;
}

const PREVIEW_MIME_TYPES = new Set<PluginPreviewMimeType>(
  PLUGIN_PREVIEW_MIME_TYPES
);
const VIEW_MODE_PREVIEW_ICONS = new Set<string>(PLUGIN_VIEW_MODE_PREVIEW_ICONS);
const VIEW_MODE_LABEL_KEYS = new Set<string>(['wysiwyg', 'source', 'split']);

function validateNoteKindRender(
  pluginId: string,
  r: PluginNoteKindRenderContribution,
  path: string,
  artifactIds: Set<string>,
  nativeToolIds: Set<string>,
  nativeServiceIds: Set<string>,
  permissions: Set<PluginPermission>
): void {
  if (!r || typeof r !== 'object') {
    throw new PluginValidationError(pluginId, `${path} must be an object`);
  }
  if (typeof r.export !== 'string' || !EXPORT_NAME_RE.test(r.export)) {
    throw new PluginValidationError(
      pluginId,
      `${path}.export must be a backend script export name (letters, digits, underscore)`
    );
  }
  if (r.requiresNativeTool !== undefined) {
    if (typeof r.requiresNativeTool !== 'string') {
      throw new PluginValidationError(
        pluginId,
        `${path}.requiresNativeTool must be a string`
      );
    }
    if (!nativeToolIds.has(r.requiresNativeTool)) {
      throw new PluginValidationError(
        pluginId,
        `${path}.requiresNativeTool references undeclared native tool "${r.requiresNativeTool}"`
      );
    }
    if (!permissions.has('nativeTools.runDeclared')) {
      throw new PluginValidationError(
        pluginId,
        `${path}.requiresNativeTool requires the "nativeTools.runDeclared" permission`
      );
    }
  }
  if (r.previewService !== undefined) {
    if (typeof r.previewService !== 'string') {
      throw new PluginValidationError(
        pluginId,
        `${path}.previewService must be a string`
      );
    }
    if (!nativeServiceIds.has(r.previewService)) {
      throw new PluginValidationError(
        pluginId,
        `${path}.previewService references undeclared native service "${r.previewService}"`
      );
    }
    if (!permissions.has('nativeServices.run')) {
      throw new PluginValidationError(
        pluginId,
        `${path}.previewService requires the "nativeServices.run" permission`
      );
    }
  }
  if (r.previewMime !== undefined && !PREVIEW_MIME_TYPES.has(r.previewMime)) {
    throw new PluginValidationError(
      pluginId,
      `${path}.previewMime ("${String(r.previewMime)}") is not supported`
    );
  }
  if (
    r.debounceMs !== undefined &&
    (!Number.isFinite(r.debounceMs) || r.debounceMs < 0)
  ) {
    throw new PluginValidationError(
      pluginId,
      `${path}.debounceMs must be a non-negative finite number`
    );
  }
  if (r.webview !== undefined) {
    if (!r.webview || typeof r.webview !== 'object') {
      throw new PluginValidationError(
        pluginId,
        `${path}.webview must be an object`
      );
    }
    assertNonEmptyString(pluginId, r.webview.entry, `${path}.webview.entry`);
    if (!SAFE_WEBVIEW_ENTRY_RE.test(r.webview.entry)) {
      throw new PluginValidationError(
        pluginId,
        `${path}.webview.entry ("${r.webview.entry}") must be a safe relative .js/.mjs path inside the plugin dir`
      );
    }
    if (
      r.webview.allowEval !== undefined &&
      typeof r.webview.allowEval !== 'boolean'
    ) {
      throw new PluginValidationError(
        pluginId,
        `${path}.webview.allowEval must be a boolean`
      );
    }
    if (
      r.webview.allowEval === true &&
      !permissions.has('pluginWebviews.allowEval')
    ) {
      throw new PluginValidationError(
        pluginId,
        `${path}.webview.allowEval requires the "pluginWebviews.allowEval" permission`
      );
    }
    if (r.webview.artifacts !== undefined) {
      if (!Array.isArray(r.webview.artifacts)) {
        throw new PluginValidationError(
          pluginId,
          `${path}.webview.artifacts must be an array`
        );
      }
      const seen = new Set<string>();
      for (const [i, artifactId] of r.webview.artifacts.entries()) {
        assertSlug(pluginId, artifactId, `${path}.webview.artifacts[${i}]`);
        if (!artifactIds.has(artifactId)) {
          throw new PluginValidationError(
            pluginId,
            `${path}.webview.artifacts[${i}] references undeclared artifact "${artifactId}"`
          );
        }
        if (seen.has(artifactId)) {
          throw new PluginValidationError(
            pluginId,
            `${path}.webview.artifacts declares "${artifactId}" more than once`
          );
        }
        seen.add(artifactId);
      }
    }
  }
}

function validateNoteKind(
  pluginId: string,
  c: PluginNoteKindContribution,
  path: string,
  artifactIds: Set<string>,
  nativeToolIds: Set<string>,
  nativeServiceIds: Set<string>,
  permissions: Set<PluginPermission>
): string {
  assertSlug(pluginId, c?.id, `${path}.id`);
  assertI18nKey(pluginId, c?.labelKey, `${path}.labelKey`);
  if (c.descriptionKey !== undefined) {
    assertI18nKey(pluginId, c.descriptionKey, `${path}.descriptionKey`);
  }
  if (
    c.sourceLanguage !== undefined &&
    (typeof c.sourceLanguage !== 'string' ||
      !SOURCE_LANGUAGE_RE.test(c.sourceLanguage))
  ) {
    throw new PluginValidationError(
      pluginId,
      `${path}.sourceLanguage must be a short language identifier`
    );
  }
  if (
    c.viewModePreviewIcon !== undefined &&
    !VIEW_MODE_PREVIEW_ICONS.has(c.viewModePreviewIcon)
  ) {
    throw new PluginValidationError(
      pluginId,
      `${path}.viewModePreviewIcon ("${String(c.viewModePreviewIcon)}") is not supported`
    );
  }
  if (c.viewModeLabelKeys !== undefined) {
    if (!c.viewModeLabelKeys || typeof c.viewModeLabelKeys !== 'object') {
      throw new PluginValidationError(
        pluginId,
        `${path}.viewModeLabelKeys must be an object`
      );
    }
    for (const [mode, key] of Object.entries(c.viewModeLabelKeys)) {
      if (!VIEW_MODE_LABEL_KEYS.has(mode)) {
        throw new PluginValidationError(
          pluginId,
          `${path}.viewModeLabelKeys.${mode} is not a supported view mode`
        );
      }
      assertI18nKey(pluginId, key, `${path}.viewModeLabelKeys.${mode}`);
    }
  }
  if (c.defaultTitle !== undefined && typeof c.defaultTitle !== 'string') {
    throw new PluginValidationError(
      pluginId,
      `${path}.defaultTitle must be a string`
    );
  }
  if (c.defaultBody !== undefined && typeof c.defaultBody !== 'string') {
    throw new PluginValidationError(
      pluginId,
      `${path}.defaultBody must be a string`
    );
  }
  validateNoteKindRender(
    pluginId,
    c.render,
    `${path}.render`,
    artifactIds,
    nativeToolIds,
    nativeServiceIds,
    permissions
  );
  return pluginNoteKindId(pluginId, c.id);
}

function validateSourceLanguage(
  pluginId: string,
  language: PluginSourceLanguageContribution,
  path: string
): void {
  assertNonEmptyString(pluginId, language?.id, `${path}.id`);
  if (!SOURCE_LANGUAGE_RE.test(language.id)) {
    throw new PluginValidationError(
      pluginId,
      `${path}.id ("${language.id}") must be a short source language identifier`
    );
  }
  if (language.labelKey !== undefined) {
    assertI18nKey(pluginId, language.labelKey, `${path}.labelKey`);
  }
  if (language.aliases !== undefined) {
    if (!Array.isArray(language.aliases)) {
      throw new PluginValidationError(
        pluginId,
        `${path}.aliases must be an array`
      );
    }
    for (const [i, alias] of language.aliases.entries()) {
      assertNonEmptyString(pluginId, alias, `${path}.aliases[${i}]`);
      if (!SOURCE_LANGUAGE_RE.test(alias)) {
        throw new PluginValidationError(
          pluginId,
          `${path}.aliases[${i}] must be a short source language identifier`
        );
      }
    }
  }
  if (language.extensions !== undefined) {
    if (!Array.isArray(language.extensions)) {
      throw new PluginValidationError(
        pluginId,
        `${path}.extensions must be an array`
      );
    }
    for (const [i, extension] of language.extensions.entries()) {
      assertNonEmptyString(pluginId, extension, `${path}.extensions[${i}]`);
      if (!SOURCE_EXTENSION_RE.test(extension)) {
        throw new PluginValidationError(
          pluginId,
          `${path}.extensions[${i}] must be a short file extension without a dot`
        );
      }
    }
  }
  if (!language.provider || typeof language.provider !== 'object') {
    throw new PluginValidationError(
      pluginId,
      `${path}.provider must be an object`
    );
  }
  if (language.provider.type !== 'host') {
    throw new PluginValidationError(
      pluginId,
      `${path}.provider.type must be "host"`
    );
  }
  if (!SOURCE_LANGUAGE_HOST_PROVIDERS.has(language.provider.id)) {
    throw new PluginValidationError(
      pluginId,
      `${path}.provider.id ("${String(language.provider.id)}") is not a supported host source language provider`
    );
  }
}

function validateNoteExporter(
  pluginId: string,
  exporter: PluginNoteExporterContribution,
  path: string,
  pluginNoteKindIds: Set<string>,
  nativeToolIds: Set<string>,
  permissions: Set<PluginPermission>
): void {
  assertSlug(pluginId, exporter?.id, `${path}.id`);
  assertI18nKey(pluginId, exporter?.labelKey, `${path}.labelKey`);
  if (
    typeof exporter.noteKind !== 'string' ||
    (!BUILT_IN_NOTE_KINDS.has(exporter.noteKind) &&
      !pluginNoteKindIds.has(exporter.noteKind))
  ) {
    throw new PluginValidationError(
      pluginId,
      `${path}.noteKind ("${String(exporter.noteKind)}") must be a built-in note kind or a note kind declared by this plugin`
    );
  }
  if (!NOTE_EXPORT_FORMATS.has(exporter.format)) {
    throw new PluginValidationError(
      pluginId,
      `${path}.format ("${String(exporter.format)}") is not supported`
    );
  }
  if (
    typeof exporter.export !== 'string' ||
    !EXPORT_NAME_RE.test(exporter.export)
  ) {
    throw new PluginValidationError(
      pluginId,
      `${path}.export must be a backend script export name (letters, digits, underscore)`
    );
  }
  if (exporter.requiresNativeTool !== undefined) {
    if (typeof exporter.requiresNativeTool !== 'string') {
      throw new PluginValidationError(
        pluginId,
        `${path}.requiresNativeTool must be a string`
      );
    }
    if (!nativeToolIds.has(exporter.requiresNativeTool)) {
      throw new PluginValidationError(
        pluginId,
        `${path}.requiresNativeTool references undeclared native tool "${exporter.requiresNativeTool}"`
      );
    }
    if (!permissions.has('nativeTools.runDeclared')) {
      throw new PluginValidationError(
        pluginId,
        `${path}.requiresNativeTool requires the "nativeTools.runDeclared" permission`
      );
    }
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
  if (s.optionLabelKeys !== undefined) {
    if (!s.optionLabelKeys || typeof s.optionLabelKeys !== 'object') {
      throw new PluginValidationError(
        pluginId,
        `${path}.optionLabelKeys must be an object`
      );
    }
    const options = new Set(s.options ?? []);
    for (const [option, key] of Object.entries(s.optionLabelKeys)) {
      if (!options.has(option)) {
        throw new PluginValidationError(
          pluginId,
          `${path}.optionLabelKeys.${option} must match one of the setting options`
        );
      }
      assertI18nKey(pluginId, key, `${path}.optionLabelKeys.${option}`);
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

function validateArtifact(
  pluginId: string,
  a: PluginArtifactContribution,
  path: string
): void {
  assertSlug(pluginId, a?.id, `${path}.id`);
  if (!ARTIFACT_KINDS.has(a.kind)) {
    throw new PluginValidationError(
      pluginId,
      `${path}.kind ("${String(a.kind)}") is not supported`
    );
  }
  assertNonEmptyString(pluginId, a.version, `${path}.version`);
  assertNonEmptyString(pluginId, a.url, `${path}.url`);
  let parsed: URL;
  try {
    parsed = new URL(a.url);
  } catch {
    throw new PluginValidationError(
      pluginId,
      `${path}.url must be a valid URL`
    );
  }
  if (parsed.protocol !== 'https:') {
    throw new PluginValidationError(pluginId, `${path}.url must use HTTPS`);
  }
  assertNonEmptyString(pluginId, a.sha256, `${path}.sha256`);
  if (!SHA256_HEX_RE.test(a.sha256)) {
    throw new PluginValidationError(
      pluginId,
      `${path}.sha256 must be a lowercase SHA-256 hex digest`
    );
  }
  assertNonEmptyString(pluginId, a.fileName, `${path}.fileName`);
  if (!SAFE_ARTIFACT_FILE_RE.test(a.fileName)) {
    throw new PluginValidationError(
      pluginId,
      `${path}.fileName must be a safe filename without path separators`
    );
  }
  if (
    a.sizeBytes !== undefined &&
    (!Number.isFinite(a.sizeBytes) || a.sizeBytes <= 0)
  ) {
    throw new PluginValidationError(
      pluginId,
      `${path}.sizeBytes must be a positive finite number`
    );
  }
}

function validateNativeTool(
  pluginId: string,
  t: PluginNativeToolContribution,
  path: string
): void {
  assertSlug(pluginId, t?.id, `${path}.id`);
  assertNonEmptyString(pluginId, t.binaryName, `${path}.binaryName`);
  if (
    t.binaryName.includes('/') ||
    t.binaryName.includes('\\') ||
    t.binaryName.includes('..') ||
    !SAFE_BINARY_NAME_RE.test(t.binaryName)
  ) {
    throw new PluginValidationError(
      pluginId,
      `${path}.binaryName must be an executable basename resolved from PATH`
    );
  }
  if (t.descriptionKey !== undefined) {
    assertI18nKey(pluginId, t.descriptionKey, `${path}.descriptionKey`);
  }
}

// The iframe/control URL templates a preview service declares MUST target only
// loopback — a plugin must never be able to point the note's preview iframe at
// an arbitrary remote origin. The host substitutes the {…Port} placeholder.
const SAFE_SERVICE_DATA_URL_RE =
  /^http:\/\/(127\.0\.0\.1|localhost):\{dataPort\}(\/[\w\-./]*)?$/;
const SAFE_SERVICE_CONTROL_URL_RE =
  /^ws:\/\/(127\.0\.0\.1|localhost):\{controlPort\}(\/[\w\-./]*)?$/;
const SAFE_SERVICE_EXT_RE = /^[a-z0-9]{1,16}$/i;

function validateNativeService(
  pluginId: string,
  s: PluginNativeServiceContribution,
  path: string
): void {
  assertSlug(pluginId, s?.id, `${path}.id`);
  assertNonEmptyString(pluginId, s.binaryName, `${path}.binaryName`);
  if (
    s.binaryName.includes('/') ||
    s.binaryName.includes('\\') ||
    s.binaryName.includes('..') ||
    !SAFE_BINARY_NAME_RE.test(s.binaryName)
  ) {
    throw new PluginValidationError(
      pluginId,
      `${path}.binaryName must be an executable basename resolved from PATH`
    );
  }
  if (!Array.isArray(s.args)) {
    throw new PluginValidationError(pluginId, `${path}.args must be an array`);
  }
  for (const [i, arg] of s.args.entries()) {
    assertNonEmptyString(pluginId, arg, `${path}.args[${i}]`);
  }
  if (
    typeof s.dataUrl !== 'string' ||
    !SAFE_SERVICE_DATA_URL_RE.test(s.dataUrl)
  ) {
    throw new PluginValidationError(
      pluginId,
      `${path}.dataUrl must be a loopback http URL template like "http://127.0.0.1:{dataPort}"`
    );
  }
  if (
    typeof s.controlUrl !== 'string' ||
    !SAFE_SERVICE_CONTROL_URL_RE.test(s.controlUrl)
  ) {
    throw new PluginValidationError(
      pluginId,
      `${path}.controlUrl must be a loopback ws URL template like "ws://127.0.0.1:{controlPort}"`
    );
  }
  if (
    s.inputExtension !== undefined &&
    (typeof s.inputExtension !== 'string' ||
      !SAFE_SERVICE_EXT_RE.test(s.inputExtension))
  ) {
    throw new PluginValidationError(
      pluginId,
      `${path}.inputExtension must be a short alphanumeric extension`
    );
  }
  if (s.previewIframe !== undefined) {
    if (!s.previewIframe || typeof s.previewIframe !== 'object') {
      throw new PluginValidationError(
        pluginId,
        `${path}.previewIframe must be an object`
      );
    }
    if (
      s.previewIframe.mode !== 'direct' &&
      s.previewIframe.mode !== 'themed'
    ) {
      throw new PluginValidationError(
        pluginId,
        `${path}.previewIframe.mode must be "direct" or "themed"`
      );
    }
    if (s.previewIframe.css !== undefined) {
      if (s.previewIframe.mode !== 'themed') {
        throw new PluginValidationError(
          pluginId,
          `${path}.previewIframe.css is only allowed when mode is "themed"`
        );
      }
      assertNonEmptyString(
        pluginId,
        s.previewIframe.css,
        `${path}.previewIframe.css`
      );
      if (!SAFE_CSS_PATH_RE.test(s.previewIframe.css)) {
        throw new PluginValidationError(
          pluginId,
          `${path}.previewIframe.css ("${s.previewIframe.css}") must be a safe relative .css path inside the plugin dir`
        );
      }
    }
  }
  if (s.descriptionKey !== undefined) {
    assertI18nKey(pluginId, s.descriptionKey, `${path}.descriptionKey`);
  }
  if (
    s.protocol?.jumpEvent !== undefined &&
    typeof s.protocol.jumpEvent !== 'string'
  ) {
    throw new PluginValidationError(
      pluginId,
      `${path}.protocol.jumpEvent must be a string`
    );
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

function validateDocSection(
  pluginId: string,
  d: PluginDocSection,
  path: string
): void {
  assertNonEmptyString(pluginId, d?.file, `${path}.file`);
  if (!SAFE_DOC_PATH_RE.test(d.file)) {
    throw new PluginValidationError(
      pluginId,
      `${path}.file ("${d.file}") must be a safe relative .md path inside the plugin dir (no "..", absolute paths, or "\\\\")`
    );
  }
}

const TOOLBAR_LOCATIONS = new Set<PluginToolbarLocation>(
  PLUGIN_TOOLBAR_LOCATIONS
);
const EDITOR_TOOLBAR_ITEMS = new Set<string>(PLUGIN_EDITOR_TOOLBAR_ITEMS);

function validateToolbarButton(
  pluginId: string,
  b: PluginToolbarButton,
  path: string,
  pluginLocalNoteKindIds: Set<string>
): void {
  assertSlug(pluginId, b?.id, `${path}.id`);
  if (!TOOLBAR_LOCATIONS.has(b?.location)) {
    throw new PluginValidationError(
      pluginId,
      `${path}.location ("${String(b?.location)}") is not a supported toolbar location`
    );
  }
  if (b.location === 'note-editor') {
    const localNoteKind = b.noteKind;
    assertSlug(pluginId, localNoteKind, `${path}.noteKind`);
    if (!pluginLocalNoteKindIds.has(localNoteKind as string)) {
      throw new PluginValidationError(
        pluginId,
        `${path}.noteKind references "${localNoteKind}", which this plugin does not contribute`
      );
    }
  } else if (b.noteKind !== undefined) {
    throw new PluginValidationError(
      pluginId,
      `${path}.noteKind is only valid for note-editor toolbar buttons`
    );
  }
  if (b.toolbarItem !== undefined) {
    if (b.location !== 'note-editor') {
      throw new PluginValidationError(
        pluginId,
        `${path}.toolbarItem is only valid for note-editor toolbar buttons`
      );
    }
    if (!EDITOR_TOOLBAR_ITEMS.has(b.toolbarItem)) {
      throw new PluginValidationError(
        pluginId,
        `${path}.toolbarItem ("${String(b.toolbarItem)}") is not a supported editor toolbar item`
      );
    }
  }
  if (b.labelKey !== undefined) {
    assertI18nKey(pluginId, b.labelKey, `${path}.labelKey`);
  } else if (b.location !== 'note-editor' || b.toolbarItem === undefined) {
    throw new PluginValidationError(
      pluginId,
      `${path}.labelKey is required unless the note-editor button uses toolbarItem`
    );
  }
  if (b.icon !== undefined) {
    assertNonEmptyString(pluginId, b.icon, `${path}.icon`);
    if (!SAFE_SVG_PATH_RE.test(b.icon)) {
      throw new PluginValidationError(
        pluginId,
        `${path}.icon ("${b.icon}") must be a safe relative .svg path inside the plugin dir (no "..", absolute paths, or "\\\\")`
      );
    }
  } else if (b.location !== 'note-editor' || b.toolbarItem === undefined) {
    throw new PluginValidationError(
      pluginId,
      `${path}.icon is required unless the note-editor button uses toolbarItem`
    );
  }
  validateToolbarAction(pluginId, b?.action, `${path}.action`, b.location);
}

function validateToolbarAction(
  pluginId: string,
  rawAction: unknown,
  path: string,
  location: PluginToolbarLocation
): void {
  if (!rawAction || typeof rawAction !== 'object') {
    throw new PluginValidationError(pluginId, `${path} must be an object`);
  }
  const action = rawAction as PluginToolbarButton['action'];
  const actionType = (rawAction as Record<string, unknown>).type;
  if (
    actionType !== 'script' &&
    actionType !== 'insertText' &&
    actionType !== 'wrapSelection'
  ) {
    throw new PluginValidationError(
      pluginId,
      `${path}.type ("${String(actionType)}") is not a supported toolbar action`
    );
  }
  if (action.type === 'script') {
    if (
      typeof action.export !== 'string' ||
      !EXPORT_NAME_RE.test(action.export)
    ) {
      throw new PluginValidationError(
        pluginId,
        `${path}.export must be a backend script export name (letters, digits, underscore)`
      );
    }
    return;
  }
  if (location !== 'note-editor') {
    throw new PluginValidationError(
      pluginId,
      `${path}.type "${action.type}" is only valid for note-editor toolbar buttons`
    );
  }
  validateSourceEditAction(pluginId, action, path);
}

function validateSourceEditAction(
  pluginId: string,
  action: PluginSourceEditAction,
  path: string
): void {
  if (action.type === 'insertText') {
    if (typeof action.text !== 'string') {
      throw new PluginValidationError(
        pluginId,
        `${path}.text must be a string`
      );
    }
    if (
      action.cursorOffset !== undefined &&
      (!Number.isFinite(action.cursorOffset) || action.cursorOffset < 0)
    ) {
      throw new PluginValidationError(
        pluginId,
        `${path}.cursorOffset must be a non-negative finite number`
      );
    }
    return;
  }
  if (typeof action.before !== 'string' || typeof action.after !== 'string') {
    throw new PluginValidationError(
      pluginId,
      `${path}.before and ${path}.after must be strings`
    );
  }
  if (
    action.placeholder !== undefined &&
    typeof action.placeholder !== 'string'
  ) {
    throw new PluginValidationError(
      pluginId,
      `${path}.placeholder must be a string`
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
  if (m.author !== undefined) {
    assertNonEmptyString(pluginId, m.author, 'manifest.author');
  }
  if (
    m.enabledByDefault !== undefined &&
    typeof m.enabledByDefault !== 'boolean'
  ) {
    throw new PluginValidationError(
      pluginId,
      'manifest.enabledByDefault must be a boolean'
    );
  }
  if (m.descriptionKey !== undefined) {
    assertI18nKey(pluginId, m.descriptionKey, 'manifest.descriptionKey');
  }

  // Runtimes are explicit: purely-declarative `manifest-only`, or sandboxed
  // backend code in Luau/Wasmtime. Anything else is refused rather than loaded
  // half-supported.
  if (
    m.runtime !== 'manifest-only' &&
    m.runtime !== 'luau' &&
    m.runtime !== 'wasm'
  ) {
    throw new PluginValidationError(
      pluginId,
      `manifest.runtime ("${String(m.runtime)}") is unsupported; expected "manifest-only", "luau", or "wasm"`
    );
  }
  if (isScriptedRuntime(m.runtime)) {
    assertNonEmptyString(pluginId, m.entry, 'manifest.entry');
    // The backend reads `<pluginDir>/<entry>`, so entry must be a safe relative
    // filename — no separators, no traversal, and the runtime's extension.
    const safe =
      m.runtime === 'luau'
        ? SAFE_LUAU_ENTRY_RE.test(m.entry)
        : SAFE_WASM_ENTRY_RE.test(m.entry);
    if (!safe) {
      throw new PluginValidationError(
        pluginId,
        `manifest.entry ("${m.entry}") must be a plain ${m.runtime === 'luau' ? '.luau' : '.wasm'} filename inside the plugin dir (no "/", "\\\\" or "..")`
      );
    }
  } else if (m.entry !== undefined) {
    // A declarative plugin has nothing to run; a stray entry is a mistake worth
    // surfacing rather than silently ignoring.
    throw new PluginValidationError(
      pluginId,
      'manifest.entry is only valid for runtime "luau" or "wasm"'
    );
  }

  if (m.limits !== undefined) {
    if (!m.limits || typeof m.limits !== 'object' || Array.isArray(m.limits)) {
      throw new PluginValidationError(
        pluginId,
        'manifest.limits must be an object'
      );
    }
    const limits = m.limits as Record<string, unknown>;
    for (const key of ['memoryBytes', 'timeoutMs', 'fuel']) {
      if (limits[key] === undefined) continue;
      if (
        typeof limits[key] !== 'number' ||
        !Number.isFinite(limits[key]) ||
        limits[key] <= 0
      ) {
        throw new PluginValidationError(
          pluginId,
          `manifest.limits.${key} must be a positive finite number`
        );
      }
    }
    if (limits.fuel !== undefined && m.runtime !== 'wasm') {
      throw new PluginValidationError(
        pluginId,
        'manifest.limits.fuel is only valid for runtime "wasm"'
      );
    }
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

  // ---- Artifacts -------------------------------------------------------
  const artifacts = contributes.artifacts ?? [];
  if (!Array.isArray(artifacts)) {
    throw new PluginValidationError(
      pluginId,
      'manifest.contributes.artifacts must be an array'
    );
  }
  const seenArtifactIds = new Set<string>();
  for (const [i, artifact] of artifacts.entries()) {
    validateArtifact(pluginId, artifact, `artifacts[${i}]`);
    if (seenArtifactIds.has(artifact.id)) {
      throw new PluginValidationError(
        pluginId,
        `duplicate artifact id "${artifact.id}"`
      );
    }
    seenArtifactIds.add(artifact.id);
  }
  if (artifacts.length > 0 && !permissions.has('pluginArtifacts.download')) {
    throw new PluginValidationError(
      pluginId,
      'contributes artifacts but is missing the "pluginArtifacts.download" permission'
    );
  }

  // ---- Native tools ----------------------------------------------------
  const nativeTools = contributes.nativeTools ?? [];
  if (!Array.isArray(nativeTools)) {
    throw new PluginValidationError(
      pluginId,
      'manifest.contributes.nativeTools must be an array'
    );
  }
  const seenNativeToolIds = new Set<string>();
  for (const [i, tool] of nativeTools.entries()) {
    validateNativeTool(pluginId, tool, `nativeTools[${i}]`);
    if (seenNativeToolIds.has(tool.id)) {
      throw new PluginValidationError(
        pluginId,
        `duplicate native tool id "${tool.id}"`
      );
    }
    seenNativeToolIds.add(tool.id);
  }
  if (nativeTools.length > 0 && !permissions.has('nativeTools.runDeclared')) {
    throw new PluginValidationError(
      pluginId,
      'contributes nativeTools but is missing the "nativeTools.runDeclared" permission'
    );
  }

  // ---- Native services (long-lived preview servers) --------------------
  const nativeServices = contributes.nativeServices ?? [];
  if (!Array.isArray(nativeServices)) {
    throw new PluginValidationError(
      pluginId,
      'manifest.contributes.nativeServices must be an array'
    );
  }
  const seenNativeServiceIds = new Set<string>();
  for (const [i, service] of nativeServices.entries()) {
    validateNativeService(pluginId, service, `nativeServices[${i}]`);
    if (seenNativeServiceIds.has(service.id)) {
      throw new PluginValidationError(
        pluginId,
        `duplicate native service id "${service.id}"`
      );
    }
    seenNativeServiceIds.add(service.id);
  }
  if (nativeServices.length > 0 && !permissions.has('nativeServices.run')) {
    throw new PluginValidationError(
      pluginId,
      'contributes nativeServices but is missing the "nativeServices.run" permission'
    );
  }

  // ---- Source editor language modes -----------------------------------
  const sourceLanguages = contributes.sourceLanguages ?? [];
  if (!Array.isArray(sourceLanguages)) {
    throw new PluginValidationError(
      pluginId,
      'manifest.contributes.sourceLanguages must be an array'
    );
  }
  const seenSourceLanguageIds = new Set<string>();
  for (const [i, language] of sourceLanguages.entries()) {
    validateSourceLanguage(pluginId, language, `sourceLanguages[${i}]`);
    if (seenSourceLanguageIds.has(language.id)) {
      throw new PluginValidationError(
        pluginId,
        `duplicate source language id "${language.id}"`
      );
    }
    seenSourceLanguageIds.add(language.id);
  }

  // ---- Plugin note kinds ----------------------------------------------
  const noteKinds = contributes.noteKinds ?? [];
  if (!Array.isArray(noteKinds)) {
    throw new PluginValidationError(
      pluginId,
      'manifest.contributes.noteKinds must be an array'
    );
  }
  const seenNoteKindIds = new Set<string>();
  const pluginNoteKindIds = new Set<string>();
  for (const [i, c] of noteKinds.entries()) {
    const appKind = validateNoteKind(
      pluginId,
      c,
      `noteKinds[${i}]`,
      seenArtifactIds,
      seenNativeToolIds,
      seenNativeServiceIds,
      permissions
    );
    if (seenNoteKindIds.has(c.id)) {
      throw new PluginValidationError(
        pluginId,
        `duplicate note kind id "${c.id}"`
      );
    }
    seenNoteKindIds.add(c.id);
    pluginNoteKindIds.add(appKind);
  }
  if (noteKinds.length > 0 && !permissions.has('noteKinds.contribute')) {
    throw new PluginValidationError(
      pluginId,
      'contributes noteKinds but is missing the "noteKinds.contribute" permission'
    );
  }
  if (noteKinds.length > 0 && !isScriptedRuntime(m.runtime)) {
    throw new PluginValidationError(
      pluginId,
      'contributes noteKinds, which run backend render exports and require runtime "luau" or "wasm"'
    );
  }

  // ---- Note exporters --------------------------------------------------
  const noteExporters = contributes.noteExporters ?? [];
  if (!Array.isArray(noteExporters)) {
    throw new PluginValidationError(
      pluginId,
      'manifest.contributes.noteExporters must be an array'
    );
  }
  const seenNoteExporterIds = new Set<string>();
  for (const [i, exporter] of noteExporters.entries()) {
    validateNoteExporter(
      pluginId,
      exporter,
      `noteExporters[${i}]`,
      pluginNoteKindIds,
      seenNativeToolIds,
      permissions
    );
    if (seenNoteExporterIds.has(exporter.id)) {
      throw new PluginValidationError(
        pluginId,
        `duplicate note exporter id "${exporter.id}"`
      );
    }
    seenNoteExporterIds.add(exporter.id);
  }
  if (
    noteExporters.length > 0 &&
    !permissions.has('noteExporters.contribute')
  ) {
    throw new PluginValidationError(
      pluginId,
      'contributes noteExporters but is missing the "noteExporters.contribute" permission'
    );
  }
  if (noteExporters.length > 0 && !isScriptedRuntime(m.runtime)) {
    throw new PluginValidationError(
      pluginId,
      'contributes noteExporters, which run backend export functions and require runtime "luau" or "wasm"'
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
    validateTemplate(pluginId, t, `noteTemplates[${i}]`, pluginNoteKindIds);
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
  // A `render` macro is a backend script export, so it only makes sense on a
  // scripted plugin.
  if (
    templates.some((t) => t.render !== undefined) &&
    !isScriptedRuntime(m.runtime)
  ) {
    throw new PluginValidationError(
      pluginId,
      'a template "render" export requires runtime "luau" or "wasm"'
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

  // ---- Documentation ---------------------------------------------------
  const documentation = contributes.documentation ?? [];
  if (!Array.isArray(documentation)) {
    throw new PluginValidationError(
      pluginId,
      'manifest.contributes.documentation must be an array'
    );
  }
  const seenDocFiles = new Set<string>();
  for (const [i, d] of documentation.entries()) {
    validateDocSection(pluginId, d, `documentation[${i}]`);
    if (seenDocFiles.has(d.file)) {
      throw new PluginValidationError(
        pluginId,
        `duplicate documentation file "${d.file}"`
      );
    }
    seenDocFiles.add(d.file);
  }

  // ---- Toolbar buttons -------------------------------------------------
  const toolbar = contributes.toolbar ?? [];
  if (!Array.isArray(toolbar)) {
    throw new PluginValidationError(
      pluginId,
      'manifest.contributes.toolbar must be an array'
    );
  }
  const seenToolbarIds = new Set<string>();
  for (const [i, b] of toolbar.entries()) {
    validateToolbarButton(pluginId, b, `toolbar[${i}]`, seenNoteKindIds);
    if (seenToolbarIds.has(b.id)) {
      throw new PluginValidationError(
        pluginId,
        `duplicate toolbar button id "${b.id}"`
      );
    }
    seenToolbarIds.add(b.id);
  }
  // Script toolbar buttons run a backend export on click, so they require a
  // scripted runtime. Host-owned source edits are declarative and need none.
  if (
    toolbar.some((button) => button.action.type === 'script') &&
    !isScriptedRuntime(m.runtime)
  ) {
    throw new PluginValidationError(
      pluginId,
      'contributes toolbar buttons, which run a backend script export and require runtime "luau" or "wasm"'
    );
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

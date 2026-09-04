/**
 * Frontend plugin contribution registry.
 *
 * The app's built-in surfaces (note templates, settings schema, hotkey
 * catalogue, i18n bundles) stay **static** — this registry never mutates them.
 * Instead it holds the validated manifests of loaded plugins and exposes
 * *merged views* (`pluginTemplates()`, `pluginSettingsSections()`,
 * `pluginCommands()`, `pluginI18nBundles()`) that the built-in surfaces read
 * alongside their own static data. Keeping the two apart means a plugin can
 * never corrupt a core array, and turning a plugin off is just dropping it out
 * of the merged view.
 *
 * State is reactive (`$state`), so a create menu or settings dialog built
 * inside a `$derived`/`$effect` re-renders the moment a plugin is enabled,
 * disabled, or (un)registered.
 *
 * Only **enabled** plugins appear in the merged views. A plugin that failed to
 * load (bad manifest, integrity mismatch) is recorded via
 * {@link recordPluginLoadError} and contributes nothing — the app keeps
 * working exactly as if that plugin weren't installed.
 */

import { checksumManifest } from './canonical';
import { pluginNoteKindId, validateManifest } from './validation';
import { CONTRIBUTION_POINTS } from './types';
import type {
  PluginCommandContribution,
  PluginContributionPoint,
  PluginContributions,
  PluginI18nContribution,
  PluginManifest,
  PluginNoteExporterContribution,
  PluginNoteKindContribution,
  PluginNoteTemplateContribution,
  PluginSettingsContribution,
  PluginSourceLanguageContribution,
  PluginToolbarButton,
  PluginTextCheckerContribution,
  PluginToolbarLocation
} from './types';

/** A plugin known to the registry, with its runtime enabled state. */
export interface RegisteredPlugin {
  manifest: PluginManifest;
  /** Disabled plugins stay registered but contribute nothing. */
  enabled: boolean;
  /**
   * Canonical checksum of the manifest at registration time. The seam the
   * integrity flow compares against a stored accepted hash (see canonical.ts);
   * also surfaced in the plugin settings UI.
   */
  checksum: string;
}

/** A template paired with the plugin that owns it. */
export interface PluginTemplateRef {
  pluginId: string;
  template: PluginNoteTemplateContribution;
}

/** A note kind paired with the plugin that owns it. */
export interface PluginNoteKindRef {
  pluginId: string;
  noteKind: string;
  contribution: PluginNoteKindContribution;
}

/** A note exporter paired with the plugin that owns it. */
export interface PluginNoteExporterRef {
  pluginId: string;
  exporter: PluginNoteExporterContribution;
}

/** A settings subsection paired with its owning plugin. */
export interface PluginSettingsSectionRef {
  pluginId: string;
  contribution: PluginSettingsContribution;
}

/** A command paired with its owning plugin. */
export interface PluginCommandRef {
  pluginId: string;
  command: PluginCommandContribution;
}

/** A text checker paired with the plugin that owns it. */
export interface PluginTextCheckerRef {
  pluginId: string;
  checker: PluginTextCheckerContribution;
}

/** A toolbar button paired with its owning plugin. */
export interface PluginToolbarButtonRef {
  pluginId: string;
  button: PluginToolbarButton;
}

/** A source language contribution paired with the plugin that owns it. */
export interface PluginSourceLanguageRef {
  pluginId: string;
  language: PluginSourceLanguageContribution;
}

interface RegistryState {
  /** pluginId → registration. */
  plugins: Record<string, RegisteredPlugin>;
  /** pluginId → most recent load/validation error message. */
  loadErrors: Record<string, string>;
}

const state = $state<RegistryState>({ plugins: {}, loadErrors: {} });

/**
 * Validate and register (or replace) a plugin from its manifest. Throws
 * {@link import('./validation').PluginValidationError} if the manifest is
 * invalid — callers (the loader) catch it and route to
 * {@link recordPluginLoadError}. On success any previously recorded load error
 * for this id is cleared.
 */
export function registerPlugin(
  input: unknown,
  opts: { enabled?: boolean } = {}
): RegisteredPlugin {
  const manifest = validateManifest(input);
  const registration: RegisteredPlugin = {
    manifest,
    enabled: opts.enabled ?? true,
    checksum: checksumManifest(manifest)
  };
  state.plugins[manifest.id] = registration;
  delete state.loadErrors[manifest.id];
  return registration;
}

/** Remove a plugin entirely (its contributions disappear from every view). */
export function unregisterPlugin(pluginId: string): void {
  delete state.plugins[pluginId];
  delete state.loadErrors[pluginId];
}

/**
 * Flip a registered plugin on/off without unregistering it. No-op for an
 * unknown id. Disabled plugins vanish from the merged views but keep their
 * manifest so they can be re-enabled without re-loading.
 */
export function setPluginEnabled(pluginId: string, enabled: boolean): void {
  const plugin = state.plugins[pluginId];
  if (plugin) plugin.enabled = enabled;
}

/**
 * Record that a plugin failed to load. Used for manifests that never produced
 * a valid registration, so the settings UI can surface *why* a plugin the user
 * installed isn't contributing anything.
 */
export function recordPluginLoadError(pluginId: string, message: string): void {
  state.loadErrors[pluginId] = message;
}

/** The load error for a plugin, if its last load attempt failed. */
export function pluginLoadError(pluginId: string): string | undefined {
  return state.loadErrors[pluginId];
}

/** Every registered plugin, enabled or not, in registration order. */
export function allPlugins(): RegisteredPlugin[] {
  return Object.values(state.plugins);
}

/** Only the enabled plugins — the ones that contribute to the app. */
export function enabledPlugins(): RegisteredPlugin[] {
  return Object.values(state.plugins).filter((p) => p.enabled);
}

/** Look up a single registration by id. */
export function pluginById(pluginId: string): RegisteredPlugin | undefined {
  return state.plugins[pluginId];
}

/**
 * Every entry an enabled plugin contributes at `point`, paired with its owner.
 *
 * The single place the enabled + permission rules are applied. A point whose
 * {@link CONTRIBUTION_POINTS} entry names a capability is filtered by it here,
 * so revoking a grant removes the contribution from the app even though the
 * manifest still declares it — the manifest says what a plugin wants, the grant
 * says what it gets.
 */
function contributionsOf<K extends PluginContributionPoint>(
  point: K
): {
  pluginId: string;
  entry: NonNullable<PluginContributions[K]> extends readonly (infer E)[]
    ? E
    : never;
}[] {
  const required = CONTRIBUTION_POINTS[point];
  const out: { pluginId: string; entry: never }[] = [];
  for (const { manifest, enabled } of Object.values(state.plugins)) {
    if (!enabled) continue;
    if (required !== null && !manifest.permissions.includes(required)) continue;
    const declared = manifest.contributes[point];
    if (!Array.isArray(declared)) continue;
    for (const entry of declared) {
      out.push({ pluginId: manifest.id, entry: entry as never });
    }
  }
  return out;
}

/** Flattened templates contributed by all enabled plugins. */
export function pluginTemplates(): PluginTemplateRef[] {
  return contributionsOf('noteTemplates').map(({ pluginId, entry }) => ({
    pluginId,
    template: entry
  }));
}

/** Resolve a single enabled plugin's template by its plugin-local id. */
export function pluginTemplate(
  pluginId: string,
  templateId: string
): PluginTemplateRef | undefined {
  const plugin = state.plugins[pluginId];
  if (!plugin?.enabled) return undefined;
  const template = plugin.manifest.contributes.noteTemplates?.find(
    (t) => t.id === templateId
  );
  return template ? { pluginId, template } : undefined;
}

/** Flattened plugin-owned note kinds contributed by all enabled plugins. */
export function pluginNoteKinds(): PluginNoteKindRef[] {
  return contributionsOf('noteKinds').map(({ pluginId, entry }) => ({
    pluginId,
    noteKind: pluginNoteKindId(pluginId, entry.id),
    contribution: entry
  }));
}

/** Resolve an enabled plugin-owned note kind by its stored note_kind string. */
export function pluginNoteKind(
  noteKind: string | null | undefined
): PluginNoteKindRef | undefined {
  if (!noteKind) return undefined;
  for (const ref of pluginNoteKinds()) {
    if (ref.noteKind === noteKind) return ref;
  }
  return undefined;
}

/** Flattened note exporters contributed by all enabled plugins. */
export function pluginNoteExporters(): PluginNoteExporterRef[] {
  return contributionsOf('noteExporters').map(({ pluginId, entry }) => ({
    pluginId,
    exporter: entry
  }));
}

/** Plugin-contributed exporters that apply to a stored note_kind string. */
export function pluginNoteExportersForKind(
  noteKind: string | null | undefined
): PluginNoteExporterRef[] {
  if (!noteKind) return [];
  return pluginNoteExporters().filter(
    (ref) => ref.exporter.noteKind === noteKind
  );
}

/** Source editor language modes contributed by all enabled plugins. */
export function pluginSourceLanguages(): PluginSourceLanguageRef[] {
  return contributionsOf('sourceLanguages').map(({ pluginId, entry }) => ({
    pluginId,
    language: entry
  }));
}

/** Resolve a source language id or alias to the first enabled contribution. */
export function pluginSourceLanguage(
  id: string | null | undefined
): PluginSourceLanguageRef | undefined {
  if (!id) return undefined;
  for (const ref of pluginSourceLanguages()) {
    if (ref.language.id === id || ref.language.aliases?.includes(id)) {
      return ref;
    }
  }
  return undefined;
}

/** Flattened settings subsections contributed by all enabled plugins. */
export function pluginSettingsSections(): PluginSettingsSectionRef[] {
  return contributionsOf('settings').map(({ pluginId, entry }) => ({
    pluginId,
    contribution: entry
  }));
}

/** Flattened commands contributed by all enabled plugins. */
export function pluginCommands(): PluginCommandRef[] {
  return contributionsOf('commands').map(({ pluginId, entry }) => ({
    pluginId,
    command: entry
  }));
}

/**
 * Text checkers contributed by all enabled plugins.
 *
 * Filtered by `textCheckers.contribute` through {@link contributionsOf}: a
 * plugin can declare the contribution, but it only reaches the diagnostics bus
 * once that capability is granted — the checker sees the full text of every
 * note being edited.
 */
export function pluginTextCheckers(): PluginTextCheckerRef[] {
  return contributionsOf('textCheckers').map(({ pluginId, entry }) => ({
    pluginId,
    checker: entry
  }));
}

/** Toolbar buttons contributed by all enabled plugins for a given host surface,
 *  in registration order. */
export function pluginToolbarButtons(
  location: PluginToolbarLocation,
  opts: { noteKind?: string | null } = {}
): PluginToolbarButtonRef[] {
  return contributionsOf('toolbar')
    .filter(({ pluginId, entry }) => {
      if (entry.location !== location) return false;
      if (location !== 'note-editor' || !opts.noteKind) return true;
      return (
        !!entry.noteKind &&
        pluginNoteKindId(pluginId, entry.noteKind) === opts.noteKind
      );
    })
    .map(({ pluginId, entry }) => ({ pluginId, button: entry }));
}

/** i18n bundles of all enabled plugins, keyed by plugin id. */
export function pluginI18nBundles(): Record<string, PluginI18nContribution> {
  const out: Record<string, PluginI18nContribution> = {};
  for (const { manifest, enabled } of Object.values(state.plugins)) {
    if (!enabled) continue;
    if (manifest.contributes.i18n) out[manifest.id] = manifest.contributes.i18n;
  }
  return out;
}

/** Drop all registry state. Test-only; keeps suites isolated. */
export function resetPluginRegistry(): void {
  state.plugins = {};
  state.loadErrors = {};
}

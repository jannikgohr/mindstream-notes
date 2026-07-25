/**
 * Plugin registry API. Mirror of src-tauri/src/plugins/mod.rs.
 *
 * The frontend owns each plugin's manifest; this durable per-profile record
 * tracks install/enable state and the accepted manifest hash (the integrity
 * seam). Outside Tauri (browser / web-mobile) there is no backend, so the
 * fallbacks keep the app behaving as if every loaded plugin is simply enabled.
 */

import {
  assertBoolean,
  assertRecord,
  assertString,
  assertStringArray,
  assertVoid,
  optionalString,
  invokeOrFallback,
  TauriCommandName
} from './core';

export interface PluginRecord {
  id: string;
  version: string;
  enabled: boolean;
  /** `'builtin'` (trusted, ships in the app) or `'installed'`. */
  source: string;
  sourcePath: string | null;
  acceptedHash: string;
  grantedPermissions: string[];
  lastLoadError: string | null;
  installedAt: string;
  updatedAt: string;
}

/** A discovered plugin's reconciled record plus its raw manifest. */
export interface DiscoveredPluginView {
  record: PluginRecord;
  /** Parsed manifest JSON; validated frontend-side before registering. */
  manifest: unknown;
}

export function parsePluginRecord(value: unknown): PluginRecord {
  const raw = assertRecord(value, 'PluginRecord');
  return {
    id: assertString(raw.id, 'PluginRecord.id'),
    version: assertString(raw.version, 'PluginRecord.version'),
    enabled: assertBoolean(raw.enabled, 'PluginRecord.enabled'),
    source: assertString(raw.source, 'PluginRecord.source'),
    sourcePath: optionalString(raw.sourcePath, 'PluginRecord.sourcePath'),
    acceptedHash: assertString(raw.acceptedHash, 'PluginRecord.acceptedHash'),
    grantedPermissions: assertStringArray(
      raw.grantedPermissions,
      'PluginRecord.grantedPermissions'
    ),
    lastLoadError: optionalString(
      raw.lastLoadError,
      'PluginRecord.lastLoadError'
    ),
    installedAt: assertString(raw.installedAt, 'PluginRecord.installedAt'),
    updatedAt: assertString(raw.updatedAt, 'PluginRecord.updatedAt')
  };
}

function parsePluginRecords(value: unknown): PluginRecord[] {
  if (!Array.isArray(value)) throw new Error('PluginRecord[] must be an array');
  return value.map(parsePluginRecord);
}

function parseDiscoveredView(value: unknown): DiscoveredPluginView {
  const raw = assertRecord(value, 'DiscoveredPluginView');
  return { record: parsePluginRecord(raw.record), manifest: raw.manifest };
}

/**
 * Discover plugins from disk and reconcile them with the durable registry. The
 * backend owns discovery + trust (source is set from the load location), so
 * this is how the frontend learns which plugins to register. Outside Tauri the
 * fallback returns `[]` — the browser build loads its bundled core plugin
 * directly (see plugins/load.ts).
 */
export function pluginsDiscover(): Promise<DiscoveredPluginView[]> {
  return invokeOrFallback<DiscoveredPluginView[]>(
    TauriCommandName.PluginsDiscover,
    undefined,
    () => [],
    (value) => {
      if (!Array.isArray(value)) {
        throw new Error('DiscoveredPluginView[] must be an array');
      }
      return value.map(parseDiscoveredView);
    }
  );
}

export function pluginsList(): Promise<PluginRecord[]> {
  return invokeOrFallback<PluginRecord[]>(
    TauriCommandName.PluginsList,
    undefined,
    () => [],
    parsePluginRecords
  );
}

export function pluginsGet(id: string): Promise<PluginRecord | null> {
  return invokeOrFallback<PluginRecord | null>(
    TauriCommandName.PluginsGet,
    { id },
    () => null,
    (value) => (value === null ? null : parsePluginRecord(value))
  );
}

export function pluginsEnable(id: string): Promise<PluginRecord> {
  return invokeOrFallback<PluginRecord>(
    TauriCommandName.PluginsEnable,
    { id },
    () => {
      throw new Error('plugins_enable is unavailable outside Tauri');
    },
    parsePluginRecord
  );
}

export function pluginsDisable(id: string): Promise<PluginRecord> {
  return invokeOrFallback<PluginRecord>(
    TauriCommandName.PluginsDisable,
    { id },
    () => {
      throw new Error('plugins_disable is unavailable outside Tauri');
    },
    parsePluginRecord
  );
}

export function pluginsApprove(
  id: string,
  checksum: string
): Promise<PluginRecord> {
  return invokeOrFallback<PluginRecord>(
    TauriCommandName.PluginsApprove,
    { id, checksum },
    () => {
      throw new Error('plugins_approve is unavailable outside Tauri');
    },
    parsePluginRecord
  );
}

export function pluginsSetLoadError(
  id: string,
  error: string | null
): Promise<void> {
  return invokeOrFallback<void>(
    TauriCommandName.PluginsSetLoadError,
    { id, error },
    () => undefined,
    (value) => assertVoid(value, 'plugins_set_load_error response')
  );
}

export function pluginsRemove(id: string): Promise<void> {
  return invokeOrFallback<void>(
    TauriCommandName.PluginsRemove,
    { id },
    () => undefined,
    (value) => assertVoid(value, 'plugins_remove response')
  );
}

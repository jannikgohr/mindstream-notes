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

export interface UpsertPluginInput {
  id: string;
  version: string;
  /** Current canonical checksum of the manifest being loaded. */
  checksum: string;
  source: string;
  sourcePath?: string | null;
  permissions: string[];
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

/** Synthesize the record an upsert would produce, for the no-backend path. */
function fallbackRecord(input: UpsertPluginInput): PluginRecord {
  const now = new Date().toISOString();
  return {
    id: input.id,
    version: input.version,
    enabled: true,
    source: input.source,
    sourcePath: input.sourcePath ?? null,
    acceptedHash: input.checksum,
    grantedPermissions: input.permissions,
    lastLoadError: null,
    installedAt: now,
    updatedAt: now
  };
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

export function pluginsUpsert(input: UpsertPluginInput): Promise<PluginRecord> {
  return invokeOrFallback<PluginRecord>(
    TauriCommandName.PluginsUpsert,
    { input },
    () => fallbackRecord(input),
    parsePluginRecord
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

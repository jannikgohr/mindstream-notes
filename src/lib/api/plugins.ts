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
  assertNumber,
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
  /** SHA-256 fingerprint of the accepted signer's key, or null if unsigned. */
  signer: string | null;
  /** `'unsigned' | 'valid' | 'invalid'`. */
  signatureStatus: string;
  installedAt: string;
  updatedAt: string;
}

/** A discovered plugin's reconciled record plus its raw manifest. */
export interface DiscoveredPluginView {
  record: PluginRecord;
  /** Parsed manifest JSON; validated frontend-side before registering. */
  manifest: unknown;
}

export interface PluginArtifactStatus {
  pluginId: string;
  artifactId: string;
  kind: string;
  version: string;
  fileName: string;
  installed: boolean;
  bytes: number | null;
  sha256: string | null;
}

export interface PluginStorageEntry {
  path: string;
  isDir: boolean;
  bytes: number | null;
}

export interface PluginNativeToolStatus {
  pluginId: string;
  toolId: string;
  binaryName: string;
  available: boolean;
  path: string | null;
}

export interface PluginNativeToolOutput {
  statusCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
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
    signer: optionalString(raw.signer, 'PluginRecord.signer'),
    signatureStatus: assertString(
      raw.signatureStatus,
      'PluginRecord.signatureStatus'
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

function parseArtifactStatus(value: unknown): PluginArtifactStatus {
  const raw = assertRecord(value, 'PluginArtifactStatus');
  return {
    pluginId: assertString(raw.pluginId, 'PluginArtifactStatus.pluginId'),
    artifactId: assertString(raw.artifactId, 'PluginArtifactStatus.artifactId'),
    kind: assertString(raw.kind, 'PluginArtifactStatus.kind'),
    version: assertString(raw.version, 'PluginArtifactStatus.version'),
    fileName: assertString(raw.fileName, 'PluginArtifactStatus.fileName'),
    installed: assertBoolean(raw.installed, 'PluginArtifactStatus.installed'),
    bytes:
      raw.bytes === null || raw.bytes === undefined
        ? null
        : assertNumber(raw.bytes, 'PluginArtifactStatus.bytes'),
    sha256: optionalString(raw.sha256, 'PluginArtifactStatus.sha256')
  };
}

function parseArtifactStatuses(value: unknown): PluginArtifactStatus[] {
  if (!Array.isArray(value)) {
    throw new Error('PluginArtifactStatus[] must be an array');
  }
  return value.map(parseArtifactStatus);
}

function parseStorageEntry(value: unknown): PluginStorageEntry {
  const raw = assertRecord(value, 'PluginStorageEntry');
  return {
    path: assertString(raw.path, 'PluginStorageEntry.path'),
    isDir: assertBoolean(raw.isDir, 'PluginStorageEntry.isDir'),
    bytes:
      raw.bytes === null || raw.bytes === undefined
        ? null
        : assertNumber(raw.bytes, 'PluginStorageEntry.bytes')
  };
}

function parseStorageEntries(value: unknown): PluginStorageEntry[] {
  if (!Array.isArray(value)) {
    throw new Error('PluginStorageEntry[] must be an array');
  }
  return value.map(parseStorageEntry);
}

function parseNativeToolStatus(value: unknown): PluginNativeToolStatus {
  const raw = assertRecord(value, 'PluginNativeToolStatus');
  return {
    pluginId: assertString(raw.pluginId, 'PluginNativeToolStatus.pluginId'),
    toolId: assertString(raw.toolId, 'PluginNativeToolStatus.toolId'),
    binaryName: assertString(
      raw.binaryName,
      'PluginNativeToolStatus.binaryName'
    ),
    available: assertBoolean(raw.available, 'PluginNativeToolStatus.available'),
    path: optionalString(raw.path, 'PluginNativeToolStatus.path')
  };
}

function parseNativeToolOutput(value: unknown): PluginNativeToolOutput {
  const raw = assertRecord(value, 'PluginNativeToolOutput');
  return {
    statusCode:
      raw.statusCode === null || raw.statusCode === undefined
        ? null
        : assertNumber(raw.statusCode, 'PluginNativeToolOutput.statusCode'),
    stdout: assertString(raw.stdout, 'PluginNativeToolOutput.stdout'),
    stderr: assertString(raw.stderr, 'PluginNativeToolOutput.stderr'),
    timedOut: assertBoolean(raw.timedOut, 'PluginNativeToolOutput.timedOut')
  };
}

function parseByteArray(value: unknown): Uint8Array {
  if (!Array.isArray(value)) throw new Error('byte array must be an array');
  return new Uint8Array(
    value.map((byte, index) => {
      if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
        throw new Error(`byte array[${index}] must be a byte`);
      }
      return byte;
    })
  );
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

/**
 * Re-approve a gated plugin: the backend re-reads the plugin from disk and
 * accepts its current manifest hash + signer, then enables it. There is no
 * frontend-supplied checksum/signer — trust stays location-derived.
 */
export function pluginsApprove(id: string): Promise<PluginRecord> {
  return invokeOrFallback<PluginRecord>(
    TauriCommandName.PluginsApprove,
    { id },
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

/**
 * Read one of a plugin's bundled text assets (`.md` docs, `.svg` icons, …) from
 * its dir. Returns `null` when the file isn't present, so the caller can fall
 * back from a missing locale variant to the base file. Tauri-only: the browser
 * build serves bundled core-plugin assets from a build-time glob instead (see
 * plugin-files.ts), so the fallback here returns `null`.
 */
export function pluginsReadFile(
  id: string,
  file: string
): Promise<string | null> {
  return invokeOrFallback<string | null>(
    TauriCommandName.PluginsReadFile,
    { id, file },
    () => null,
    (value) =>
      value === null ? null : assertString(value, 'plugins_read_file')
  );
}

export function pluginsArtifactsStatus(
  id: string
): Promise<PluginArtifactStatus[]> {
  return invokeOrFallback<PluginArtifactStatus[]>(
    TauriCommandName.PluginsArtifactsStatus,
    { id },
    () => [],
    parseArtifactStatuses
  );
}

export function pluginsDownloadArtifact(
  id: string,
  artifactId: string
): Promise<PluginArtifactStatus> {
  return invokeOrFallback<PluginArtifactStatus>(
    TauriCommandName.PluginsDownloadArtifact,
    { id, artifactId },
    () => {
      throw new Error('plugins_download_artifact is unavailable outside Tauri');
    },
    parseArtifactStatus
  );
}

export function pluginsReadArtifact(
  id: string,
  artifactId: string
): Promise<Uint8Array> {
  return invokeOrFallback<Uint8Array>(
    TauriCommandName.PluginsReadArtifact,
    { id, artifactId },
    () => {
      throw new Error('plugins_read_artifact is unavailable outside Tauri');
    },
    parseByteArray
  );
}

export function pluginsStorageReadText(
  id: string,
  path: string
): Promise<string | null> {
  return invokeOrFallback<string | null>(
    TauriCommandName.PluginsStorageReadText,
    { id, path },
    () => null,
    (value) =>
      value === null ? null : assertString(value, 'plugins_storage_read_text')
  );
}

export function pluginsStorageWriteText(
  id: string,
  path: string,
  contents: string
): Promise<void> {
  return invokeOrFallback<void>(
    TauriCommandName.PluginsStorageWriteText,
    { id, path, contents },
    () => undefined,
    (value) => assertVoid(value, 'plugins_storage_write_text response')
  );
}

export function pluginsStorageDelete(id: string, path: string): Promise<void> {
  return invokeOrFallback<void>(
    TauriCommandName.PluginsStorageDelete,
    { id, path },
    () => undefined,
    (value) => assertVoid(value, 'plugins_storage_delete response')
  );
}

export function pluginsStorageList(
  id: string,
  path = ''
): Promise<PluginStorageEntry[]> {
  return invokeOrFallback<PluginStorageEntry[]>(
    TauriCommandName.PluginsStorageList,
    { id, path },
    () => [],
    parseStorageEntries
  );
}

export function pluginsNativeToolStatus(
  id: string,
  toolId: string
): Promise<PluginNativeToolStatus> {
  return invokeOrFallback<PluginNativeToolStatus>(
    TauriCommandName.PluginsNativeToolStatus,
    { id, toolId },
    () => {
      throw new Error(
        'plugins_native_tool_status is unavailable outside Tauri'
      );
    },
    parseNativeToolStatus
  );
}

export function pluginsRunNativeTool(
  id: string,
  toolId: string,
  args: string[],
  stdin?: string | null,
  timeoutMs?: number | null
): Promise<PluginNativeToolOutput> {
  return invokeOrFallback<PluginNativeToolOutput>(
    TauriCommandName.PluginsRunNativeTool,
    { id, toolId, args, stdin: stdin ?? null, timeoutMs: timeoutMs ?? null },
    () => {
      throw new Error('plugins_run_native_tool is unavailable outside Tauri');
    },
    parseNativeToolOutput
  );
}

export interface PreviewServiceHandle {
  sessionKey: string;
  dataUrl: string;
  controlUrl: string;
  proxyUrl: string | null;
}

export interface PreviewServiceStatus {
  serviceId: string;
  binaryName: string;
  available: boolean;
  path: string | null;
}

function parsePreviewServiceStatus(value: unknown): PreviewServiceStatus {
  const raw = assertRecord(value, 'PreviewServiceStatus');
  return {
    serviceId: assertString(raw.serviceId, 'PreviewServiceStatus.serviceId'),
    binaryName: assertString(raw.binaryName, 'PreviewServiceStatus.binaryName'),
    available: assertBoolean(raw.available, 'PreviewServiceStatus.available'),
    path: optionalString(raw.path, 'PreviewServiceStatus.path')
  };
}

/** Whether a declared preview service's binary resolves on PATH. */
export function pluginsNativeServiceStatus(
  id: string,
  serviceId: string
): Promise<PreviewServiceStatus> {
  return invokeOrFallback<PreviewServiceStatus>(
    TauriCommandName.PluginsNativeServiceStatus,
    { id, serviceId },
    () => {
      throw new Error(
        'plugins_native_service_status is unavailable outside Tauri'
      );
    },
    parsePreviewServiceStatus
  );
}

function parsePreviewServiceHandle(value: unknown): PreviewServiceHandle {
  const raw = assertRecord(value, 'PreviewServiceHandle');
  return {
    sessionKey: assertString(raw.sessionKey, 'PreviewServiceHandle.sessionKey'),
    dataUrl: assertString(raw.dataUrl, 'PreviewServiceHandle.dataUrl'),
    controlUrl: assertString(raw.controlUrl, 'PreviewServiceHandle.controlUrl'),
    proxyUrl: optionalString(raw.proxyUrl, 'PreviewServiceHandle.proxyUrl')
  };
}

/**
 * Start (or restart) a plugin's long-lived preview server for one note session.
 * Desktop/Tauri-only — the server is a real local process.
 */
export function pluginsPreviewStart(
  id: string,
  serviceId: string,
  sessionKey: string,
  input: string,
  settings: Record<string, string> = {}
): Promise<PreviewServiceHandle> {
  return invokeOrFallback<PreviewServiceHandle>(
    TauriCommandName.PluginsPreviewStart,
    { id, serviceId, sessionKey, input, settings },
    () => {
      throw new Error('plugins_preview_start is unavailable outside Tauri');
    },
    parsePreviewServiceHandle
  );
}

/** Rewrite a running preview session's source so the server recompiles. */
export function pluginsPreviewUpdate(
  sessionKey: string,
  input: string
): Promise<void> {
  return invokeOrFallback<void>(
    TauriCommandName.PluginsPreviewUpdate,
    { sessionKey, input },
    () => undefined,
    (value) => assertVoid(value, 'plugins_preview_update response')
  );
}

/** Stop and reap a running preview session. */
export function pluginsPreviewStop(sessionKey: string): Promise<void> {
  return invokeOrFallback<void>(
    TauriCommandName.PluginsPreviewStop,
    { sessionKey },
    () => undefined,
    (value) => assertVoid(value, 'plugins_preview_stop response')
  );
}

/**
 * Run an enabled `luau` plugin's exported function in the sandboxed backend
 * runtime and return its JSON result. There is no browser fallback: scripted
 * plugins require the Rust runtime, so outside Tauri this rejects rather than
 * pretending to run code.
 */
export function pluginsRunScript(
  id: string,
  exportName: string,
  input: unknown
): Promise<unknown> {
  return invokeOrFallback<unknown>(
    TauriCommandName.PluginsRunScript,
    { id, export: exportName, input },
    () => {
      throw new Error('scripted (luau) plugins are only available in the app');
    },
    (value) => value
  );
}

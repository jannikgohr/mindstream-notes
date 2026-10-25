// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./wit.d.ts" />
/**
 * The Mindstream plugin SDK for TypeScript.
 *
 * A plugin is one module that exports `invoke`, built with
 * {@link definePlugin}:
 *
 * ```ts
 * import { definePlugin, notes } from '@mindstream/plugin-sdk';
 *
 * export const invoke = definePlugin({
 *   countNotes: () => ({ effect: 'toast', message: `${notes.all().length} notes` })
 * });
 * ```
 *
 * `mindstream-plugin build` turns it into a WebAssembly component. Inside it
 * there is no filesystem, network or Node API: the host interfaces below are
 * the whole of what a plugin can reach, each behind the permission its
 * manifest asked for.
 */

import * as clockHost from 'mindstream:plugin/clock@0.1.0';
import * as markdownHost from 'mindstream:plugin/markdown@0.1.0';
import * as nativeToolsHost from 'mindstream:plugin/native-tools@0.1.0';
import * as notesHost from 'mindstream:plugin/notes@0.1.0';
import * as runtimeHost from 'mindstream:plugin/runtime@0.1.0';
import * as storageHost from 'mindstream:plugin/storage@0.1.0';
import { installGlobals } from './globals';

export type * from './types';
export { batch, HostBatchError } from './batch';
export type {
  BatchCommand,
  BatchReply,
  BatchFailurePhase,
  BatchOperation,
  BatchText
} from './batch';

installGlobals();

/** A permission a manifest can ask for. */
export type Permission =
  | 'notes.read'
  | 'notes.create'
  | 'textCheckers.contribute'
  | 'pluginArtifacts.download'
  | 'pluginStorage.read'
  | 'pluginStorage.write'
  | 'nativeTools.runDeclared'
  | 'nativeServices.run';

/** Why a host call refused or failed. */
export type HostErrorKind = 'denied' | 'invalid' | 'unavailable' | 'failed';

/**
 * Thrown by a host call the host refused or could not complete. A plugin may
 * catch it. Running out of time is not one of these: the host stops the
 * plugin outright.
 */
export class HostError extends Error {
  readonly kind: HostErrorKind;
  /** For `denied`, the permission that was missing. */
  readonly detail: string;

  constructor(kind: HostErrorKind, detail: string) {
    super(kind === 'denied' ? `permission ${detail} was not granted` : detail);
    this.name = 'HostError';
    this.kind = kind;
    this.detail = detail;
  }
}

function hostCall<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    const payload = (error as { payload?: { tag?: string; val?: unknown } })
      ?.payload;
    if (payload && typeof payload.tag === 'string') {
      throw new HostError(payload.tag as HostErrorKind, String(payload.val));
    }
    throw error;
  }
}

// ---- Always available ------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Write a line to the app log. `console.log` and friends also land here. */
export function log(message: string, level: LogLevel = 'info'): void {
  runtimeHost.log(level, message);
}

/** A fresh random v4 UUID. */
export function uuid(): string {
  return runtimeHost.uuid();
}

/** Secure random bytes from the host, at most 65536 per call. */
export function randomBytes(length: number): Uint8Array {
  return new Uint8Array(runtimeHost.randomBytes(length));
}

/** Whether the user granted `permission`. */
export function hasPermission(permission: Permission): boolean {
  return runtimeHost.hasPermission(permission);
}

export type TimeUnit = clockHost.TimeUnit;

/** A point in time: an RFC 3339 string, a `Date`, or epoch milliseconds. */
export type Timestamp = string | Date | number;

function rfc3339(timestamp: Timestamp): string {
  if (typeof timestamp === 'string') return timestamp;
  return new Date(
    typeof timestamp === 'number' ? timestamp : timestamp.getTime()
  ).toISOString();
}

/**
 * Dates using the host's local-time rules. The default SDK has no timezone
 * database; a JavaScript `Date` inside a plugin is UTC. A guest may instead
 * bundle its own calendar/timezone library when that tradeoff is appropriate.
 */
export const clock = {
  /** Milliseconds since the Unix epoch. */
  nowMillis(): number {
    return clockHost.nowMillis();
  },

  /** The current local time as RFC 3339 with its UTC offset. */
  now(): string {
    return clockHost.now();
  },

  /**
   * Format with moment-style tokens (`YYYY-MM-DD`, `HH:mm`, `dddd`,
   * `[literal]`, ...) in local time. `locale` picks month and weekday names:
   * `de` for German, anything else English.
   */
  format(
    timestamp: Timestamp,
    pattern = 'YYYY-MM-DD',
    locale?: string
  ): string {
    return hostCall(() =>
      clockHost.format(rfc3339(timestamp), pattern, locale ?? null)
    );
  },

  /** Shift by whole units in local time. Returns RFC 3339. */
  add(timestamp: Timestamp, amount: number, unit: TimeUnit): string {
    return hostCall(() => clockHost.add(rfc3339(timestamp), amount, unit));
  },

  /** Today (or `offsetDays` from today), formatted. */
  today(pattern = 'YYYY-MM-DD', offsetDays = 0, locale?: string): string {
    const shifted = offsetDays
      ? clock.add(clock.now(), offsetDays, 'day')
      : clock.now();
    return clock.format(shifted, pattern, locale);
  }
};

export const markdown = {
  /**
   * A `---` delimited YAML frontmatter block. Strings are quoted and
   * escaped; arrays become one `- item` line each.
   */
  frontmatter(fields: Record<string, unknown>): string {
    return hostCall(() => markdownHost.frontmatter(JSON.stringify(fields)));
  }
};

// ---- notes.read ------------------------------------------------------------

/** Read-only metadata for one note. Never the body. */
export interface NoteMeta {
  id: string;
  title: string;
  tags: string[];
  /** `markdown`, `kanban`, or a plugin-owned `plugin.<id>.<kind>`. */
  kind: string;
  folderId: string | null;
  /** Folder names from the root down, joined with ` / `. */
  folderPath: string;
  created: string;
  modified: string;
}

/** The vault's note metadata. Every call needs `notes.read`. */
export const notes = {
  /** Every note that is not in the trash. */
  all(): NoteMeta[] {
    return hostCall(() => notesHost.all());
  },

  get(id: string): NoteMeta | undefined {
    return hostCall(() => notesHost.get(id)) ?? undefined;
  }
};

// ---- pluginStorage.read / .write --------------------------------------------

export interface StorageEntry {
  name: string;
  isDir: boolean;
  sizeBytes: number;
}

/**
 * The plugin's own data directory. Paths are relative and `/` separated;
 * `..`, absolute paths and symlinks out are refused. Files hold at most
 * 4 MiB. Reading and listing need `pluginStorage.read`, writing and
 * deleting `pluginStorage.write`.
 */
export const storage = {
  /** The file as text, or `undefined` when it does not exist. */
  read(path: string): string | undefined {
    return hostCall(() => storageHost.read(path)) ?? undefined;
  },

  /** A JSON file, parsed, or `undefined` when it does not exist. */
  readJson<T = unknown>(path: string): T | undefined {
    const text = storage.read(path);
    return text === undefined ? undefined : (JSON.parse(text) as T);
  },

  /** A directory's entries, sorted by name. `''` is the root. */
  list(path = ''): StorageEntry[] {
    return hostCall(() => storageHost.list(path)).map((entry) => ({
      name: entry.name,
      isDir: entry.isDir,
      sizeBytes: Number(entry.sizeBytes)
    }));
  },

  /** Write a file, creating parent directories. */
  write(path: string, contents: string): void {
    hostCall(() => storageHost.write(path, contents));
  },

  writeJson(path: string, value: unknown): void {
    storage.write(path, JSON.stringify(value));
  },

  /** Remove a file or a directory tree. Removing what is not there succeeds. */
  delete(path: string): void {
    hostCall(() => storageHost.delete(path));
  }
};

// ---- nativeTools.runDeclared ------------------------------------------------

export interface RunOptions {
  args?: string[];
  stdin?: string;
  /** Clamped by the host to 100..30000 ms and to the call's remaining time. */
  timeoutMs?: number;
  /** For binary output: `stdout` is then empty and `stdoutBase64` is set. */
  outputBase64?: boolean;
}

export interface RunOutput {
  /** Exit code, or `null` when a signal ended the process. */
  statusCode: number | null;
  stdout: string;
  stdoutBase64?: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * The binaries declared under `contributes.nativeTools`, run directly and
 * never through a shell. Desktop only: on mobile `available` is always
 * false, so check it before `run`. Every call needs `nativeTools.runDeclared`.
 */
export const nativeTools = {
  available(toolId: string): boolean {
    return hostCall(() => nativeToolsHost.available(toolId));
  },

  run(toolId: string, options: RunOptions = {}): RunOutput {
    const output = hostCall(() =>
      nativeToolsHost.run(toolId, {
        args: options.args ?? [],
        stdin: options.stdin ?? null,
        timeoutMs: options.timeoutMs ?? null,
        outputBase64: options.outputBase64 ?? false
      })
    );
    return {
      statusCode: output.statusCode,
      stdout: output.stdout,
      stdoutBase64: output.stdoutBase64 ?? undefined,
      stderr: output.stderr,
      timedOut: output.timedOut
    };
  }
};

// ---- Exports -----------------------------------------------------------------

/**
 * One export: takes the call's input, returns a JSON-serializable result.
 * It runs synchronously. A returned promise is refused, because a plugin call
 * has no event loop to settle it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Handler = (input: any) => unknown;

/**
 * The name the SDK's tooling uses to ask a component which exports it has.
 * Not a valid manifest export name, so the app can never call it.
 */
export const EXPORTS_PROBE = '$exports';

function asError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === 'string' ? value : JSON.stringify(value));
}

/**
 * Turn a map of exports into the component's `invoke` function. Export it
 * from the plugin's entry module as `invoke`:
 *
 * ```ts
 * export const invoke = definePlugin({ renderDocument, exportDocument });
 * ```
 *
 * Whatever a handler throws becomes the error the app shows for the call.
 */
export function definePlugin(
  handlers: Record<string, Handler>
): (exportName: string, input: string) => string {
  const names = Object.keys(handlers).sort();
  return (exportName: string, input: string): string => {
    if (exportName === EXPORTS_PROBE) return JSON.stringify(names);
    const handler = Object.prototype.hasOwnProperty.call(handlers, exportName)
      ? handlers[exportName]
      : undefined;
    if (typeof handler !== 'function') {
      throw new Error(
        `this plugin has no export "${exportName}" (it has: ${names.join(', ') || 'none'})`
      );
    }
    try {
      const result = handler(JSON.parse(input));
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        throw new Error(
          `export "${exportName}" returned a promise; plugin exports must return their result directly`
        );
      }
      return JSON.stringify(result ?? null);
    } catch (error) {
      // Anything other than an Error would end the call as a crash rather
      // than as an error the app can show.
      throw asError(error);
    }
  };
}

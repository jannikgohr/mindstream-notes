/** A note in the test vault. Only `id` and `title` are required. */
export interface TestNote {
  id: string;
  title: string;
  tags?: string[];
  kind?: string;
  folderId?: string | null;
  folderPath?: string;
  created?: string;
  modified?: string;
}

export interface TestToolOutput {
  statusCode?: number | null;
  stdout?: string | Uint8Array;
  stderr?: string;
  timedOut?: boolean;
}

export interface HostOptions {
  /** What the user granted. Nothing by default. */
  permissions?: string[];
  notes?: TestNote[];
  /** `ctx.settings` for every call. */
  settings?: Record<string, unknown>;
  /** `ctx.folders` for every call that holds `notes.read`. */
  folders?: { id: string; name: string; parentId: string | null }[];
  /** A fixed host clock. The real clock when absent. */
  now?: string | number | Date;
  /** `UTC` to format dates in UTC instead of Node's local time zone. */
  timeZone?: 'UTC';
  /** `ctx.locale` for every call. */
  locale?: string;
  /** Pre-filled storage, path to contents. Shared and updated by calls. */
  storage?: Map<string, string>;
  /** `false` to test a host with no data directory. */
  dataDirectory?: boolean;
  /**
   * Declared native tools by manifest id. A function runs in place of the
   * binary; `null` is a tool that is declared but not installed.
   */
  tools?: Record<
    string,
    | ((run: {
        args: string[];
        stdin?: string;
        timeoutMs?: number;
      }) => TestToolOutput)
    | null
  >;
}

export interface LoadedPlugin {
  /**
   * Run one export. As in the app, the backend's `settings`, `folders`
   * (empty without `notes.read`) and `now` are merged over `input`, and
   * `locale` and `activeNoteId` default unless `input` sets them.
   */
  call<T = unknown>(exportName: string, input?: unknown): Promise<T>;
  /** The export names the plugin defines. */
  exports(): Promise<string[]>;
  logs: { level: string; message: string }[];
  storage: Map<string, string>;
}

export declare class PluginCallError extends Error {}
export declare const EXPORTS_PROBE: '$exports';
export declare function loadPlugin(
  component: string | Uint8Array,
  options?: HostOptions
): Promise<LoadedPlugin>;

// Generated from plugin-sdk/wit by scripts/generate-types.mjs.
// QuickJS uses null for options and number for i64/u64. Do not edit by hand.

declare module 'mindstream:plugin/batch@0.1.0' {
  /**
   * At most 128 commands, 1024 text inputs, 1 MiB literal data, 8 MiB cumulative
   * result data. Whole-plan reference/size validation precedes execution.
   * Ordered, stop on first error, no rollback of completed side effects.
   * Cancellation/deadline trap the guest, including between operations.
   * An empty batch succeeds. Plan-wide errors also use index 0.
   */
  export function execute(commands: Array<Command>): Array<Reply>;
  export type Error = import('mindstream:plugin/types@0.1.0').Error;
  export type NoteMeta = import('mindstream:plugin/types@0.1.0').NoteMeta;
  export type LogLevel = import('mindstream:plugin/runtime@0.1.0').LogLevel;
  export type TimeUnit = import('mindstream:plugin/clock@0.1.0').TimeUnit;
  export type Entry = import('mindstream:plugin/storage@0.1.0').Entry;
  export type RunOutput =
    import('mindstream:plugin/native-tools@0.1.0').RunOutput;
  /**
   * A literal or an earlier text/available optional-text result.
   * References are indices into commands, including commands not kept.
   */
  export type TextInput = TextInputLiteral | TextInputPrevious;
  export interface TextInputLiteral {
    tag: 'literal';
    val: string;
  }
  export interface TextInputPrevious {
    tag: 'previous';
    val: number;
  }
  export interface LogRequest {
    level: LogLevel;
    message: TextInput;
  }
  export interface FormatRequest {
    timestamp: TextInput;
    pattern: TextInput;
    locale: TextInput | null;
  }
  export interface AddRequest {
    timestamp: TextInput;
    amount: number;
    unit: TimeUnit;
  }
  export interface WriteRequest {
    path: TextInput;
    contents: TextInput;
  }
  export interface ToolRequest {
    toolId: TextInput;
    args: Array<TextInput>;
    stdin: TextInput | null;
    timeoutMs: number | null;
    outputBase64: boolean;
  }
  export type Operation =
    | OperationLog
    | OperationUuid
    | OperationRandomBytes
    | OperationHasPermission
    | OperationNowMillis
    | OperationNow
    | OperationClockFormat
    | OperationClockAdd
    | OperationFrontmatter
    | OperationNotesAll
    | OperationNotesGet
    | OperationStorageRead
    | OperationStorageList
    | OperationStorageWrite
    | OperationStorageDelete
    | OperationToolAvailable
    | OperationToolRun;
  export interface OperationLog {
    tag: 'log';
    val: LogRequest;
  }
  export interface OperationUuid {
    tag: 'uuid';
  }
  export interface OperationRandomBytes {
    tag: 'random-bytes';
    val: number;
  }
  export interface OperationHasPermission {
    tag: 'has-permission';
    val: TextInput;
  }
  export interface OperationNowMillis {
    tag: 'now-millis';
  }
  export interface OperationNow {
    tag: 'now';
  }
  export interface OperationClockFormat {
    tag: 'clock-format';
    val: FormatRequest;
  }
  export interface OperationClockAdd {
    tag: 'clock-add';
    val: AddRequest;
  }
  export interface OperationFrontmatter {
    tag: 'frontmatter';
    val: TextInput;
  }
  export interface OperationNotesAll {
    tag: 'notes-all';
  }
  export interface OperationNotesGet {
    tag: 'notes-get';
    val: TextInput;
  }
  export interface OperationStorageRead {
    tag: 'storage-read';
    val: TextInput;
  }
  export interface OperationStorageList {
    tag: 'storage-list';
    val: TextInput;
  }
  export interface OperationStorageWrite {
    tag: 'storage-write';
    val: WriteRequest;
  }
  export interface OperationStorageDelete {
    tag: 'storage-delete';
    val: TextInput;
  }
  export interface OperationToolAvailable {
    tag: 'tool-available';
    val: TextInput;
  }
  export interface OperationToolRun {
    tag: 'tool-run';
    val: ToolRequest;
  }
  /**
   * Only kept results cross back to the guest. All results remain available
   * to backward references until this execute call ends.
   */
  export interface Command {
    operation: Operation;
    keep: boolean;
  }
  export type Value =
    | ValueNone
    | ValueText
    | ValueOptionalText
    | ValueNumber
    | ValueBoolean
    | ValueBytes
    | ValueNotes
    | ValueNote
    | ValueEntries
    | ValueTool;
  export interface ValueNone {
    tag: 'none';
  }
  export interface ValueText {
    tag: 'text';
    val: string;
  }
  export interface ValueOptionalText {
    tag: 'optional-text';
    val: string | null;
  }
  export interface ValueNumber {
    tag: 'number';
    val: number;
  }
  export interface ValueBoolean {
    tag: 'boolean';
    val: boolean;
  }
  export interface ValueBytes {
    tag: 'bytes';
    val: Uint8Array;
  }
  export interface ValueNotes {
    tag: 'notes';
    val: Array<NoteMeta>;
  }
  export interface ValueNote {
    tag: 'note';
    val: NoteMeta | null;
  }
  export interface ValueEntries {
    tag: 'entries';
    val: Array<Entry>;
  }
  export interface ValueTool {
    tag: 'tool';
    val: RunOutput;
  }
  export interface Reply {
    index: number;
    value: Value;
  }
  export interface Failure {
    index: number;
    cause: Error;
  }
}

declare module 'mindstream:plugin/clock@0.1.0' {
  /**
   * Milliseconds since the Unix epoch.
   */
  export function nowMillis(): number;
  /**
   * The current local time as RFC 3339, with the local UTC offset.
   */
  export function now(): string;
  /**
   * Format an RFC 3339 timestamp in local time with moment-style tokens:
   * `YYYY YY MMMM MMM MM M DD D dddd ddd HH H hh h mm m ss s A a` and
   * `[literal]`. `locale` picks month and weekday names. `de...` gives
   * German, anything else English.
   */
  export function format(
    timestamp: string,
    pattern: string,
    locale: string | null
  ): string;
  /**
   * Shift an RFC 3339 timestamp by `amount` units in local time and return
   * RFC 3339. Months and years clamp the day to the target month's length.
   */
  export function add(
    timestamp: string,
    amount: number,
    unit: TimeUnit
  ): string;
  export type Error = import('mindstream:plugin/types@0.1.0').Error;
  /**
   * # Variants
   *
   * ## `"second"`
   *
   * ## `"minute"`
   *
   * ## `"hour"`
   *
   * ## `"day"`
   *
   * ## `"week"`
   *
   * ## `"month"`
   *
   * ## `"year"`
   */
  export type TimeUnit =
    | 'second'
    | 'minute'
    | 'hour'
    | 'day'
    | 'week'
    | 'month'
    | 'year';
}

declare module 'mindstream:plugin/markdown@0.1.0' {
  /**
   * Build a `---` delimited YAML frontmatter block from a JSON object.
   * Keys are written in sorted order. Strings are double-quoted and
   * escaped. Arrays become one `- item` line each. Deeper nesting is
   * written as JSON.
   */
  export function frontmatter(fieldsJson: string): string;
  export type Error = import('mindstream:plugin/types@0.1.0').Error;
}

declare module 'mindstream:plugin/native-tools@0.1.0' {
  /**
   * Whether the tool with this manifest id was found on this device.
   */
  export function available(toolId: string): boolean;
  /**
   * Run the tool and wait for it. Time spent waiting does not count
   * against the plugin's own `timeoutMs`, but the whole call stays under a
   * fixed ceiling.
   */
  export function run(toolId: string, options: RunOptions): RunOutput;
  export type Error = import('mindstream:plugin/types@0.1.0').Error;
  export interface RunOptions {
    /**
     * Passed to the binary as they are.
     */
    args: Array<string>;
    /**
     * Written to the process's stdin.
     */
    stdin: string | null;
    /**
     * Wall-clock cap. The host clamps it to 100..30000 ms and to what is
     * left of the call's budget.
     */
    timeoutMs: number | null;
    /**
     * Set for binary output such as a PDF. `stdout` is then empty and
     * the bytes come back base64-encoded in `stdout-base64`.
     */
    outputBase64: boolean;
  }
  export interface RunOutput {
    /**
     * Exit code, or none when a signal ended the process.
     */
    statusCode: number | null;
    /**
     * Standard output, decoded as UTF-8 with invalid bytes replaced.
     */
    stdout: string;
    stdoutBase64: string | null;
    /**
     * Standard error, decoded as UTF-8 with invalid bytes replaced.
     */
    stderr: string;
    timedOut: boolean;
  }
}

declare module 'mindstream:plugin/notes@0.1.0' {
  /**
   * Every note that is not in the trash.
   */
  export function all(): Array<NoteMeta>;
  /**
   * One note, or none when there is no such note.
   */
  export function get(id: string): NoteMeta | null;
  export type Error = import('mindstream:plugin/types@0.1.0').Error;
  export type NoteMeta = import('mindstream:plugin/types@0.1.0').NoteMeta;
}

declare module 'mindstream:plugin/runtime@0.1.0' {
  /**
   * Write one line to the app log, tagged with the plugin id. The host
   * truncates long lines and drops lines past a per-call cap.
   */
  export function log(level: LogLevel, message: string): void;
  /**
   * A fresh random version 4 UUID.
   */
  export function uuid(): string;
  /**
   * `len` bytes from the host's secure random source. At most 65536 per call.
   */
  export function randomBytes(len: number): Uint8Array;
  /**
   * Whether the user granted `permission`, spelled as in the manifest
   * (`notes.read`, `pluginStorage.write`, ...).
   */
  export function hasPermission(permission: string): boolean;
  /**
   * # Variants
   *
   * ## `"debug"`
   *
   * ## `"info"`
   *
   * ## `"warn"`
   *
   * ## `"error"`
   */
  export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
}

declare module 'mindstream:plugin/storage@0.1.0' {
  /**
   * The file as text, or none when it does not exist. Invalid UTF-8 is
   * replaced, not refused.
   */
  export function read(path: string): string | null;
  /**
   * The entries of a directory, sorted by name. `""` is the root. A
   * directory that does not exist lists as empty.
   */
  export function list(path: string): Array<Entry>;
  /**
   * Write a file, creating parent directories.
   */
  export function write(path: string, contents: string): void;
  /**
   * Remove a file or a whole directory. Removing what is not there succeeds.
   */
  export { _delete as delete };
  function _delete(path: string): void;
  export type Error = import('mindstream:plugin/types@0.1.0').Error;
  export interface Entry {
    name: string;
    isDir: boolean;
    sizeBytes: number;
  }
}

declare module 'mindstream:plugin/types@0.1.0' {
  /**
   * Why a host call refused or failed.
   *
   * A plugin can catch any of these. Running out of time or being cancelled
   * is not an error value: the host stops the guest instead, so a plugin
   * cannot catch the deadline and keep going.
   */
  export type Error =
    | ErrorDenied
    | ErrorInvalid
    | ErrorUnavailable
    | ErrorFailed;
  /**
   * The user did not grant the permission this call needs. The payload
   * names it, e.g. `notes.read`.
   */
  export interface ErrorDenied {
    tag: 'denied';
    val: string;
  }
  /**
   * An argument was malformed or unsafe: a storage path that leaves the
   * plugin's directory, a tool the manifest does not declare, a value
   * over a size limit.
   */
  export interface ErrorInvalid {
    tag: 'invalid';
    val: string;
  }
  /**
   * The thing asked for does not exist on this device: no data
   * directory, or a native tool that is not installed (always the case
   * on mobile).
   */
  export interface ErrorUnavailable {
    tag: 'unavailable';
    val: string;
  }
  /**
   * The host tried and failed, for example an I/O error.
   */
  export interface ErrorFailed {
    tag: 'failed';
    val: string;
  }
  /**
   * Read-only metadata for one note. Never the body.
   */
  export interface NoteMeta {
    id: string;
    title: string;
    tags: Array<string>;
    /**
     * Editor kind: `markdown`, `kanban`, or a plugin-owned
     * `plugin.<plugin-id>.<kind>`.
     */
    kind: string;
    folderId: string | null;
    /**
     * Folder names from the root down, joined with ` / `.
     */
    folderPath: string;
    /**
     * RFC 3339.
     */
    created: string;
    /**
     * RFC 3339.
     */
    modified: string;
  }
}

--!strict
-- Type stubs for the Mindstream scripted-plugin host API (`ms.*`).
--
-- This is the one shared type file every scripted plugin uses — including
-- third-party plugins developed outside this repo. Copy it into your plugin
-- project and point your editor's luau-lsp at it; see docs/plugins.md →
-- "Editor setup & type checking" for the per-editor one-liner. The source of
-- truth for what actually exists at runtime is src-tauri/src/plugins/luau.rs —
-- keep the two in sync when the host API changes.
--
-- It is NOT executed and NOT shipped inside any plugin. In this repo it lives at
-- the plugins/ root — outside every plugin directory — so the package digest a
-- plugin's signature covers never includes it (see
-- src-tauri/src/plugins/signing.rs); luau-lsp loads it via .vscode/settings.json.

-- Read-only metadata for one note, as exposed by `ms.notes` (needs `notes.read`).
type MsNote = {
	id: string,
	title: string,
	tags: { string },
	kind: string, -- editor kind: "markdown", "kanban", …
	folder_id: string?,
	folder_path: string, -- human path of the containing folder, e.g. "Work / Projects"
	created: string, -- RFC3339
	modified: string, -- RFC3339
}

-- Epoch seconds or an RFC3339 string — what the date helpers accept.
type MsDateInput = string | number

type MsDate = {
	-- Current local date/time in moment-style tokens (default "YYYY-MM-DD"),
	-- optionally offset by whole days. `locale` (e.g. "de") localizes month and
	-- weekday names; omitted or unknown → English.
	now: (format: string?, offsetDays: number?, locale: string?) -> string,
	-- Format an RFC3339 string or epoch seconds (default "YYYY-MM-DD"). `locale`
	-- localizes month/weekday names as for `now`.
	format: (input: MsDateInput, format: string?, locale: string?) -> string,
	-- Shift a date and return RFC3339. unit: second|minute|hour|day|week|month|year.
	add: (input: MsDateInput, amount: number, unit: string) -> string,
}

type MsJson = {
	encode: (value: any) -> string,
	decode: (text: string) -> any,
}

type MsMd = {
	-- A `---`-delimited YAML frontmatter block from a table of fields.
	frontmatter: (fields: { [string]: any }) -> string,
}

-- Present only when the plugin was granted `notes.read`.
type MsNotes = {
	all: () -> { MsNote },
	get: (id: string) -> MsNote?,
}

-- Options for `ms.nativeTools.run`.
type MsNativeToolRunOptions = {
	args: { string }?, -- arguments passed directly to the binary (no shell)
	stdin: string?, -- written to the process stdin
	timeoutMs: number?, -- wall-clock cap, clamped by the host (100..30000)
	outputBase64: boolean?, -- true for binary output (PDF/PNG): see stdoutBase64
}

-- Result of `ms.nativeTools.run`.
type MsNativeToolResult = {
	statusCode: number?, -- process exit code (nil if killed by signal)
	stdout: string, -- lossy UTF-8 stdout (empty when outputBase64 was set)
	stdoutBase64: string?, -- base64 of raw stdout bytes, present when outputBase64 was set
	stderr: string,
	timedOut: boolean,
}

-- Present only when the plugin was granted `nativeTools.runDeclared`. Runs the
-- plugin's *declared* PATH binaries (from `contributes.nativeTools`) directly —
-- never a shell. On mobile every tool is unavailable (native tools are
-- desktop-only), so guard with `available` before `run`.
type MsNativeTools = {
	-- Whether a declared tool id was resolved on PATH.
	available: (toolId: string) -> boolean,
	-- Run a declared, available tool. Errors if the tool is unknown/unavailable.
	run: (toolId: string, options: MsNativeToolRunOptions?) -> MsNativeToolResult,
}

-- One entry from `ms.storage.list`.
type MsStorageEntry = {
	name: string,
	isDir: boolean,
	sizeBytes: number,
}

-- Present when the plugin was granted `pluginStorage.read` and/or
-- `pluginStorage.write`. Reads and writes files under the plugin's own isolated
-- data directory: relative paths only, no `..`, no absolute paths. Each function
-- exists only with its matching grant, so narrow before calling — e.g.
-- `local write = assert(storage.write)`.
type MsStorage = {
	-- File contents, or nil when the file does not exist (not an error: "have I
	-- stored this yet?" is the common first call). Needs `pluginStorage.read`.
	read: ((path: string) -> string?)?,
	-- Directory listing, sorted by name. Omit the path to list the root.
	-- Needs `pluginStorage.read`.
	list: ((path: string?) -> { MsStorageEntry })?,
	-- Write a file, creating parent directories. Needs `pluginStorage.write`.
	write: ((path: string, contents: string) -> ())?,
	-- Remove a file or directory tree; deleting what is absent is not an error.
	-- Needs `pluginStorage.write`.
	delete: ((path: string) -> ())?,
}

-- The `ms` host API. Always-present helpers are non-optional; a namespace typed
-- as optional is permission-gated — it exists only when the manifest's
-- `permissions` include the matching capability, so a script must narrow it
-- first (e.g. `local notes = assert(ms.notes)`).
export type Ms = {
	-- Write a tagged line to the app log.
	log: (message: string) -> (),
	-- A fresh v4 UUID.
	uuid: () -> string,
	date: MsDate,
	json: MsJson,
	md: MsMd,
	notes: MsNotes?, -- gated by `notes.read`
	nativeTools: MsNativeTools?, -- gated by `nativeTools.runDeclared`
	storage: MsStorage?, -- gated by `pluginStorage.read` / `pluginStorage.write`
}

declare ms: Ms

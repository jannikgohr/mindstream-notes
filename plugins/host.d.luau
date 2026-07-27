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
}

declare ms: Ms

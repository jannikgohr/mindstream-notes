--!strict
-- Templates plugin — the "New from template" toolbar button.
--
-- The host calls `newFromTemplate(ctx)` when the button is clicked and performs
-- whatever effect this returns. We enumerate the user's markdown notes that
-- live in the configured template folder (at any depth) or carry the configured
-- template tag, and return an `openMenu` effect offering each as a
-- `createNoteFromNote` action — the host copies the chosen note's body
-- (interpolating {{date}}, {{title}}, …) and creates + opens the new note.
--
-- Only declarative data crosses back to the host: this script never writes a
-- note itself. Note metadata comes from `ms.notes` (granted by `notes.read`);
-- the folder tree + this plugin's settings come from `ctx`.
--
-- The `ms` global is typed by plugins/host.d.luau (loaded by luau-lsp); the
-- types below describe just this button's own input and effects.

-- One folder in the vault tree, as passed on `ctx.folders`.
type Folder = { id: string, parentId: string? }

-- What the host hands `newFromTemplate`: this plugin's resolved settings (keyed
-- by the manifest setting ids) and the folder tree.
type Context = {
	settings: { [string]: any }?,
	folders: { Folder }?,
}

-- A single entry of the menu the host opens.
type MenuItem = {
	label: string,
	run: { effect: "createNoteFromNote", sourceNoteId: string },
}

-- What the button returns to the host: either a toast, or a menu to open. The
-- explicit union is what lets both `return` shapes type-check under `--!strict`
-- (without it, Luau pins the return type to whichever branch returns first).
type Effect = { effect: "toast", message: string } | { effect: "openMenu", items: { MenuItem } }

-- The `{{ … }}` macro engine lives in its own module, loaded via the
-- plugin-scoped `require`.
local template = require("./lib/template")

-- What the host passes `renderTemplate`: a note's raw title/body, the "now"
-- moment as RFC3339, and any extra `{{var}}` values.
type RenderInput = {
	title: string?,
	body: string?,
	now: string,
	locale: string?,
	vars: { [string]: any }?,
}

-- True when `folderId` is `targetId` or has it as an ancestor (walks parents,
-- guarding against cycles).
local function isUnder(folderId: string, targetId: string, parentById: { [string]: string? }): boolean
	local current: string? = folderId
	local seen: { [string]: boolean } = {}
	while current ~= nil and not seen[current] do
		if current == targetId then
			return true
		end
		seen[current] = true
		current = parentById[current]
	end
	return false
end

local function blank(value: any): boolean
	return value == nil or value == ""
end

local function newFromTemplate(ctx: Context): Effect
	local settings: { [string]: any } = ctx.settings or {}
	local folderId = settings["source-folder"]
	local tag = settings["source-tag"]
	if blank(folderId) then
		folderId = nil
	end
	if blank(tag) then
		tag = nil
	end

	if folderId == nil and tag == nil then
		return {
			effect = "toast",
			message = "Set a template folder or tag in Settings → Plugins → Templates.",
		}
	end

	-- folder id -> parent id, for "inside the folder at any depth".
	local folders: { Folder } = ctx.folders or {}
	local parentById: { [string]: string? } = {}
	for _, f in ipairs(folders) do
		parentById[f.id] = f.parentId
	end

	-- `ms.notes` is present because the manifest grants `notes.read`.
	local notes = assert(ms.notes, "Templates plugin requires the notes.read permission")

	local items: { MenuItem } = {}
	for _, note in ipairs(notes.all()) do
		if note.kind == "markdown" then
			local matches = false
			if tag ~= nil then
				for _, t in ipairs(note.tags) do
					if t == tag then
						matches = true
						break
					end
				end
			end
			if not matches and folderId ~= nil and note.folder_id ~= nil then
				matches = isUnder(note.folder_id, folderId, parentById)
			end
			if matches then
				items[#items + 1] = {
					label = note.title,
					run = { effect = "createNoteFromNote", sourceNoteId = note.id },
				}
			end
		end
	end

	if #items == 0 then
		return { effect = "toast", message = "No template notes found." }
	end

	table.sort(items, function(a, b)
		return a.label < b.label
	end)
	return { effect = "openMenu", items = items }
end

-- Render a template note's title + body through the `{{…}}` engine. The title is
-- rendered first so the body can reference the final `{{title}}`.
local function renderTemplate(input: RenderInput): { title: string, body: string }
	local vars: { [string]: any } = {}
	if input.vars ~= nil then
		for key, value in pairs(input.vars) do
			vars[key] = value
		end
	end
	local ctx = { now = input.now, vars = vars }
	local title = template.render(input.title or "", ctx)
	vars.title = title
	local body = template.render(input.body or "", ctx)
	return { title = title, body = body }
end

return { newFromTemplate = newFromTemplate, renderTemplate = renderTemplate }

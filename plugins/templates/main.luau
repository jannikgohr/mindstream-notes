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

-- True when `folderId` is `targetId` or has it as an ancestor (walks parents,
-- guarding against cycles).
local function isUnder(folderId, targetId, parentById)
	local current = folderId
	local seen = {}
	while current ~= nil and not seen[current] do
		if current == targetId then
			return true
		end
		seen[current] = true
		current = parentById[current]
	end
	return false
end

local function blank(value)
	return value == nil or value == ""
end

local function newFromTemplate(ctx)
	local settings = ctx.settings or {}
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
	local parentById = {}
	for _, f in ipairs(ctx.folders or {}) do
		parentById[f.id] = f.parentId
	end

	local items = {}
	for _, note in ipairs(ms.notes.all()) do
		if note.kind == "markdown" then
			local matches = false
			if tag ~= nil then
				for _, t in ipairs(note.tags or {}) do
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

return { newFromTemplate = newFromTemplate }

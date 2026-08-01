--!strict
-- Renders plugin-owned Typst document notes by shelling out to the user's
-- installed `typst` binary (declared in the manifest as a native tool). The
-- source is fed on stdin and the compiled SVG comes back on stdout, so nothing
-- ever touches the filesystem. When the binary isn't available (not installed,
-- or a mobile platform where native tools can't run) the host is told to show
-- the editor in source-only mode.

type RenderInput = {
	noteId: string?,
	noteKind: string?,
	body: string?,
	sourceLanguage: string?,
}

type Diagnostic = {
	severity: "info" | "warning" | "error",
	message: string,
}

-- Turn Typst's stderr into a diagnostics list. Typst prefixes lines with
-- `error:` / `warning:`; anything else is folded into the previous entry so a
-- multi-line message stays together.
local function parseTypstStderr(stderr: string): { Diagnostic }
	local diagnostics: { Diagnostic } = {}
	for rawLine in string.gmatch(stderr .. "\n", "([^\n]*)\n") do
		local line = string.gsub(rawLine, "%s+$", "")
		if line == "" then
			continue
		end
		local severity: "info" | "warning" | "error" = "error"
		local message = line
		local errorBody = string.match(line, "^error:%s*(.*)$")
		local warnBody = string.match(line, "^warning:%s*(.*)$")
		if errorBody ~= nil then
			severity = "error"
			message = errorBody
		elseif warnBody ~= nil then
			severity = "warning"
			message = warnBody
		elseif #diagnostics > 0 then
			-- Continuation of the previous diagnostic (context line).
			local prev = diagnostics[#diagnostics]
			prev.message = prev.message .. "\n" .. line
			continue
		end
		diagnostics[#diagnostics + 1] = { severity = severity, message = message }
	end
	return diagnostics
end

local function renderDocument(input: RenderInput): { [string]: any }
	local body = input.body or ""

	local nativeTools = ms.nativeTools
	if nativeTools == nil or not nativeTools.available("typst") then
		-- No native binary → let the host drop to source-only (no preview).
		return { sourceOnly = true, diagnostics = {} }
	end

	local result = nativeTools.run("typst", {
		-- `compile <input> <output>` with `-` on both ends = stdin → stdout.
		args = { "compile", "--format", "svg", "-", "-" },
		stdin = body,
		timeoutMs = 15000,
	})

	if result.timedOut then
		return {
			preview = { mime = "image/svg+xml", text = "" },
			diagnostics = { { severity = "error", message = "Typst timed out while compiling." } },
		}
	end

	if result.statusCode ~= 0 then
		return {
			preview = { mime = "image/svg+xml", text = "" },
			diagnostics = parseTypstStderr(result.stderr),
		}
	end

	return {
		preview = { mime = "image/svg+xml", text = result.stdout },
		diagnostics = parseTypstStderr(result.stderr),
	}
end

return { renderDocument = renderDocument }

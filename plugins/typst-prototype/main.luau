--!strict
-- Prototype renderer for plugin-owned document notes.
--
-- This is intentionally not a Typst compiler yet. It exercises the generic
-- host API shape for source -> sandboxed preview so the real compiler can later
-- replace only this plugin runtime code.

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

local function escapeHtml(value: string): string
	value = string.gsub(value, "&", "&amp;")
	value = string.gsub(value, "<", "&lt;")
	value = string.gsub(value, ">", "&gt;")
	value = string.gsub(value, '"', "&quot;")
	return value
end

local function renderLine(line: string): string
	if string.sub(line, 1, 2) == "= " then
		return "<h1>" .. escapeHtml(string.sub(line, 3)) .. "</h1>"
	end
	if string.sub(line, 1, 3) == "== " then
		return "<h2>" .. escapeHtml(string.sub(line, 4)) .. "</h2>"
	end
	if line == "" then
		return "<div class=\"gap\"></div>"
	end
	local escaped = escapeHtml(line)
	escaped = string.gsub(escaped, "%*([^%*]+)%*", "<strong>%1</strong>")
	escaped = string.gsub(escaped, "_([^_]+)_", "<em>%1</em>")
	return "<p>" .. escaped .. "</p>"
end

local function renderDocument(input: RenderInput): { preview: { mime: string, text: string }, diagnostics: { Diagnostic } }
	local body = input.body or ""
	local diagnostics: { Diagnostic } = {}
	if string.find(body, "#import", 1, true) ~= nil then
		diagnostics[#diagnostics + 1] = {
			severity = "warning",
			message = "Prototype renderer does not resolve imports yet.",
		}
	end

	local out = {
		"<!doctype html><html><head><meta charset=\"utf-8\">",
		"<style>",
		"body{font:15px/1.55 system-ui,sans-serif;margin:0;padding:28px;color:#1f2937;background:#fff}",
		"main{max-width:760px;margin:0 auto}",
		"h1{font-size:30px;line-height:1.15;margin:0 0 18px;color:#111827}",
		"h2{font-size:21px;margin:24px 0 10px;color:#111827}",
		"p{margin:0 0 12px}.gap{height:10px}",
		".badge{font-size:11px;color:#64748b;border-bottom:1px solid #e5e7eb;margin-bottom:22px;padding-bottom:10px}",
		"</style></head><body><main>",
		"<div class=\"badge\">Typst plugin prototype preview</div>",
	}

	for line in string.gmatch(body .. "\n", "([^\n]*)\n") do
		out[#out + 1] = renderLine(line)
	end
	out[#out + 1] = "</main></body></html>"

	return {
		preview = {
			mime = "text/html",
			text = table.concat(out, ""),
		},
		diagnostics = diagnostics,
	}
end

return { renderDocument = renderDocument }

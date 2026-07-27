--!strict
-- The `{{ … }}` template macro engine, implemented in Luau so the Templates
-- plugin owns its templating rather than leaning on a host engine. Pure
-- data-in / string-out; the only host calls are `ms.date` and `ms.uuid`.
--
-- A placeholder is `{{ base [offset] [":" format] [ "|" filter ]* }}`, mirroring
-- the app's declarative helper tier:
--   base    a variable, a date key (date|time|datetime|now), or `uuid`
--   offset  chained date math on a date base: `+7d`, `-1M+2d` (y M w d h m s)
--   format  moment-style tokens for a date base (delegated to ms.date.format)
--   filter  a text transform applied last: upper|lower|trim|capitalize|slug

export type RenderCtx = {
	-- The "now" moment as an RFC3339 string; every date base derives from it.
	now: string,
	-- Named variables a `{{var}}` can resolve (e.g. `title`).
	vars: { [string]: any },
}

local DATE_DEFAULTS: { [string]: string } = {
	date = "YYYY-MM-DD",
	time = "HH:mm",
	datetime = "YYYY-MM-DD HH:mm",
	now = "YYYY-MM-DD HH:mm",
}

-- moment offset unit letter -> ms.date.add unit (note M=month, m=minute).
local UNITS: { [string]: string } = {
	y = "year",
	M = "month",
	w = "week",
	d = "day",
	h = "hour",
	m = "minute",
	s = "second",
}

local function trim(s: string): string
	return (s:gsub("^%s+", ""):gsub("%s+$", ""))
end

local function applyFilter(value: string, name: string): string
	if name == "upper" then
		return value:upper()
	elseif name == "lower" then
		return value:lower()
	elseif name == "trim" then
		return trim(value)
	elseif name == "capitalize" then
		if #value == 0 then
			return value
		end
		return value:sub(1, 1):upper() .. value:sub(2)
	elseif name == "slug" then
		local out = trim(value:lower())
		out = out:gsub("[^a-z0-9]+", "-")
		out = (out:gsub("^%-+", ""):gsub("%-+$", ""))
		return out
	end
	return value -- unknown filter is a no-op
end

-- Split "base[offset][:format][|filter]*" into its parts. Always succeeds; an
-- unparseable expression degrades to a bare base.
local function parseExpr(inner: string): (string, string, string?, { string })
	local segments: { string } = {}
	for seg in (inner .. "|"):gmatch("(.-)|") do
		segments[#segments + 1] = seg
	end
	local valuePart = trim(segments[1] or "")
	local filters: { string } = {}
	for i = 2, #segments do
		local f = trim(segments[i])
		if f ~= "" then
			filters[#filters + 1] = f
		end
	end

	-- The first colon separates base+offset from the (space-bearing) format.
	local colon = valuePart:find(":", 1, true)
	local baseOffset = colon and trim(valuePart:sub(1, colon - 1)) or valuePart
	local format = colon and trim(valuePart:sub(colon + 1)) or nil

	-- Peel trailing signed offset terms off the base, right to left.
	local base = baseOffset
	local offset = ""
	while true do
		local pre, term = base:match("^(.-)([+-]%d+[yMwdhms])$")
		if pre and term then
			base = pre
			offset = term .. offset
		else
			break
		end
	end
	return trim(base), offset, format, filters
end

local function applyOffset(iso: string, offset: string): string
	local result = iso
	for sign, num, unit in offset:gmatch("([+-])(%d+)([yMwdhms])") do
		local amount = tonumber(num) or 0
		if sign == "-" then
			amount = -amount
		end
		result = ms.date.add(result, amount, UNITS[unit])
	end
	return result
end

local function resolveBase(base: string, offset: string, format: string?, ctx: RenderCtx): string
	if base == "uuid" then
		return ms.uuid()
	end
	local dateDefault = DATE_DEFAULTS[base]
	if dateDefault ~= nil then
		local iso = if offset ~= "" then applyOffset(ctx.now, offset) else ctx.now
		return ms.date.format(iso, format or dateDefault)
	end
	local value = ctx.vars[base]
	if value == nil then
		return ""
	end
	return tostring(value)
end

-- Interpolate every `{{ … }}` placeholder in `text`.
local function render(text: string, ctx: RenderCtx): string
	return (text:gsub("{{(.-)}}", function(inner: string): string
		local base, offset, format, filters = parseExpr(inner)
		local value = resolveBase(base, offset, format, ctx)
		for _, name in ipairs(filters) do
			value = applyFilter(value, name)
		end
		return value
	end))
end

return { render = render }
